require("dotenv").config();

const express = require("express");
const bcrypt = require("bcryptjs");
const cookieSession = require("cookie-session");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

const app = express();

const PORT = process.env.PORT || 3000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

/*
|--------------------------------------------------------------------------
| BASIC CONFIGURATION
|--------------------------------------------------------------------------
*/

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

app.use(express.static(__dirname + "/public"));

app.use(
  express.urlencoded({
    extended: true,
    limit: "12mb"
  })
);

app.use(
  express.json({
    limit: "12mb"
  })
);

/*
|--------------------------------------------------------------------------
| SESSION
|--------------------------------------------------------------------------
|
| cookie-session dipakai supaya session tidak membutuhkan database/session
| store tambahan. Hal ini cocok dengan konsep sederhana dan stateless
| untuk deployment Vercel.
|
*/

app.use(
  cookieSession({
    name: "loveforever_session",
    keys: [
      process.env.SESSION_SECRET || "CHANGE_THIS_SESSION_SECRET"
    ],
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  })
);

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function generateId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}

function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(slug);
}

function sanitizeText(value, maxLength = 500) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = 2000) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}

function getGuestName(req) {
  return sanitizeText(req.query.to || "", 100);
}

function isAdmin(req) {
  return Boolean(req.session && req.session.isAdmin === true);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.redirect("/admin/login");
  }

  next();
}

function csrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }

  return req.session.csrfToken;
}

function validateCsrf(req, res, next) {
  const token = req.body._csrf;

  if (
    !token ||
    !req.session.csrfToken ||
    token !== req.session.csrfToken
  ) {
    return res.status(403).send("CSRF validation failed.");
  }

  next();
}

async function getWedding(slug) {
  return await redis.get(`wedding:${slug}`);
}

async function getWeddingSlugs() {
  const weddings = await redis.get("weddings");

  if (!Array.isArray(weddings)) {
    return [];
  }

  return weddings;
}

async function saveWedding(wedding) {
  await redis.set(`wedding:${wedding.slug}`, wedding);

  let slugs = await getWeddingSlugs();

  if (!slugs.includes(wedding.slug)) {
    slugs.push(wedding.slug);
  }

  await redis.set("weddings", slugs);
}

async function removeWedding(slug) {
  await redis.del(`wedding:${slug}`);

  let slugs = await getWeddingSlugs();

  slugs = slugs.filter((item) => item !== slug);

  await redis.set("weddings", slugs);
}

async function getAllWeddings() {
  const slugs = await getWeddingSlugs();

  if (!slugs.length) {
    return [];
  }

  const weddings = [];

  for (const slug of slugs) {
    const wedding = await getWedding(slug);

    if (wedding) {
      weddings.push(wedding);
    }
  }

  return weddings;
}

/*
|--------------------------------------------------------------------------
| RATE LIMITING
|--------------------------------------------------------------------------
*/

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Terlalu banyak percobaan login. Silakan coba lagi nanti."
});

const rsvpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Terlalu banyak pengiriman RSVP. Silakan coba lagi nanti."
});

/*
|--------------------------------------------------------------------------
| DEFAULT WEDDING DATA
|--------------------------------------------------------------------------
*/

function createEmptyWedding({
  slug,
  groomName,
  groomFullName,
  brideName,
  brideFullName,
  weddingDate,
  quote
}) {
  return {
    id: generateId("wedding"),

    slug,

    status: "draft",

    groom: {
      name: sanitizeText(groomName, 100),
      fullName: sanitizeText(groomFullName, 150),
      photo: ""
    },

    bride: {
      name: sanitizeText(brideName, 100),
      fullName: sanitizeText(brideFullName, 150),
      photo: ""
    },

    date: weddingDate || "",

    quote: sanitizeMultiline(quote, 1000),

    description: "",

    events: [],

    story: [],

    gallery: [],

    gift: [],

    music: {
      url: ""
    },

    theme: {
      title: "LOVEFOREVER",
      font: "serif"
    },

    createdAt: nowISO(),

    updatedAt: nowISO()
  };
}

/*
|--------------------------------------------------------------------------
| PUBLIC LANDING PAGE
|--------------------------------------------------------------------------
*/

app.get("/", async (req, res) => {
  try {
    const weddings = await getAllWeddings();

    const published = weddings.filter(
      (wedding) => wedding.status === "published"
    );

    res.render("index", {
      weddings: published
    });
  } catch (error) {
    console.error(error);

    res.status(500).send("Terjadi kesalahan pada server.");
  }
});

/*
|--------------------------------------------------------------------------
| ADMIN LOGIN
|--------------------------------------------------------------------------
*/

app.get("/admin/login", (req, res) => {
  if (isAdmin(req)) {
    return res.redirect("/admin");
  }

  res.render("login", {
    error: null,
    csrfToken: csrfToken(req)
  });
});

app.post(
  "/admin/login",
  loginLimiter,
  validateCsrf,
  async (req, res) => {
    try {
      const username = sanitizeText(req.body.username, 100);
      const password = String(req.body.password || "");

      const configuredUsername =
        process.env.ADMIN_USERNAME || "";

      const passwordHash =
        process.env.ADMIN_PASSWORD_HASH || "";

      if (!configuredUsername || !passwordHash) {
        return res.render("login", {
          error:
            "Admin belum dikonfigurasi. Periksa environment variables.",
          csrfToken: csrfToken(req)
        });
      }

      const usernameCorrect =
        username === configuredUsername;

      const passwordCorrect =
        usernameCorrect &&
        await bcrypt.compare(password, passwordHash);

      if (!usernameCorrect || !passwordCorrect) {
        return res.render("login", {
          error: "Username atau password salah.",
          csrfToken: csrfToken(req)
        });
      }

      req.session.isAdmin = true;
      req.session.username = configuredUsername;

      return res.redirect("/admin");
    } catch (error) {
      console.error(error);

      res.status(500).render("login", {
        error: "Terjadi kesalahan saat login.",
        csrfToken: csrfToken(req)
      });
    }
  }
);

app.post(
  "/admin/logout",
  requireAdmin,
  validateCsrf,
  (req, res) => {
    req.session = null;

    res.redirect("/admin/login");
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN DASHBOARD
|--------------------------------------------------------------------------
*/

app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const weddings = await getAllWeddings();

    const stats = {
      total: weddings.length,
      published: weddings.filter(
        (wedding) => wedding.status === "published"
      ).length,
      draft: weddings.filter(
        (wedding) => wedding.status !== "published"
      ).length
    };

    res.render("admin", {
      weddings,
      stats,
      csrfToken: csrfToken(req),
      message: req.query.message || "",
      error: req.query.error || ""
    });
  } catch (error) {
    console.error(error);

    res.status(500).send("Gagal memuat dashboard.");
  }
});

/*
|--------------------------------------------------------------------------
| CREATE WEDDING FORM
|--------------------------------------------------------------------------
*/

app.get(
  "/admin/wedding/new",
  requireAdmin,
  (req, res) => {
    res.render("admin", {
      weddings: [],
      stats: {
        total: 0,
        published: 0,
        draft: 0
      },
      csrfToken: csrfToken(req),
      message: "",
      error: "",
      createMode: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| CREATE WEDDING
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/new",
  requireAdmin,
  validateCsrf,
  async (req, res) => {
    try {
      const slug = normalizeSlug(req.body.slug);

      if (!isValidSlug(slug)) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Slug tidak valid. Gunakan huruf kecil, angka, dan tanda -."
          )
        );
      }

      const reservedRoutes = [
        "admin",
        "login",
        "health",
        "favicon.ico"
      ];

      if (reservedRoutes.includes(slug)) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Slug tersebut merupakan reserved route."
          )
        );
      }

      const existing = await getWedding(slug);

      if (existing) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Slug sudah digunakan."
          )
        );
      }

      const wedding = createEmptyWedding({
        slug,
        groomName: req.body.groomName,
        groomFullName: req.body.groomFullName,
        brideName: req.body.brideName,
        brideFullName: req.body.brideFullName,
        weddingDate: req.body.weddingDate,
        quote: req.body.quote
      });

      await saveWedding(wedding);

      res.redirect(
        "/admin?message=" +
        encodeURIComponent(
          "Wedding berhasil dibuat."
        )
      );
    } catch (error) {
      console.error(error);

      res.redirect(
        "/admin?error=" +
        encodeURIComponent(
          "Gagal membuat wedding."
        )
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| EDIT WEDDING FORM
|--------------------------------------------------------------------------
*/

app.get(
  "/admin/wedding/:slug/edit",
  requireAdmin,
  async (req, res) => {
    try {
      const slug = normalizeSlug(req.params.slug);

      const wedding = await getWedding(slug);

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      const weddings = await getAllWeddings();

      res.render("admin", {
        weddings,
        stats: {
          total: weddings.length,
          published: weddings.filter(
            (w) => w.status === "published"
          ).length,
          draft: weddings.filter(
            (w) => w.status !== "published"
          ).length
        },
        editWedding: wedding,
        csrfToken: csrfToken(req),
        message: "",
        error: ""
      });
    } catch (error) {
      console.error(error);

      res.status(500).send(
        "Gagal membuka wedding."
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| UPDATE WEDDING
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/:slug/edit",
  requireAdmin,
  validateCsrf,
  async (req, res) => {
    try {
      const oldSlug = normalizeSlug(req.params.slug);
      const newSlug = normalizeSlug(req.body.slug);

      const wedding = await getWedding(oldSlug);

      if (!wedding) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Wedding tidak ditemukan."
          )
        );
      }

      if (!isValidSlug(newSlug)) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Slug tidak valid."
          )
        );
      }

      const reservedRoutes = [
        "admin",
        "login",
        "health",
        "favicon.ico"
      ];

      if (reservedRoutes.includes(newSlug)) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Slug tersebut merupakan reserved route."
          )
        );
      }

      if (newSlug !== oldSlug) {
        const slugExists = await getWedding(newSlug);

        if (slugExists) {
          return res.redirect(
            "/admin?error=" +
            encodeURIComponent(
              "Slug baru sudah digunakan."
            )
          );
        }

        await redis.del(`wedding:${oldSlug}`);

        let slugs = await getWeddingSlugs();

        slugs = slugs.filter(
          (item) => item !== oldSlug
        );

        slugs.push(newSlug);

        await redis.set("weddings", slugs);

        wedding.slug = newSlug;
      }

      wedding.groom = {
        name: sanitizeText(
          req.body.groomName,
          100
        ),
        fullName: sanitizeText(
          req.body.groomFullName,
          150
        ),
        photo: req.body.groomPhoto || ""
      };

      wedding.bride = {
        name: sanitizeText(
          req.body.brideName,
          100
        ),
        fullName: sanitizeText(
          req.body.brideFullName,
          150
        ),
        photo: req.body.bridePhoto || ""
      };

      wedding.date = sanitizeText(
        req.body.weddingDate,
        50
      );

      wedding.quote = sanitizeMultiline(
        req.body.quote,
        1000
      );

      wedding.description =
        sanitizeMultiline(
          req.body.description,
          2000
        );

      wedding.music = {
        url: sanitizeText(
          req.body.musicUrl,
          1000
        )
      };

      wedding.updatedAt = nowISO();

      await saveWedding(wedding);

      res.redirect(
        "/admin?message=" +
        encodeURIComponent(
          "Wedding berhasil diperbarui."
        )
      );
    } catch (error) {
      console.error(error);

      res.redirect(
        "/admin?error=" +
        encodeURIComponent(
          "Gagal memperbarui wedding."
        )
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| DELETE WEDDING
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/:slug/delete",
  requireAdmin,
  validateCsrf,
  async (req, res) => {
    try {
      const slug = normalizeSlug(req.params.slug);

      const wedding = await getWedding(slug);

      if (!wedding) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Wedding tidak ditemukan."
          )
        );
      }

      await removeWedding(slug);

      await redis.del(`rsvp:${slug}`);

      res.redirect(
        "/admin?message=" +
        encodeURIComponent(
          "Wedding berhasil dihapus."
        )
      );
    } catch (error) {
      console.error(error);

      res.redirect(
        "/admin?error=" +
        encodeURIComponent(
          "Gagal menghapus wedding."
        )
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| PUBLISH
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/:slug/publish",
  requireAdmin,
  validateCsrf,
  async (req, res) => {
    try {
      const slug = normalizeSlug(req.params.slug);

      const wedding = await getWedding(slug);

      if (!wedding) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Wedding tidak ditemukan."
          )
        );
      }

      wedding.status = "published";
      wedding.updatedAt = nowISO();

      await saveWedding(wedding);

      res.redirect(
        "/admin?message=" +
        encodeURIComponent(
          "Wedding berhasil dipublish."
        )
      );
    } catch (error) {
      console.error(error);

      res.redirect(
        "/admin?error=" +
        encodeURIComponent(
          "Gagal publish wedding."
        )
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| UNPUBLISH
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/:slug/unpublish",
  requireAdmin,
  validateCsrf,
  async (req, res) => {
    try {
      const slug = normalizeSlug(req.params.slug);

      const wedding = await getWedding(slug);

      if (!wedding) {
        return res.redirect(
          "/admin?error=" +
          encodeURIComponent(
            "Wedding tidak ditemukan."
          )
        );
      }

      wedding.status = "draft";
      wedding.updatedAt = nowISO();

      await saveWedding(wedding);

      res.redirect(
        "/admin?message=" +
        encodeURIComponent(
          "Wedding berhasil di-unpublish."
        )
      );
    } catch (error) {
      console.error(error);

      res.redirect(
        "/admin?error=" +
        encodeURIComponent(
          "Gagal melakukan unpublish."
        )
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| RSVP LIST
|--------------------------------------------------------------------------
*/

app.get(
  "/admin/wedding/:slug/rsvp",
  requireAdmin,
  async (req, res) => {
    try {
      const slug = normalizeSlug(req.params.slug);

      const wedding = await getWedding(slug);

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      const rsvps =
        await redis.get(`rsvp:${slug}`) || [];

      res.render("admin", {
        weddings: await getAllWeddings(),
        stats: {},
        rsvpWedding: wedding,
        rsvps,
        csrfToken: csrfToken(req),
        message: "",
        error: ""
      });
    } catch (error) {
      console.error(error);

      res.status(500).send(
        "Gagal memuat RSVP."
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| PUBLIC RSVP
|--------------------------------------------------------------------------
*/

app.post(
  "/:slug/rsvp",
  rsvpLimiter,
  async (req, res) => {
    try {
      const slug = normalizeSlug(req.params.slug);

      const wedding = await getWedding(slug);

      if (!wedding || wedding.status !== "published") {
        return res.status(404).json({
          success: false,
          message: "Wedding tidak ditemukan."
        });
      }

      const name = sanitizeText(
        req.body.name,
        100
      );

      const attendance =
        sanitizeText(
          req.body.attendance,
          30
        );

      const guestCount =
        Number.parseInt(
          req.body.guestCount,
          10
        );

      const message =
        sanitizeMultiline(
          req.body.message,
          500
        );

      const allowedAttendance = [
        "hadir",
        "tidak_hadir",
        "masih_menentukan"
      ];

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Nama wajib diisi."
        });
      }

      if (
        !allowedAttendance.includes(
          attendance
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "Pilihan kehadiran tidak valid."
        });
      }

      if (
        !Number.isInteger(guestCount) ||
        guestCount < 1 ||
        guestCount > 20
      ) {
        return res.status(400).json({
          success: false,
          message: "Jumlah tamu tidak valid."
        });
      }

      let rsvps =
        await redis.get(`rsvp:${slug}`) || [];

      const rsvp = {
        id: generateId("rsvp"),
        name,
        attendance,
        guestCount,
        message,
        createdAt: nowISO()
      };

      rsvps.unshift(rsvp);

      if (rsvps.length > 5000) {
        rsvps = rsvps.slice(0, 5000);
      }

      await redis.set(
        `rsvp:${slug}`,
        rsvps
      );

      return res.json({
        success: true,
        message:
          "Terima kasih, RSVP Anda telah diterima."
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message:
          "Terjadi kesalahan saat menyimpan RSVP."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| PUBLIC WEDDING
|--------------------------------------------------------------------------
|
| HARUS DILETAKKAN SETELAH ROUTE ADMIN.
|
*/

app.get("/:slug", async (req, res, next) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    const reservedRoutes = [
      "admin",
      "login",
      "health",
      "favicon.ico"
    ];

    if (reservedRoutes.includes(slug)) {
      return next();
    }

    const wedding = await getWedding(slug);

    if (!wedding || wedding.status !== "published") {
      return res.status(404).send(
        "Wedding invitation tidak ditemukan."
      );
    }

    const guestName = getGuestName(req);

    res.render("wedding", {
      wedding,
      guestName
    });
  } catch (error) {
    console.error(error);

    res.status(500).send(
      "Terjadi kesalahan pada invitation."
    );
  }
});

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/health", async (req, res) => {
  try {
    await redis.ping();

    res.json({
      status: "ok",
      redis: "ok",
      timestamp: nowISO()
    });
  } catch (error) {
    console.error(error);

    res.status(503).json({
      status: "error",
      redis: "error",
      timestamp: nowISO()
    });
  }
});

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  res.status(404).send(
    "Halaman tidak ditemukan."
  );
});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
  console.error(error);

  res.status(500).send(
    "Terjadi kesalahan pada server."
  );
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
|
| Vercel membutuhkan export app.
| Local development tetap bisa menggunakan node server.js.
|
*/

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `LOVEFOREVER running on http://localhost:${PORT}`
    );
  });
}

module.exports = app;