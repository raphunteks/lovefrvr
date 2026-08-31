require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { Redis } = require("@upstash/redis");

const app = express();

/* ============================================================
   BASIC CONFIG
============================================================ */

const PORT = process.env.PORT || 3000;

const APP_NAME = "LOVEFOREVER";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "CHANGE_THIS_SESSION_SECRET_IN_PRODUCTION";

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;

/*
 * Vercel request body limit = 4.5 MB.
 *
 * Kita sengaja membuat batas lebih rendah.
 */
const MAX_IMAGE_SIZE = 1.2 * 1024 * 1024;
const MAX_AUDIO_SIZE = 3 * 1024 * 1024;

/* ============================================================
   UPSTASH
============================================================ */

let redis = null;

if (
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

/* ============================================================
   EXPRESS
============================================================ */

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.disable("x-powered-by");

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "7d",
}));

app.use(express.json({
  limit: "1mb",
}));

app.use(express.urlencoded({
  extended: true,
  limit: "1mb",
}));

/* ============================================================
   SECURITY HEADERS
============================================================ */

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

/* ============================================================
   HELPERS
============================================================ */

function nowISO() {
  return new Date().toISOString();
}

function createId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(slug);
}

const RESERVED_SLUGS = new Set([
  "admin",
  "login",
  "logout",
  "health",
  "api",
  "media",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
]);

function isReservedSlug(slug) {
  return RESERVED_SLUGS.has(slug);
}

function cleanText(value, max = 5000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function safeJSONParse(value, fallback = null) {
  try {
    if (typeof value !== "string") {
      return value;
    }

    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getOrigin(req) {
  const forwardedProto =
    req.headers["x-forwarded-proto"];

  const forwardedHost =
    req.headers["x-forwarded-host"];

  const protocol =
    forwardedProto ||
    req.protocol ||
    "https";

  const host =
    forwardedHost ||
    req.get("host");

  return `${protocol}://${host}`;
}

function weddingURL(req, slug) {
  return `${getOrigin(req)}/${encodeURIComponent(slug)}`;
}

function guestURL(req, slug, guest) {
  return `${weddingURL(req, slug)}?to=${encodeURIComponent(
    guest
  )}`;
}

/* ============================================================
   API RESPONSE HELPERS
============================================================ */

function apiSuccess(res, data = {}, status = 200) {
  return res.status(status).json({
    success: true,
    ...data,
  });
}

function apiError(
  res,
  message = "Terjadi kesalahan.",
  status = 500,
  extra = {}
) {
  return res.status(status).json({
    success: false,
    error: message,
    ...extra,
  });
}

/* ============================================================
   COOKIE HELPERS
============================================================ */

function parseCookies(req) {
  const header = req.headers.cookie || "";

  const cookies = {};

  header.split(";").forEach((item) => {
    const index = item.indexOf("=");

    if (index === -1) {
      return;
    }

    const key = item.slice(0, index).trim();

    const value = item
      .slice(index + 1)
      .trim();

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function base64url(value) {
  return Buffer
    .from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(value) {
  let normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (normalized.length % 4) {
    normalized += "=";
  }

  return Buffer
    .from(normalized, "base64")
    .toString();
}

function sign(value) {
  return crypto
    .createHmac(
      "sha256",
      SESSION_SECRET
    )
    .update(value)
    .digest("hex");
}

function createAdminToken() {
  const payload = {
    username: ADMIN_USERNAME,
    createdAt: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const encoded = base64url(
    JSON.stringify(payload)
  );

  const signature = sign(encoded);

  return `${encoded}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token) {
    return false;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const encoded = parts[0];
  const signature = parts[1];

  const expected = sign(encoded);

  try {
    const validSignature =
      crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      );

    if (!validSignature) {
      return false;
    }

    const payload = JSON.parse(
      fromBase64url(encoded)
    );

    if (
      payload.username !==
      ADMIN_USERNAME
    ) {
      return false;
    }

    if (
      Date.now() - payload.createdAt >
      SESSION_MAX_AGE
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function setAdminCookie(res) {
  const token = createAdminToken();

  const cookie = [
    `lf_admin=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=28800",
  ];

  if (process.env.NODE_ENV === "production") {
    cookie.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    cookie.join("; ")
  );
}

function clearAdminCookie(res) {
  const cookie = [
    "lf_admin=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];

  if (process.env.NODE_ENV === "production") {
    cookie.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    cookie.join("; ")
  );
}

/* ============================================================
   ADMIN AUTH
============================================================ */

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req);

  return verifyAdminToken(
    cookies.lf_admin
  );
}

function requireAdminPage(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return res.redirect(
      `/login?redirect=${encodeURIComponent(
        req.originalUrl
      )}`
    );
  }

  next();
}

function requireAdminAPI(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return apiError(
      res,
      "Unauthorized.",
      401
    );
  }

  next();
}

/* ============================================================
   ORIGIN CHECK FOR ADMIN MUTATIONS
============================================================ */

function adminMutationGuard(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return apiError(
      res,
      "Unauthorized.",
      401
    );
  }

  const origin =
    req.headers.origin;

  if (origin) {
    const allowedOrigin =
      getOrigin(req);

    if (
      origin !== allowedOrigin
    ) {
      return apiError(
        res,
        "Origin tidak valid.",
        403
      );
    }
  }

  next();
}

/* ============================================================
   REDIS HELPERS
============================================================ */

function ensureRedis() {
  if (!redis) {
    throw new Error(
      "Upstash Redis belum dikonfigurasi."
    );
  }

  return redis;
}

async function getWedding(slug) {
  const db = ensureRedis();

  const raw = await db.get(
    `wedding:${slug}`
  );

  if (!raw) {
    return null;
  }

  return typeof raw === "string"
    ? safeJSONParse(raw, null)
    : raw;
}

async function saveWedding(wedding) {
  const db = ensureRedis();

  await db.set(
    `wedding:${wedding.slug}`,
    JSON.stringify(wedding)
  );

  await db.sadd(
    "weddings:index",
    wedding.slug
  );

  return wedding;
}

async function deleteWeddingData(wedding) {
  const db = ensureRedis();

  const keys = [
    `wedding:${wedding.slug}`,
    `rsvp:${wedding.slug}`,
  ];

  const assetIds = [];

  if (
    wedding.cover &&
    wedding.cover.assetId
  ) {
    assetIds.push(
      wedding.cover.assetId
    );
  }

  if (
    wedding.bride &&
    wedding.bride.photo &&
    wedding.bride.photo.assetId
  ) {
    assetIds.push(
      wedding.bride.photo.assetId
    );
  }

  if (
    wedding.groom &&
    wedding.groom.photo &&
    wedding.groom.photo.assetId
  ) {
    assetIds.push(
      wedding.groom.photo.assetId
    );
  }

  if (
    wedding.music &&
    wedding.music.assetId
  ) {
    assetIds.push(
      wedding.music.assetId
    );
  }

  if (Array.isArray(wedding.gallery)) {
    wedding.gallery.forEach((item) => {
      if (item.assetId) {
        assetIds.push(item.assetId);
      }
    });
  }

  for (const assetId of assetIds) {
    keys.push(`asset:${assetId}`);
  }

  if (keys.length) {
    await db.del(...keys);
  }

  await db.srem(
    "weddings:index",
    wedding.slug
  );
}

/* ============================================================
   DEFAULT WEDDING
============================================================ */

function createDefaultWedding(slug) {
  const timestamp = nowISO();

  return {
    id: createId("wedding"),

    slug,

    status: "draft",

    createdAt: timestamp,
    updatedAt: timestamp,

    title: "The Wedding Of",

    opening: {
      eyebrow:
        "ASSALAMU'ALAIKUM WARAHMATULLAHI WABARAKATUH",

      title:
        "Dengan penuh kebahagiaan,",

      text:
        "Kami mengundang Bapak/Ibu/Saudara/i untuk hadir dan memberikan doa restu pada hari bahagia kami.",

      button:
        "BUKA UNDANGAN",
    },

    quote: {
      text:
        "Dan di antara tanda-tanda kekuasaan-Nya ialah Dia menciptakan untukmu pasangan hidup dari jenismu sendiri supaya kamu mendapatkan ketenangan hati dan dijadikan-Nya kasih sayang di antara kamu.",
      source:
        "QS. Ar-Rum: 21",
    },

    groom: {
      name: "Nama Mempelai Pria",
      fullName: "",
      parents: "",
      instagram: "",
      photo: null,
    },

    bride: {
      name: "Nama Mempelai Wanita",
      fullName: "",
      parents: "",
      instagram: "",
      photo: null,
    },

    date: "",
    timezone: "Asia/Jakarta",

    story: [],

    events: [
      {
        id: createId("event"),
        title: "Akad Nikah",
        date: "",
        time: "",
        venue: "",
        address: "",
        mapsUrl: "",
      },
      {
        id: createId("event"),
        title: "Resepsi",
        date: "",
        time: "",
        venue: "",
        address: "",
        mapsUrl: "",
      },
    ],

    gallery: [],

    gift: {
      enabled: true,
      title: "Wedding Gift",
      text:
        "Doa restu Anda adalah hadiah terindah bagi kami.",
      bankName: "",
      accountNumber: "",
      accountName: "",
      address: "",
    },

    music: {
      assetId: null,
      title: "",
      autoplay: true,
      loop: true,
    },

    theme: {
      background: "#f7f2eb",
      surface: "#fffdf9",
      text: "#2e2925",
      muted: "#8c837b",
      accent: "#7c6b5d",
      serif:
        "'Cormorant Garamond', Georgia, serif",
      sans:
        "Inter, Arial, sans-serif",
    },

    settings: {
      showOpening: true,
      showCountdown: true,
      showStory: true,
      showGallery: true,
      showGift: true,
      showRSVP: true,
      showMusic: true,
      bottomNavigation: true,
    },
  };
}

/* ============================================================
   NORMALIZE WEDDING
============================================================ */

function normalizeWedding(input, oldWedding = null) {
  const base =
    oldWedding ||
    createDefaultWedding(
      normalizeSlug(input.slug)
    );

  const wedding = {
    ...base,
    ...input,
  };

  wedding.slug =
    normalizeSlug(input.slug);

  wedding.status =
    input.status === "published"
      ? "published"
      : "draft";

  wedding.title =
    cleanText(
      input.title ||
      "The Wedding Of",
      200
    );

  wedding.date =
    cleanText(
      input.date,
      100
    );

  wedding.timezone =
    cleanText(
      input.timezone ||
      "Asia/Jakarta",
      100
    );

  wedding.opening = {
    ...base.opening,
    ...(input.opening || {}),
  };

  wedding.quote = {
    ...base.quote,
    ...(input.quote || {}),
  };

  wedding.bride = {
    ...base.bride,
    ...(input.bride || {}),
  };

  wedding.groom = {
    ...base.groom,
    ...(input.groom || {}),
  };

  wedding.gift = {
    ...base.gift,
    ...(input.gift || {}),
  };

  wedding.music = {
    ...base.music,
    ...(input.music || {}),
  };

  wedding.theme = {
    ...base.theme,
    ...(input.theme || {}),
  };

  wedding.settings = {
    ...base.settings,
    ...(input.settings || {}),
  };

  wedding.story =
    Array.isArray(input.story)
      ? input.story
      : base.story;

  wedding.events =
    Array.isArray(input.events)
      ? input.events
      : base.events;

  wedding.gallery =
    Array.isArray(input.gallery)
      ? input.gallery
      : base.gallery;

  wedding.updatedAt =
    nowISO();

  return wedding;
}

/* ============================================================
   ASSET HELPERS
============================================================ */

function assetPublicURL(req, assetId) {
  if (!assetId) {
    return null;
  }

  return `${getOrigin(req)}/media/${encodeURIComponent(
    assetId
  )}`;
}

function addAssetURL(req, item) {
  if (!item) {
    return null;
  }

  return {
    ...item,
    url: assetPublicURL(
      req,
      item.assetId
    ),
  };
}

function publicWedding(req, wedding) {
  const output = JSON.parse(
    JSON.stringify(wedding)
  );

  if (output.cover) {
    output.cover =
      addAssetURL(
        req,
        output.cover
      );
  }

  if (
    output.bride &&
    output.bride.photo
  ) {
    output.bride.photo =
      addAssetURL(
        req,
        output.bride.photo
      );
  }

  if (
    output.groom &&
    output.groom.photo
  ) {
    output.groom.photo =
      addAssetURL(
        req,
        output.groom.photo
      );
  }

  if (
    output.music &&
    output.music.assetId
  ) {
    output.music.url =
      assetPublicURL(
        req,
        output.music.assetId
      );
  }

  output.gallery =
    Array.isArray(
      output.gallery
    )
      ? output.gallery.map((item) =>
          addAssetURL(req, item)
        )
      : [];

  return output;
}

/* ============================================================
   MULTER
============================================================ */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_AUDIO_SIZE,
    files: 1,
    parts: 3,
  },

  fileFilter(req, file, cb) {
    const allowedImages = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ];

    const allowedAudio = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/ogg",
    ];

    if (
      allowedImages.includes(
        file.mimetype
      )
    ) {
      return cb(null, true);
    }

    if (
      allowedAudio.includes(
        file.mimetype
      )
    ) {
      return cb(null, true);
    }

    return cb(
      new Error(
        "Format file tidak didukung."
      )
    );
  },
});

/* ============================================================
   HEALTH
============================================================ */

app.get("/health", async (req, res) => {
  try {
    if (!redis) {
      return res.status(503).json({
        status: "error",
        redis: false,
      });
    }

    await redis.ping();

    return res.json({
      status: "ok",
      redis: true,
      timestamp: nowISO(),
    });
  } catch (error) {
    return res.status(503).json({
      status: "error",
      redis: false,
      message: "Redis unavailable",
    });
  }
});

/* ============================================================
   LOGIN
============================================================ */

app.get("/login", (req, res) => {
  if (isAdminAuthenticated(req)) {
    return res.redirect("/admin");
  }

  res.render("login", {
    error: null,
    csrfToken: "",
  });
});

app.post("/admin/login", (req, res) => {
  const username =
    cleanText(
      req.body.username,
      150
    );

  const password =
    String(
      req.body.password || ""
    );

  const validUsername =
    username === ADMIN_USERNAME;

  const validPassword =
    password === ADMIN_PASSWORD;

  if (
    !validUsername ||
    !validPassword
  ) {
    return res.status(401).render(
      "login",
      {
        error:
          "Username atau password salah.",
        csrfToken: "",
      }
    );
  }

  setAdminCookie(res);

  return res.redirect("/admin");
});

/* ============================================================
   LOGOUT
============================================================ */

app.post(
  "/admin/logout",
  (req, res) => {
    clearAdminCookie(res);

    if (
      String(
        req.headers.accept || ""
      ).includes("application/json")
    ) {
      return apiSuccess(res);
    }

    return res.redirect("/login");
  }
);

app.get(
  "/admin/logout",
  (req, res) => {
    clearAdminCookie(res);
    return res.redirect("/login");
  }
);

/* ============================================================
   ADMIN PAGE
============================================================ */

app.get(
  "/admin",
  requireAdminPage,
  async (req, res) => {
    try {
      const db = ensureRedis();

      const slugs =
        await db.smembers(
          "weddings:index"
        );

      const weddings = [];

      for (const slug of slugs || []) {
        const wedding =
          await getWedding(slug);

        if (wedding) {
          const rsvpCount =
            await db.llen(
              `rsvp:${slug}`
            );

          weddings.push({
            ...wedding,
            rsvpCount,
            url: weddingURL(
              req,
              slug
            ),
          });
        }
      }

      weddings.sort(
        (a, b) =>
          String(
            b.updatedAt
          ).localeCompare(
            String(a.updatedAt)
          )
      );

      const published =
        weddings.filter(
          (item) =>
            item.status ===
            "published"
        ).length;

      res.render("admin", {
        weddings,
        totalWedding:
          weddings.length,
        published,
        draft:
          weddings.length -
          published,
        origin:
          getOrigin(req),
      });
    } catch (error) {
      console.error(
        "ADMIN ERROR:",
        error
      );

      res.status(500).render(
        "admin",
        {
          weddings: [],
          totalWedding: 0,
          published: 0,
          draft: 0,
          origin:
            getOrigin(req),
          error:
            "Gagal mengambil data dashboard.",
        }
      );
    }
  }
);

/* ============================================================
   ADMIN — LIST WEDDINGS
============================================================ */

app.get(
  "/api/weddings",
  requireAdminAPI,
  async (req, res) => {
    try {
      const db = ensureRedis();

      const slugs =
        await db.smembers(
          "weddings:index"
        );

      const weddings = [];

      for (const slug of slugs || []) {
        const wedding =
          await getWedding(slug);

        if (!wedding) {
          continue;
        }

        const rsvpCount =
          await db.llen(
            `rsvp:${slug}`
          );

        weddings.push({
          ...wedding,
          rsvpCount,
          url: weddingURL(
            req,
            slug
          ),
        });
      }

      return apiSuccess(
        res,
        {
          weddings,
        }
      );
    } catch (error) {
      console.error(
        "LIST ERROR:",
        error
      );

      return apiError(
        res,
        "Gagal mengambil wedding.",
        500
      );
    }
  }
);

/* ============================================================
   ADMIN — GET WEDDING
============================================================ */

app.get(
  "/api/weddings/:slug",
  requireAdminAPI,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return apiError(
          res,
          "Wedding tidak ditemukan.",
          404
        );
      }

      const db = ensureRedis();

      const rsvps =
        await db.lrange(
          `rsvp:${slug}`,
          0,
          -1
        );

      const parsedRSVP =
        (rsvps || [])
          .map((item) =>
            typeof item ===
            "string"
              ? safeJSONParse(
                  item,
                  null
                )
              : item
          )
          .filter(Boolean);

      return apiSuccess(
        res,
        {
          wedding,
          rsvps: parsedRSVP,
          url: weddingURL(
            req,
            slug
          ),
        }
      );
    } catch (error) {
      console.error(
        "GET WEDDING ERROR:",
        error
      );

      return apiError(
        res,
        "Gagal mengambil wedding.",
        500
      );
    }
  }
);

/* ============================================================
   ADMIN — CREATE
============================================================ */

app.post(
  "/api/weddings",
  adminMutationGuard,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.body.slug
        );

      if (!slug) {
        return apiError(
          res,
          "Slug wajib diisi.",
          422
        );
      }

      if (!isValidSlug(slug)) {
        return apiError(
          res,
          "Slug hanya boleh berisi huruf kecil, angka dan tanda -.",
          422
        );
      }

      if (isReservedSlug(slug)) {
        return apiError(
          res,
          "Slug tersebut merupakan reserved route.",
          422
        );
      }

      const existing =
        await getWedding(slug);

      if (existing) {
        return apiError(
          res,
          "Slug sudah digunakan.",
          409
        );
      }

      const wedding =
        normalizeWedding(
          {
            ...req.body,
            slug,
          }
        );

      await saveWedding(
        wedding
      );

      return apiSuccess(
        res,
        {
          message:
            "Wedding berhasil dibuat.",
          wedding,
          url: weddingURL(
            req,
            slug
          ),
        },
        201
      );
    } catch (error) {
      console.error(
        "CREATE WEDDING ERROR:",
        error
      );

      return apiError(
        res,
        "Gagal membuat wedding.",
        500
      );
    }
  }
);

/* ============================================================
   ADMIN — UPDATE
============================================================ */

app.put(
  "/api/weddings/:slug",
  adminMutationGuard,
  async (req, res) => {
    try {
      const oldSlug =
        normalizeSlug(
          req.params.slug
        );

      const current =
        await getWedding(
          oldSlug
        );

      if (!current) {
        return apiError(
          res,
          "Wedding tidak ditemukan.",
          404
        );
      }

      const newSlug =
        normalizeSlug(
          req.body.slug ||
          oldSlug
        );

      if (!isValidSlug(newSlug)) {
        return apiError(
          res,
          "Slug tidak valid.",
          422
        );
      }

      if (
        isReservedSlug(
          newSlug
        )
      ) {
        return apiError(
          res,
          "Slug tersebut merupakan reserved route.",
          422
        );
      }

      if (
        newSlug !== oldSlug
      ) {
        const collision =
          await getWedding(
            newSlug
          );

        if (collision) {
          return apiError(
            res,
            "Slug baru sudah digunakan.",
            409
          );
        }
      }

      const wedding =
        normalizeWedding(
          {
            ...current,
            ...req.body,
            slug: newSlug,
            id: current.id,
            createdAt:
              current.createdAt,
          },
          current
        );

      const db = ensureRedis();

      if (
        newSlug !== oldSlug
      ) {
        await db.set(
          `wedding:${newSlug}`,
          JSON.stringify(
            wedding
          )
        );

        await db.sadd(
          "weddings:index",
          newSlug
        );

        await db.del(
          `wedding:${oldSlug}`
        );

        await db.srem(
          "weddings:index",
          oldSlug
        );

        const oldRSVPKey =
          `rsvp:${oldSlug}`;

        const newRSVPKey =
          `rsvp:${newSlug}`;

        const existingRSVP =
          await db.lrange(
            oldRSVPKey,
            0,
            -1
          );

        if (
          existingRSVP &&
          existingRSVP.length
        ) {
          for (
            const item of existingRSVP
          ) {
            await db.rpush(
              newRSVPKey,
              item
            );
          }

          await db.del(
            oldRSVPKey
          );
        }
      } else {
        await saveWedding(
          wedding
        );
      }

      return apiSuccess(
        res,
        {
          message:
            "Wedding berhasil diperbarui.",
          wedding,
          url: weddingURL(
            req,
            newSlug
          ),
        }
      );
    } catch (error) {
      console.error(
        "UPDATE WEDDING ERROR:",
        error
      );

      return apiError(
        res,
        "Gagal memperbarui wedding.",
        500
      );
    }
  }
);

/* ============================================================
   ADMIN — DELETE
============================================================ */

app.delete(
  "/api/weddings/:slug",
  adminMutationGuard,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return apiError(
          res,
          "Wedding tidak ditemukan.",
          404
        );
      }

      await deleteWeddingData(
        wedding
      );

      return apiSuccess(
        res,
        {
          message:
            "Wedding berhasil dihapus.",
        }
      );
    } catch (error) {
      console.error(
        "DELETE WEDDING ERROR:",
        error
      );

      return apiError(
        res,
        "Gagal menghapus wedding.",
        500
      );
    }
  }
);

/* ============================================================
   ADMIN — PUBLISH / UNPUBLISH
============================================================ */

app.patch(
  "/api/weddings/:slug/status",
  adminMutationGuard,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return apiError(
          res,
          "Wedding tidak ditemukan.",
          404
        );
      }

      const status =
        req.body.status ===
        "published"
          ? "published"
          : "draft";

      wedding.status =
        status;

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      return apiSuccess(
        res,
        {
          message:
            status === "published"
              ? "Wedding berhasil dipublish."
              : "Wedding berhasil dijadikan draft.",
          wedding,
        }
      );
    } catch (error) {
      console.error(
        "STATUS ERROR:",
        error
      );

      return apiError(
        res,
        "Gagal mengubah status.",
        500
      );
    }
  }
);

/* ============================================================
   ADMIN — UPLOAD ASSET
============================================================ */

/*
 * IMPORTANT:
 * Satu request hanya satu file.
 *
 * Admin.ejs akan meng-upload gallery satu per satu.
 * Ini menghindari request terlalu besar.
 */

app.post(
  "/api/weddings/:slug/assets",
  adminMutationGuard,
  upload.single("file"),
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return apiError(
          res,
          "Wedding tidak ditemukan.",
          404
        );
      }

      if (!req.file) {
        return apiError(
          res,
          "File belum dipilih.",
          422
        );
      }

      const isImage =
        req.file.mimetype.startsWith(
          "image/"
        );

      const isAudio =
        req.file.mimetype.startsWith(
          "audio/"
        );

      if (
        isImage &&
        req.file.size >
          MAX_IMAGE_SIZE
      ) {
        return apiError(
          res,
          "Ukuran gambar maksimal 1.2 MB.",
          413
        );
      }

      if (
        isAudio &&
        req.file.size >
          MAX_AUDIO_SIZE
      ) {
        return apiError(
          res,
          "Ukuran MP3/audio maksimal 3 MB.",
          413
        );
      }

      if (
        !isImage &&
        !isAudio
      ) {
        return apiError(
          res,
          "Format file tidak didukung.",
          415
        );
      }

      const assetId =
        createId("asset");

      const asset = {
        assetId,

        weddingSlug:
          slug,

        filename:
          cleanText(
            req.file.originalname,
            200
          ),

        mime:
          req.file.mimetype,

        size:
          req.file.size,

        kind:
          isImage
            ? "image"
            : "audio",

        createdAt:
          nowISO(),

        base64:
          req.file.buffer.toString(
            "base64"
          ),
      };

      const db = ensureRedis();

      await db.set(
        `asset:${assetId}`,
        JSON.stringify(
          asset
        )
      );

      return apiSuccess(
        res,
        {
          message:
            "File berhasil disimpan ke Upstash Redis.",

          asset: {
            assetId,
            filename:
              asset.filename,
            mime:
              asset.mime,
            size:
              asset.size,
            kind:
              asset.kind,
            url:
              assetPublicURL(
                req,
                assetId
              ),
          },
        },
        201
      );
    } catch (error) {
      console.error(
        "UPLOAD ERROR:",
        error
      );

      return apiError(
        res,
        error.message ||
          "Gagal upload file.",
        500
      );
    }
  }
);

/* ============================================================
   ADMIN — DELETE ASSET
============================================================ */

app.delete(
  "/api/assets/:assetId",
  adminMutationGuard,
  async (req, res) => {
    try {
      const assetId =
        cleanText(
          req.params.assetId,
          150
        );

      const db = ensureRedis();

      const exists =
        await db.get(
          `asset:${assetId}`
        );

      if (!exists) {
        return apiError(
          res,
          "Asset tidak ditemukan.",
          404
        );
      }

      await db.del(
        `asset:${assetId}`
      );

      return apiSuccess(
        res,
        {
          message:
            "Asset berhasil dihapus.",
        }
      );
    } catch (error) {
      console.error(
        "DELETE ASSET ERROR:",
        error
      );

      return apiError(
        res,
        "Gagal menghapus asset.",
        500
      );
    }
  }
);

/* ============================================================
   MEDIA DELIVERY
============================================================ */

app.get(
  "/media/:assetId",
  async (req, res) => {
    try {
      const assetId =
        cleanText(
          req.params.assetId,
          150
        );

      const db = ensureRedis();

      const raw =
        await db.get(
          `asset:${assetId}`
        );

      if (!raw) {
        return res.status(404).send(
          "Media tidak ditemukan."
        );
      }

      const asset =
        typeof raw === "string"
          ? safeJSONParse(
              raw,
              null
            )
          : raw;

      if (!asset) {
        return res.status(404).send(
          "Media tidak valid."
        );
      }

      const buffer =
        Buffer.from(
          asset.base64,
          "base64"
        );

      res.setHeader(
        "Content-Type",
        asset.mime
      );

      res.setHeader(
        "Content-Length",
        buffer.length
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=31536000, immutable"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(
          asset.filename
        )}"`
      );

      return res.send(
        buffer
      );
    } catch (error) {
      console.error(
        "MEDIA ERROR:",
        error
      );

      return res.status(500).send(
        "Media gagal diproses."
      );
    }
  }
);

/* ============================================================
   PUBLIC — LANDING PAGE
============================================================ */

app.get(
  "/",
  async (req, res) => {
    try {
      const db = ensureRedis();

      const slugs =
        await db.smembers(
          "weddings:index"
        );

      const weddings = [];

      for (const slug of slugs || []) {
        const wedding =
          await getWedding(slug);

        if (
          wedding &&
          wedding.status ===
            "published"
        ) {
          weddings.push(
            publicWedding(
              req,
              wedding
            )
          );
        }
      }

      weddings.sort(
        (a, b) =>
          String(
            b.updatedAt
          ).localeCompare(
            String(a.updatedAt)
          )
      );

      return res.render(
        "index",
        {
          weddings,
          origin:
            getOrigin(req),
        }
      );
    } catch (error) {
      console.error(
        "LANDING ERROR:",
        error
      );

      return res.render(
        "index",
        {
          weddings: [],
          origin:
            getOrigin(req),
          error:
            "Belum ada wedding yang dipublish.",
        }
      );
    }
  }
);

/* ============================================================
   PUBLIC — RSVP
============================================================ */

app.post(
  "/api/weddings/:slug/rsvp",
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (
        !wedding ||
        wedding.status !==
          "published"
      ) {
        return apiError(
          res,
          "Wedding tidak ditemukan.",
          404
        );
      }

      const name =
        cleanText(
          req.body.name,
          150
        );

      const attendance =
        cleanText(
          req.body.attendance,
          50
        );

      const guestCount =
        Number(
          req.body.guestCount
        );

      const message =
        cleanText(
          req.body.message,
          1000
        );

      const allowedAttendance =
        new Set([
          "hadir",
          "tidak_hadir",
          "tidak_menentukan",
        ]);

      if (!name) {
        return apiError(
          res,
          "Nama wajib diisi.",
          422
        );
      }

      if (
        !allowedAttendance.has(
          attendance
        )
      ) {
        return apiError(
          res,
          "Status kehadiran tidak valid.",
          422
        );
      }

      if (
        !Number.isInteger(
          guestCount
        ) ||
        guestCount < 0 ||
        guestCount > 20
      ) {
        return apiError(
          res,
          "Jumlah tamu tidak valid.",
          422
        );
      }

      const rsvp = {
        id: createId("rsvp"),

        name,

        attendance,

        guestCount,

        message,

        createdAt:
          nowISO(),
      };

      const db = ensureRedis();

      await db.lpush(
        `rsvp:${slug}`,
        JSON.stringify(
          rsvp
        )
      );

      return apiSuccess(
        res,
        {
          message:
            "Terima kasih, RSVP Anda sudah tersimpan.",
        },
        201
      );
    } catch (error) {
      console.error(
        "RSVP ERROR:",
        error
      );

      return apiError(
        res,
        "RSVP gagal disimpan.",
        500
      );
    }
  }
);

/* ============================================================
   PUBLIC — WEDDING
============================================================ */

app.get(
  "/:slug",
  async (req, res, next) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      if (
        RESERVED_SLUGS.has(
          slug
        )
      ) {
        return next();
      }

      const wedding =
        await getWedding(slug);

      if (
        !wedding ||
        wedding.status !==
          "published"
      ) {
        return res.status(404).render(
          "index",
          {
            weddings: [],
            error:
              "Wedding tidak ditemukan atau belum dipublish.",
            origin:
              getOrigin(req),
          }
        );
      }

      let guestName =
        cleanText(
          req.query.to,
          200
        );

      if (!guestName) {
        guestName =
          "Bapak/Ibu/Saudara/i";
      }

      return res.render(
        "wedding",
        {
          wedding:
            publicWedding(
              req,
              wedding
            ),

          guestName,

          origin:
            getOrigin(req),

          weddingUrl:
            weddingURL(
              req,
              slug
            ),
        }
      );
    } catch (error) {
      console.error(
        "WEDDING ERROR:",
        error
      );

      return res.status(500).render(
        "index",
        {
          weddings: [],
          error:
            "Terjadi kesalahan pada undangan.",
          origin:
            getOrigin(req),
        }
      );
    }
  }
);

/* ============================================================
   404
============================================================ */

app.use(
  "/api",
  (req, res) => {
    return apiError(
      res,
      "API endpoint tidak ditemukan.",
      404
    );
  }
);

app.use(
  (req, res) => {
    return res.status(404).render(
      "index",
      {
        weddings: [],
        error:
          "Halaman tidak ditemukan.",
        origin:
          getOrigin(req),
      }
    );
  }
);

/* ============================================================
   GLOBAL ERROR
============================================================ */

app.use(
  (error, req, res, next) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return apiError(
        res,
        error.message ||
          "Server error.",
        error.code ===
          "LIMIT_FILE_SIZE"
          ? 413
          : 500
      );
    }

    return res.status(500).send(
      "Internal Server Error"
    );
  }
);

/* ============================================================
   LOCAL SERVER
============================================================ */

if (
  process.env.NODE_ENV !==
  "production"
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `${APP_NAME} running at http://localhost:${PORT}`
      );
    }
  );
}

/*
 * WAJIB untuk Vercel.
 */
module.exports = app;
