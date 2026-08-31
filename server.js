require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const { Redis } = require("@upstash/redis");

const app = express();

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const SESSION_SECRET = process.env.SESSION_SECRET || "";

const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL || "";

const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || "";

const MAX_BODY_SIZE = "12mb";

const MAX_IMAGE_BYTES = 1024 * 1024;

const MAX_GALLERY_IMAGES = 15;

const MAX_WEDDING_TEXT = 5000;

const RESERVED_SLUGS = [
  "admin",
  "login",
  "health",
  "api",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml"
];

/* =========================================================
   REDIS
========================================================= */

let redis = null;

if (
  UPSTASH_REDIS_REST_URL &&
  UPSTASH_REDIS_REST_TOKEN
) {
  redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN
  });
}

/* =========================================================
   EXPRESS
========================================================= */

app.set("view engine", "ejs");

app.set(
  "views",
  path.join(__dirname, "views")
);

app.use(
  express.json({
    limit: MAX_BODY_SIZE
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: MAX_BODY_SIZE
  })
);

app.use(
  express.static(
    path.join(__dirname, "public"),
    {
      maxAge: process.env.NODE_ENV === "production"
        ? "7d"
        : 0
    }
  )
);

/* =========================================================
   BASIC SECURITY HEADERS
========================================================= */

app.use((req, res, next) => {
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "X-Frame-Options",
    "SAMEORIGIN"
  );

  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );

  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  next();
});

/* =========================================================
   UTILITY
========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function createId(prefix = "id") {
  return (
    prefix +
    "_" +
    Date.now().toString(36) +
    "_" +
    crypto.randomBytes(5).toString("hex")
  );
}

function safeString(
  value,
  maxLength = 1000
) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, maxLength);
}

function normalizeSlug(value) {
  return safeString(value, 100)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isValidSlug(slug) {
  if (!slug) {
    return false;
  }

  if (
    slug.length < 3 ||
    slug.length > 100
  ) {
    return false;
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return false;
  }

  if (RESERVED_SLUGS.includes(slug)) {
    return false;
  }

  return true;
}

function normalizeGuestName(value) {
  return safeString(value, 150);
}

function validAttendance(value) {
  return [
    "hadir",
    "tidak_hadir",
    "masih_menentukan"
  ].includes(value);
}

function parseInteger(
  value,
  fallback = 0
) {
  const n = Number(value);

  if (!Number.isInteger(n)) {
    return fallback;
  }

  return n;
}

function isValidImageMime(mime) {
  return [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ].includes(mime);
}

/* =========================================================
   BASE64 IMAGE VALIDATION
========================================================= */

function validateBase64Image(image) {
  if (!image) {
    return null;
  }

  if (
    typeof image !== "object" ||
    typeof image.data !== "string"
  ) {
    return null;
  }

  const mime = safeString(
    image.mime,
    50
  );

  if (!isValidImageMime(mime)) {
    return null;
  }

  const data = image.data;

  if (!data.startsWith("data:image/")) {
    return null;
  }

  const commaIndex = data.indexOf(",");

  if (commaIndex === -1) {
    return null;
  }

  const base64Part =
    data.substring(commaIndex + 1);

  if (!base64Part) {
    return null;
  }

  const estimatedBytes =
    Math.floor(
      (base64Part.length * 3) / 4
    );

  if (
    estimatedBytes >
    MAX_IMAGE_BYTES
  ) {
    return null;
  }

  return {
    data,
    mime,
    caption: safeString(
      image.caption,
      200
    )
  };
}

/* =========================================================
   DEFAULT WEDDING OBJECT
========================================================= */

function createDefaultWedding() {
  const timestamp = nowISO();

  return {
    id: createId("wedding"),

    slug: "",

    status: "draft",

    groom: {
      name: "",
      fullName: "",
      photo: null
    },

    bride: {
      name: "",
      fullName: "",
      photo: null
    },

    coverImage: null,

    quote: "",

    description: "",

    date: "",

    timezone: "Asia/Makassar",

    events: [],

    story: [],

    gallery: [],

    gift: [],

    music: {
      url: ""
    },

    createdAt: timestamp,

    updatedAt: timestamp
  };
}

/* =========================================================
   REDIS KEY
========================================================= */

function weddingKey(slug) {
  return `wedding:${slug}`;
}

function rsvpKey(slug) {
  return `rsvp:${slug}`;
}

/* =========================================================
   REDIS HELPERS
========================================================= */

async function getWedding(slug) {
  if (!redis) {
    throw new Error(
      "Redis belum dikonfigurasi."
    );
  }

  return await redis.get(
    weddingKey(slug)
  );
}

async function saveWedding(wedding) {
  if (!redis) {
    throw new Error(
      "Redis belum dikonfigurasi."
    );
  }

  await redis.set(
    weddingKey(wedding.slug),
    wedding
  );

  return wedding;
}

async function getWeddingSlugs() {
  if (!redis) {
    throw new Error(
      "Redis belum dikonfigurasi."
    );
  }

  const data =
    await redis.get("weddings");

  if (!Array.isArray(data)) {
    return [];
  }

  return data;
}

async function saveWeddingSlugs(slugs) {
  await redis.set(
    "weddings",
    slugs
  );
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function base64UrlEncode(value) {
  return Buffer
    .from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64UrlDecode(value) {
  try {
    return Buffer
      .from(
        value
          .replace(/-/g, "+")
          .replace(/_/g, "/"),
        "base64"
      )
      .toString("utf8");
  } catch {
    return null;
  }
}

function signValue(value) {
  return crypto
    .createHmac(
      "sha256",
      SESSION_SECRET
    )
    .update(value)
    .digest("hex");
}

function createAdminSession() {
  const payload = {
    username: ADMIN_USERNAME,
    exp:
      Date.now() +
      1000 * 60 * 60 * 8,

    csrf:
      crypto
        .randomBytes(24)
        .toString("hex")
  };

  const encoded =
    base64UrlEncode(
      JSON.stringify(payload)
    );

  const signature =
    signValue(encoded);

  return {
    token:
      `${encoded}.${signature}`,

    csrf: payload.csrf
  };
}

function verifyAdminSession(token) {
  if (!token || !SESSION_SECRET) {
    return null;
  }

  const parts =
    token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const encoded = parts[0];

  const signature = parts[1];

  const expected =
    signValue(encoded);

  const validSignature =
    crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );

  if (!validSignature) {
    return null;
  }

  const decoded =
    base64UrlDecode(encoded);

  if (!decoded) {
    return null;
  }

  let payload;

  try {
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (
    !payload.exp ||
    payload.exp < Date.now()
  ) {
    return null;
  }

  if (
    payload.username !==
    ADMIN_USERNAME
  ) {
    return null;
  }

  return payload;
}

function getSession(req) {
  const cookie =
    req.headers.cookie || "";

  const match =
    cookie.match(
      /(?:^|;\s*)lf_admin=([^;]+)/
    );

  if (!match) {
    return null;
  }

  return verifyAdminSession(
    decodeURIComponent(
      match[1]
    )
  );
}

function requireAdmin(
  req,
  res,
  next
) {
  const session =
    getSession(req);

  if (!session) {
    return res.redirect(
      "/admin/login"
    );
  }

  req.adminSession =
    session;

  next();
}

/* =========================================================
   CSRF
========================================================= */

function verifyCsrf(
  req,
  res
) {
  const session =
    req.adminSession ||
    getSession(req);

  if (!session) {
    return false;
  }

  const token =
    req.body?._csrf ||
    req.headers["x-csrf-token"];

  if (!token) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(String(token)),
    Buffer.from(String(session.csrf))
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (req, res) => {
    try {
      if (!redis) {
        return res.status(500).json({
          status: "error",
          redis: false
        });
      }

      await redis.set(
        "health:lastCheck",
        nowISO()
      );

      return res.json({
        status: "ok",
        redis: true
      });
    } catch (error) {
      console.error(
        "Health check error:",
        error
      );

      return res.status(500).json({
        status: "error",
        redis: false
      });
    }
  }
);

/* =========================================================
   LANDING PAGE
========================================================= */

app.get(
  "/",
  async (req, res) => {
    try {
      const slugs =
        await getWeddingSlugs();

      const weddings = [];

      for (const slug of slugs) {
        const wedding =
          await getWedding(slug);

        if (
          wedding &&
          wedding.status === "published"
        ) {
          weddings.push(wedding);
        }
      }

      return res.render(
        "index",
        {
          weddings
        }
      );
    } catch (error) {
      console.error(
        "Landing error:",
        error
      );

      return res.status(500).send(
        "Terjadi kesalahan server."
      );
    }
  }
);

/* =========================================================
   ADMIN LOGIN PAGE
========================================================= */

app.get(
  "/admin/login",
  (req, res) => {
    const session =
      getSession(req);

    if (session) {
      return res.redirect(
        "/admin"
      );
    }

    return res.render(
      "login",
      {
        error: null,
        csrfToken: ""
      }
    );
  }
);

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/admin/login",
  (req, res) => {
    const username =
      safeString(
        req.body.username,
        100
      );

    const password =
      String(
        req.body.password || ""
      );

    if (
      !ADMIN_USERNAME ||
      !ADMIN_PASSWORD ||
      !SESSION_SECRET
    ) {
      return res.status(500).render(
        "login",
        {
          error:
            "Konfigurasi admin di environment belum lengkap.",
          csrfToken: ""
        }
      );
    }

    if (
      username !==
        ADMIN_USERNAME ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res.status(401).render(
        "login",
        {
          error:
            "Username atau password salah.",
          csrfToken: ""
        }
      );
    }

    const session =
      createAdminSession();

    res.setHeader(
      "Set-Cookie",
      [
        `lf_admin=${encodeURIComponent(
          session.token
        )}`,
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        process.env.NODE_ENV ===
          "production"
          ? "Secure"
          : ""
      ]
        .filter(Boolean)
        .join("; ")
    );

    return res.redirect(
      "/admin"
    );
  }
);

/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/admin/logout",
  requireAdmin,
  (req, res) => {
    if (!verifyCsrf(req, res)) {
      return res.status(403).send(
        "CSRF token tidak valid."
      );
    }

    res.setHeader(
      "Set-Cookie",
      "lf_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
    );

    return res.redirect(
      "/admin/login"
    );
  }
);

/* =========================================================
   ADMIN DASHBOARD
========================================================= */

app.get(
  "/admin",
  requireAdmin,
  async (req, res) => {
    try {
      const slugs =
        await getWeddingSlugs();

      const weddings = [];

      for (const slug of slugs) {
        const wedding =
          await getWedding(slug);

        if (wedding) {
          const rsvps =
            (await redis.get(
              rsvpKey(slug)
            )) || [];

          const stats = {
            total: rsvps.length,

            hadir:
              rsvps.filter(
                x =>
                  x.attendance ===
                  "hadir"
              ).length,

            tidakHadir:
              rsvps.filter(
                x =>
                  x.attendance ===
                  "tidak_hadir"
              ).length,

            belumTentu:
              rsvps.filter(
                x =>
                  x.attendance ===
                  "masih_menentukan"
              ).length,

            guestCount:
              rsvps.reduce(
                (total, item) =>
                  total +
                  Number(
                    item.guestCount ||
                      0
                  ),
                0
              )
          };

          weddings.push({
            ...wedding,
            stats
          });
        }
      }

      return res.render(
        "admin",
        {
          weddings,
          csrfToken:
            req.adminSession.csrf
        }
      );
    } catch (error) {
      console.error(
        "Admin dashboard error:",
        error
      );

      return res.status(500).send(
        "Gagal membuka dashboard."
      );
    }
  }
);

/* =========================================================
   CREATE WEDDING
========================================================= */

app.post(
  "/admin/wedding/new",
  requireAdmin,
  async (req, res) => {
    try {
      if (!verifyCsrf(req, res)) {
        return res.status(403).json({
          success: false,
          message:
            "CSRF token tidak valid."
        });
      }

      const payload =
        req.body;

      const slug =
        normalizeSlug(
          payload.slug
        );

      if (!isValidSlug(slug)) {
        return res.status(400).json({
          success: false,
          message:
            "Slug tidak valid."
        });
      }

      const existing =
        await getWedding(slug);

      if (existing) {
        return res.status(409).json({
          success: false,
          message:
            "Slug sudah digunakan."
        });
      }

      const wedding =
        buildWeddingFromPayload(
          payload
        );

      wedding.slug = slug;

      wedding.id =
        createId("wedding");

      wedding.createdAt =
        nowISO();

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      const slugs =
        await getWeddingSlugs();

      if (!slugs.includes(slug)) {
        slugs.push(slug);

        await saveWeddingSlugs(
          slugs
        );
      }

      return res.json({
        success: true,
        message:
          "Wedding berhasil dibuat.",
        wedding
      });
    } catch (error) {
      console.error(
        "Create wedding error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Gagal membuat wedding."
      });
    }
  }
);

/* =========================================================
   UPDATE WEDDING
========================================================= */

app.post(
  "/admin/wedding/:slug/edit",
  requireAdmin,
  async (req, res) => {
    try {
      if (!verifyCsrf(req, res)) {
        return res.status(403).json({
          success: false,
          message:
            "CSRF token tidak valid."
        });
      }

      const oldSlug =
        normalizeSlug(
          req.params.slug
        );

      const existing =
        await getWedding(
          oldSlug
        );

      if (!existing) {
        return res.status(404).json({
          success: false,
          message:
            "Wedding tidak ditemukan."
        });
      }

      const payload =
        req.body;

      const newSlug =
        normalizeSlug(
          payload.slug
        );

      if (!isValidSlug(newSlug)) {
        return res.status(400).json({
          success: false,
          message:
            "Slug baru tidak valid."
        });
      }

      if (
        newSlug !== oldSlug
      ) {
        const conflict =
          await getWedding(
            newSlug
          );

        if (conflict) {
          return res.status(409).json({
            success: false,
            message:
              "Slug baru sudah digunakan."
          });
        }
      }

      const wedding =
        buildWeddingFromPayload(
          payload
        );

      wedding.id =
        existing.id;

      wedding.slug =
        newSlug;

      wedding.createdAt =
        existing.createdAt ||
        nowISO();

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      if (
        newSlug !== oldSlug
      ) {
        await redis.del(
          weddingKey(
            oldSlug
          )
        );

        const slugs =
          await getWeddingSlugs();

        const index =
          slugs.indexOf(
            oldSlug
          );

        if (index !== -1) {
          slugs[index] =
            newSlug;
        } else if (
          !slugs.includes(
            newSlug
          )
        ) {
          slugs.push(
            newSlug
          );
        }

        await saveWeddingSlugs(
          slugs
        );

        const oldRsvp =
          await redis.get(
            rsvpKey(
              oldSlug
            )
          );

        if (oldRsvp) {
          await redis.set(
            rsvpKey(
              newSlug
            ),
            oldRsvp
          );

          await redis.del(
            rsvpKey(
              oldSlug
            )
          );
        }
      }

      return res.json({
        success: true,
        message:
          "Wedding berhasil diperbarui.",
        wedding
      });
    } catch (error) {
      console.error(
        "Update wedding error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Gagal memperbarui wedding."
      });
    }
  }
);

/* =========================================================
   DELETE WEDDING
========================================================= */

app.post(
  "/admin/wedding/:slug/delete",
  requireAdmin,
  async (req, res) => {
    try {
      if (!verifyCsrf(req, res)) {
        return res.status(403).json({
          success: false,
          message:
            "CSRF token tidak valid."
        });
      }

      const slug =
        normalizeSlug(
          req.params.slug
        );

      const existing =
        await getWedding(
          slug
        );

      if (!existing) {
        return res.status(404).json({
          success: false,
          message:
            "Wedding tidak ditemukan."
        });
      }

      await redis.del(
        weddingKey(slug)
      );

      await redis.del(
        rsvpKey(slug)
      );

      const slugs =
        await getWeddingSlugs();

      const newSlugs =
        slugs.filter(
          item =>
            item !== slug
        );

      await saveWeddingSlugs(
        newSlugs
      );

      return res.json({
        success: true,
        message:
          "Wedding berhasil dihapus."
      });
    } catch (error) {
      console.error(
        "Delete wedding error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Gagal menghapus wedding."
      });
    }
  }
);

/* =========================================================
   PUBLISH
========================================================= */

app.post(
  "/admin/wedding/:slug/publish",
  requireAdmin,
  async (req, res) => {
    try {
      if (!verifyCsrf(req, res)) {
        return res.status(403).json({
          success: false,
          message:
            "CSRF token tidak valid."
        });
      }

      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {
        return res.status(404).json({
          success: false,
          message:
            "Wedding tidak ditemukan."
        });
      }

      wedding.status =
        "published";

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      return res.json({
        success: true,
        message:
          "Wedding dipublish."
      });
    } catch (error) {
      console.error(
        "Publish error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Gagal publish."
      });
    }
  }
);

/* =========================================================
   UNPUBLISH
========================================================= */

app.post(
  "/admin/wedding/:slug/unpublish",
  requireAdmin,
  async (req, res) => {
    try {
      if (!verifyCsrf(req, res)) {
        return res.status(403).json({
          success: false,
          message:
            "CSRF token tidak valid."
        });
      }

      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {
        return res.status(404).json({
          success: false,
          message:
            "Wedding tidak ditemukan."
        });
      }

      wedding.status =
        "draft";

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      return res.json({
        success: true,
        message:
          "Wedding di-unpublish."
      });
    } catch (error) {
      console.error(
        "Unpublish error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Gagal unpublish."
      });
    }
  }
);

/* =========================================================
   ADMIN RSVP
========================================================= */

app.get(
  "/admin/wedding/:slug/rsvp",
  requireAdmin,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      const rsvps =
        (await redis.get(
          rsvpKey(slug)
        )) || [];

      return res.json({
        success: true,
        wedding: {
          slug:
            wedding.slug,
          bride:
            wedding.bride?.name ||
            "",
          groom:
            wedding.groom?.name ||
            ""
        },
        total:
          rsvps.length,
        rsvps
      });
    } catch (error) {
      console.error(
        "RSVP list error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Gagal mengambil RSVP."
      });
    }
  }
);

/* =========================================================
   PUBLIC WEDDING
========================================================= */

app.get(
  "/:slug",
  async (req, res, next) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      if (
        RESERVED_SLUGS.includes(
          slug
        )
      ) {
        return next();
      }

      const wedding =
        await getWedding(
          slug
        );

      if (
        !wedding ||
        wedding.status !==
          "published"
      ) {
        return res.status(404).render(
          "wedding",
          {
            wedding: null,
            guestName: "",
            notFound: true
          }
        );
      }

      const guestName =
        normalizeGuestName(
          req.query.to
        );

      return res.render(
        "wedding",
        {
          wedding,
          guestName,
          notFound: false
        }
      );
    } catch (error) {
      console.error(
        "Wedding route error:",
        error
      );

      return res.status(500).render(
        "wedding",
        {
          wedding: null,
          guestName: "",
          notFound: true
        }
      );
    }
  }
);

/* =========================================================
   RSVP SUBMISSION
========================================================= */

app.post(
  "/:slug/rsvp",
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(
          slug
        );

      if (
        !wedding ||
        wedding.status !==
          "published"
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Wedding tidak ditemukan."
        });
      }

      const name =
        safeString(
          req.body.name,
          100
        );

      const attendance =
        safeString(
          req.body.attendance,
          30
        );

      const guestCount =
        parseInteger(
          req.body.guestCount,
          0
        );

      const message =
        safeString(
          req.body.message,
          500
        );

      if (
        !name ||
        name.length < 2
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Nama wajib diisi."
        });
      }

      if (
        !validAttendance(
          attendance
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Pilihan kehadiran tidak valid."
        });
      }

      if (
        guestCount < 1 ||
        guestCount > 10
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Jumlah tamu harus antara 1-10."
        });
      }

      const rsvp = {
        id:
          createId("rsvp"),

        name,

        attendance,

        guestCount,

        message,

        createdAt:
          nowISO()
      };

      const existing =
        (await redis.get(
          rsvpKey(slug)
        )) || [];

      if (
        !Array.isArray(
          existing
        )
      ) {
        throw new Error(
          "Format RSVP Redis tidak valid."
        );
      }

      existing.unshift(
        rsvp
      );

      if (
        existing.length > 5000
      ) {
        existing.length =
          5000;
      }

      await redis.set(
        rsvpKey(slug),
        existing
      );

      return res.json({
        success: true,
        message:
          "Terima kasih, RSVP Anda telah diterima."
      });
    } catch (error) {
      console.error(
        "RSVP error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "RSVP gagal disimpan."
      });
    }
  }
);

/* =========================================================
   BUILD WEDDING FROM ADMIN PAYLOAD
========================================================= */

function buildWeddingFromPayload(
  payload
) {
  const wedding =
    createDefaultWedding();

  wedding.status =
    payload.status ===
    "published"
      ? "published"
      : "draft";

  wedding.groom = {
    name: safeString(
      payload.groomName,
      100
    ),

    fullName: safeString(
      payload.groomFullName,
      200
    ),

    photo:
      validateBase64Image(
        payload.groomPhoto
      )
  };

  wedding.bride = {
    name: safeString(
      payload.brideName,
      100
    ),

    fullName: safeString(
      payload.brideFullName,
      200
    ),

    photo:
      validateBase64Image(
        payload.bridePhoto
      )
  };

  wedding.coverImage =
    validateBase64Image(
      payload.coverImage
    );

  wedding.quote =
    safeString(
      payload.quote,
      1000
    );

  wedding.description =
    safeString(
      payload.description,
      MAX_WEDDING_TEXT
    );

  wedding.date =
    safeString(
      payload.date,
      100
    );

  wedding.timezone =
    safeString(
      payload.timezone,
      100
    ) ||
    "Asia/Makassar";

  wedding.music = {
    url: safeString(
      payload.musicUrl,
      1000
    )
  };

  /* =======================================================
     EVENTS
  ======================================================= */

  let events = [];

  if (
    Array.isArray(
      payload.events
    )
  ) {
    events =
      payload.events
        .slice(0, 10)
        .map(item => ({
          id:
            safeString(
              item.id,
              100
            ) ||
            createId("event"),

          type:
            safeString(
              item.type,
              50
            ),

          title:
            safeString(
              item.title,
              150
            ),

          date:
            safeString(
              item.date,
              50
            ),

          startTime:
            safeString(
              item.startTime,
              20
            ),

          endTime:
            safeString(
              item.endTime,
              20
            ),

          venue:
            safeString(
              item.venue,
              200
            ),

          address:
            safeString(
              item.address,
              500
            ),

          mapsUrl:
            safeString(
              item.mapsUrl,
              1000
            ),

          description:
            safeString(
              item.description,
              1000
            )
        }))
        .filter(
          item =>
            item.title
        );
  }

  wedding.events =
    events;

  /* =======================================================
     STORY
  ======================================================= */

  let story = [];

  if (
    Array.isArray(
      payload.story
    )
  ) {
    story =
      payload.story
        .slice(0, 20)
        .map(item => ({
          id:
            safeString(
              item.id,
              100
            ) ||
            createId("story"),

          date:
            safeString(
              item.date,
              100
            ),

          title:
            safeString(
              item.title,
              150
            ),

          description:
            safeString(
              item.description,
              1000
            ),

          photo:
            validateBase64Image(
              item.photo
            )
        }))
        .filter(
          item =>
            item.title ||
            item.description
        );
  }

  wedding.story =
    story;

  /* =======================================================
     GALLERY
  ======================================================= */

  let gallery = [];

  if (
    Array.isArray(
      payload.gallery
    )
  ) {
    gallery =
      payload.gallery
        .slice(
          0,
          MAX_GALLERY_IMAGES
        )
        .map(item =>
          validateBase64Image(
            item
          )
        )
        .filter(Boolean);
  }

  wedding.gallery =
    gallery;

  /* =======================================================
     GIFT
  ======================================================= */

  let gift = [];

  if (
    Array.isArray(
      payload.gift
    )
  ) {
    gift =
      payload.gift
        .slice(0, 10)
        .map(item => ({
          id:
            safeString(
              item.id,
              100
            ) ||
            createId("gift"),

          type:
            safeString(
              item.type,
              50
            ),

          bank:
            safeString(
              item.bank,
              100
            ),

          accountName:
            safeString(
              item.accountName,
              150
            ),

          accountNumber:
            safeString(
              item.accountNumber,
              100
            ),

          description:
            safeString(
              item.description,
              500
            )
        }))
        .filter(
          item =>
            item.accountNumber ||
            item.description
        );
  }

  wedding.gift =
    gift;

  return wedding;
}

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).send(
      `
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>404 — LOVEFOREVER</title>
      </head>
      <body style="font-family:Arial,sans-serif;padding:40px;text-align:center">
        <h1>404</h1>
        <p>Halaman yang Anda cari tidak ditemukan.</p>
        <a href="/">Kembali ke LOVEFOREVER</a>
      </body>
      </html>
      `
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Unhandled error:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).send(
      "Terjadi kesalahan pada server."
    );
  }
);

/* =========================================================
   VERCEL EXPORT
========================================================= */

module.exports = app;

/* =========================================================
   LOCAL DEVELOPMENT
========================================================= */

if (
  require.main === module
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `LOVEFOREVER running on port ${PORT}`
      );
    }
  );
}
