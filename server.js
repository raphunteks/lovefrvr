require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

const app = express();

/*
|--------------------------------------------------------------------------
| ENVIRONMENT
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const SESSION_TTL = 60 * 60 * 24; // 24 jam

/*
|--------------------------------------------------------------------------
| VALIDATION ENV
|--------------------------------------------------------------------------
*/

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.warn(
    "WARNING: ADMIN_USERNAME atau ADMIN_PASSWORD belum dikonfigurasi."
  );
}

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.warn(
    "WARNING: Upstash Redis environment variables belum dikonfigurasi."
  );
}

/*
|--------------------------------------------------------------------------
| UPSTASH REDIS
|--------------------------------------------------------------------------
*/

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

/*
|--------------------------------------------------------------------------
| EXPRESS CONFIG
|--------------------------------------------------------------------------
*/

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "7d",
  })
);

/*
|--------------------------------------------------------------------------
| COOKIE HELPERS
|--------------------------------------------------------------------------
*/

function parseCookies(req) {
  const cookies = {};

  const header = req.headers.cookie;

  if (!header) {
    return cookies;
  }

  header.split(";").forEach((cookie) => {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) {
      return;
    }

    const key = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function setCookie(res, name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  setCookie(res, name, "", {
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
}

/*
|--------------------------------------------------------------------------
| SESSION
|--------------------------------------------------------------------------
|
| Session tidak disimpan di MemoryStore.
| Session ID disimpan di cookie.
| Data session disimpan di Upstash Redis.
|
*/

async function createSession() {
  const sessionId = crypto.randomBytes(32).toString("hex");

  const session = {
    authenticated: true,
    username: ADMIN_USERNAME,
    createdAt: Date.now(),
  };

  await redis.set(
    `session:${sessionId}`,
    JSON.stringify(session),
    {
      ex: SESSION_TTL,
    }
  );

  return sessionId;
}

async function getSession(req) {
  try {
    const cookies = parseCookies(req);

    const sessionId = cookies.admin_session;

    if (!sessionId) {
      return null;
    }

    const session = await redis.get(`session:${sessionId}`);

    if (!session) {
      return null;
    }

    if (typeof session === "string") {
      return JSON.parse(session);
    }

    return session;
  } catch (error) {
    console.error("Session error:", error);
    return null;
  }
}

async function destroySession(req) {
  try {
    const cookies = parseCookies(req);

    const sessionId = cookies.admin_session;

    if (sessionId) {
      await redis.del(`session:${sessionId}`);
    }
  } catch (error) {
    console.error("Destroy session error:", error);
  }
}

/*
|--------------------------------------------------------------------------
| AUTHENTICATION
|--------------------------------------------------------------------------
*/

async function requireAdmin(req, res, next) {
  const session = await getSession(req);

  if (!session || !session.authenticated) {
    return res.redirect("/admin/login");
  }

  req.admin = session;

  next();
}

/*
|--------------------------------------------------------------------------
| CSRF
|--------------------------------------------------------------------------
|
| Token dibuat per session dan disimpan di Redis.
|
*/

async function getCsrfToken(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.admin_session;

  if (!sessionId) {
    return null;
  }

  const key = `csrf:${sessionId}`;

  let token = await redis.get(key);

  if (!token) {
    token = crypto.randomBytes(32).toString("hex");

    await redis.set(key, token, {
      ex: SESSION_TTL,
    });
  }

  return token;
}

async function verifyCsrf(req) {
  const cookies = parseCookies(req);

  const sessionId = cookies.admin_session;

  if (!sessionId) {
    return false;
  }

  const submittedToken = req.body._csrf;

  if (!submittedToken) {
    return false;
  }

  const storedToken = await redis.get(`csrf:${sessionId}`);

  if (!storedToken) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(String(submittedToken)),
    Buffer.from(String(storedToken))
  );
}

/*
|--------------------------------------------------------------------------
| SIMPLE LOGIN RATE LIMIT
|--------------------------------------------------------------------------
|
| Mencegah brute-force sederhana.
|
*/

async function loginRateLimit(req, res, next) {
  try {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown";

    const normalizedIp = String(ip)
      .split(",")[0]
      .trim();

    const key = `login-attempt:${normalizedIp}`;

    const attempts = await redis.incr(key);

    if (attempts === 1) {
      await redis.expire(key, 300);
    }

    if (attempts > 10) {
      return res.status(429).render("login", {
        error:
          "Terlalu banyak percobaan login. Silakan coba lagi beberapa menit kemudian.",
        csrfToken: null,
      });
    }

    next();
  } catch (error) {
    console.error("Rate limit error:", error);

    /*
     * Jika Redis bermasalah, jangan langsung memblokir login.
     * Request tetap dilanjutkan.
     */
    next();
  }
}

/*
|--------------------------------------------------------------------------
| PUBLIC ROUTES
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| LANDING PAGE
|--------------------------------------------------------------------------
*/

app.get("/", async (req, res) => {
  try {
    /*
     * Data invitation dapat dikembangkan kemudian.
     * Untuk sementara halaman landing mengambil daftar
     * invitation yang aktif dari Redis.
     */

    const keys = await redis.keys("invitation:*");

    const invitations = [];

    for (const key of keys) {
      const invitation = await redis.get(key);

      if (!invitation) {
        continue;
      }

      if (typeof invitation === "string") {
        invitations.push(JSON.parse(invitation));
      } else {
        invitations.push(invitation);
      }
    }

    res.render("index", {
      invitations,
    });
  } catch (error) {
    console.error("Landing page error:", error);

    res.render("index", {
      invitations: [],
    });
  }
});

/*
|--------------------------------------------------------------------------
| WEDDING INVITATION
|--------------------------------------------------------------------------
|
| Contoh:
|
| /liza-rahmat
|
| dengan query:
|
| ?to=drg.%20A.%20Rifka%20Rahmayanti
|
*/

app.get("/:slug", async (req, res, next) => {
  const slug = req.params.slug;

  /*
   * Jangan menangkap route admin sebagai invitation.
   */
  if (slug === "admin") {
    return next();
  }

  try {
    const invitation = await redis.get(`invitation:${slug}`);

    if (!invitation) {
      return res.status(404).render("404", {
        message: "Undangan tidak ditemukan.",
      });
    }

    const data =
      typeof invitation === "string"
        ? JSON.parse(invitation)
        : invitation;

    const guestName = req.query.to || "";

    /*
     * Query ?to=...
     * hanya digunakan untuk menampilkan nama tamu.
     */

    res.render("invitation", {
      invitation: data,
      guestName,
    });
  } catch (error) {
    console.error("Invitation error:", error);

    return res.status(500).render("404", {
      message: "Terjadi kesalahan pada server.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN LOGIN
|--------------------------------------------------------------------------
*/

app.get("/admin/login", async (req, res) => {
  const session = await getSession(req);

  if (session && session.authenticated) {
    return res.redirect("/admin");
  }

  res.render("login", {
    error: null,
    csrfToken: null,
  });
});

/*
|--------------------------------------------------------------------------
| ADMIN LOGIN POST
|--------------------------------------------------------------------------
*/

app.post("/admin/login", loginRateLimit, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    /*
     * Tidak menggunakan hash.
     * Credential langsung dibandingkan dengan ENV.
     */

    const usernameValid =
      username === String(ADMIN_USERNAME || "");

    const passwordValid =
      password === String(ADMIN_PASSWORD || "");

    if (!usernameValid || !passwordValid) {
      return res.status(401).render("login", {
        error: "Username atau password salah.",
        csrfToken: null,
      });
    }

    /*
     * Buat session baru.
     */

    const sessionId = await createSession();

    /*
     * Buat CSRF token.
     */

    const csrfToken = crypto.randomBytes(32).toString("hex");

    await redis.set(
      `csrf:${sessionId}`,
      csrfToken,
      {
        ex: SESSION_TTL,
      }
    );

    /*
     * Cookie hanya menyimpan session ID.
     * Credential admin TIDAK pernah masuk cookie.
     */

    setCookie(res, "admin_session", sessionId, {
      maxAge: SESSION_TTL,
      secure: process.env.NODE_ENV === "production",
    });

    return res.redirect("/admin");
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).render("login", {
      error: "Terjadi kesalahan server. Silakan coba lagi.",
      csrfToken: null,
    });
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN LOGOUT
|--------------------------------------------------------------------------
*/

app.post("/admin/logout", requireAdmin, async (req, res) => {
  await destroySession(req);

  const cookies = parseCookies(req);

  if (cookies.admin_session) {
    await redis.del(`csrf:${cookies.admin_session}`);
  }

  clearCookie(res, "admin_session");

  res.redirect("/admin/login");
});

/*
|--------------------------------------------------------------------------
| ADMIN DASHBOARD
|--------------------------------------------------------------------------
*/

app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const keys = await redis.keys("invitation:*");

    const invitations = [];

    for (const key of keys) {
      const invitation = await redis.get(key);

      if (!invitation) {
        continue;
      }

      if (typeof invitation === "string") {
        invitations.push(JSON.parse(invitation));
      } else {
        invitations.push(invitation);
      }
    }

    const csrfToken = await getCsrfToken(req);

    res.render("admin", {
      admin: req.admin,
      invitations,
      csrfToken,
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);

    res.status(500).send("Terjadi kesalahan server.");
  }
});

/*
|--------------------------------------------------------------------------
| ADD / CREATE INVITATION
|--------------------------------------------------------------------------
*/

app.get("/admin/addmin", requireAdmin, async (req, res) => {
  const csrfToken = await getCsrfToken(req);

  res.render("addmin", {
    admin: req.admin,
    csrfToken,
    error: null,
  });
});

/*
|--------------------------------------------------------------------------
| CREATE INVITATION
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/invitation/create",
  requireAdmin,
  async (req, res) => {
    try {
      const validCsrf = await verifyCsrf(req);

      if (!validCsrf) {
        return res.status(403).send("CSRF token tidak valid.");
      }

      const {
        slug,
        groomName,
        brideName,
        weddingDate,
        weddingTime,
        venue,
        address,
      } = req.body;

      const cleanSlug = String(slug || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      if (!cleanSlug) {
        const csrfToken = await getCsrfToken(req);

        return res.status(400).render("addmin", {
          admin: req.admin,
          csrfToken,
          error: "Slug invitation wajib diisi.",
        });
      }

      /*
       * Cek apakah slug sudah digunakan.
       */

      const existing = await redis.get(
        `invitation:${cleanSlug}`
      );

      if (existing) {
        const csrfToken = await getCsrfToken(req);

        return res.status(409).render("addmin", {
          admin: req.admin,
          csrfToken,
          error: "Slug tersebut sudah digunakan.",
        });
      }

      const invitation = {
        slug: cleanSlug,

        groomName: String(groomName || "").trim(),
        brideName: String(brideName || "").trim(),

        weddingDate: String(weddingDate || "").trim(),
        weddingTime: String(weddingTime || "").trim(),

        venue: String(venue || "").trim(),
        address: String(address || "").trim(),

        createdAt: Date.now(),
        updatedAt: Date.now(),

        active: true,
      };

      await redis.set(
        `invitation:${cleanSlug}`,
        JSON.stringify(invitation)
      );

      return res.redirect("/admin");
    } catch (error) {
      console.error("Create invitation error:", error);

      res.status(500).send(
        "Terjadi kesalahan saat membuat invitation."
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| DELETE INVITATION
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/invitation/delete",
  requireAdmin,
  async (req, res) => {
    try {
      const validCsrf = await verifyCsrf(req);

      if (!validCsrf) {
        return res.status(403).send("CSRF token tidak valid.");
      }

      const slug = String(req.body.slug || "").trim();

      if (!slug) {
        return res.redirect("/admin");
      }

      await redis.del(`invitation:${slug}`);

      return res.redirect("/admin");
    } catch (error) {
      console.error("Delete invitation error:", error);

      res.status(500).send(
        "Terjadi kesalahan saat menghapus invitation."
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  res.status(404).render("404", {
    message: "Halaman tidak ditemukan.",
  });
});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);

  res.status(500).send(
    "Terjadi kesalahan internal pada server."
  );
});

/*
|--------------------------------------------------------------------------
| LOCAL DEVELOPMENT
|--------------------------------------------------------------------------
|
| Vercel akan menggunakan module.exports.
| Local development tetap bisa menggunakan:
|
| npm start
|
*/

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `LOVEFOREVER berjalan di http://localhost:${PORT}`
    );
  });
}

module.exports = app;
