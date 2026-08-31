require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { Redis } = require("@upstash/redis");

const app = express();

/* =========================================================
   BASIC CONFIGURATION
========================================================= */

const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const COOKIE_NAME = "loveforever_session";

const BASE_URL =
  process.env.BASE_URL ||
  "https://loveforever.vercel.app";


/* =========================================================
   REDIS
========================================================= */

let redis = null;

if (
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  });
}


/* =========================================================
   EXPRESS
========================================================= */

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb"
  })
);

app.use(
  express.json({
    limit: "20mb"
  })
);

app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1d"
  })
);


/* =========================================================
   MULTER
   MEMORY STORAGE
   FILE -> BUFFER -> BASE64 -> REDIS
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    /*
      Sesuaikan dengan kebutuhan.
      Karena file disimpan sebagai Base64 di Redis,
      jangan terlalu besar.
    */

    fileSize: 8 * 1024 * 1024,

    files: 20
  },

  fileFilter: (req, file, cb) => {
    const allowedImages = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    const allowedAudio = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/ogg",
      "audio/mp4",
      "audio/x-m4a"
    ];

    if (
      allowedImages.includes(file.mimetype) ||
      allowedAudio.includes(file.mimetype)
    ) {
      return cb(null, true);
    }

    return cb(
      new Error(
        `Format file tidak didukung: ${file.originalname}`
      )
    );
  }
});


/* =========================================================
   HELPERS
========================================================= */

function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto
    .randomBytes(6)
    .toString("hex")}`;
}


function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase();
}


function isValidSlug(slug) {
  return /^[a-z0-9-]{3,100}$/.test(slug);
}


function isReservedSlug(slug) {
  const reserved = [
    "admin",
    "login",
    "logout",
    "health",
    "api",
    "favicon.ico",
    "robots.txt"
  ];

  return reserved.includes(slug);
}


function sanitizeGuestName(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 200);
}


function safeString(value, max = 5000) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().slice(0, max);
}


function parseJSON(value, fallback = []) {
  if (!value) {
    return fallback;
  }

  if (Array.isArray(value) || typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}


function fileToBase64(file) {
  if (!file || !file.buffer) {
    return null;
  }

  return {
    name: file.originalname,
    type: file.mimetype,
    size: file.size,
    data: `data:${file.mimetype};base64,${file.buffer.toString(
      "base64"
    )}`
  };
}


function getCookie(req, name) {
  const header = req.headers.cookie;

  if (!header) {
    return null;
  }

  const cookies = {};

  header.split(";").forEach((part) => {
    const index = part.indexOf("=");

    if (index === -1) {
      return;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[key] = decodeURIComponent(value);
  });

  return cookies[name] || null;
}


function signValue(value) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("hex");
}


function createSessionToken() {
  const random = crypto.randomBytes(32).toString("hex");

  return `${random}.${signValue(random)}`;
}


function verifySessionToken(token) {
  if (!token || !token.includes(".")) {
    return false;
  }

  const [random, signature] = token.split(".");

  if (!random || !signature) {
    return false;
  }

  const expected = signValue(random);

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}


function setSessionCookie(res, token) {
  const isProduction = process.env.NODE_ENV === "production";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(
      token
    )}; Path=/; HttpOnly; SameSite=Lax${
      isProduction ? "; Secure" : ""
    }`
  );
}


function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
      process.env.NODE_ENV === "production"
        ? "; Secure"
        : ""
    }`
  );
}


/* =========================================================
   REDIS HELPERS
========================================================= */

async function getWedding(slug) {
  if (!redis) {
    throw new Error(
      "Upstash Redis belum dikonfigurasi."
    );
  }

  return await redis.get(`wedding:${slug}`);
}


async function saveWedding(wedding) {
  if (!redis) {
    throw new Error(
      "Upstash Redis belum dikonfigurasi."
    );
  }

  await redis.set(
    `wedding:${wedding.slug}`,
    wedding
  );

  return wedding;
}


async function deleteWedding(slug) {
  if (!redis) {
    throw new Error(
      "Upstash Redis belum dikonfigurasi."
    );
  }

  await redis.del(`wedding:${slug}`);
}


async function getWeddingSlugs() {
  if (!redis) {
    return [];
  }

  const keys = await redis.keys("wedding:*");

  return keys
    .map((key) => key.replace("wedding:", ""))
    .filter(Boolean);
}


async function getAllWeddings() {
  const slugs = await getWeddingSlugs();

  const weddings = [];

  for (const slug of slugs) {
    const wedding = await getWedding(slug);

    if (wedding) {
      weddings.push(wedding);
    }
  }

  weddings.sort((a, b) => {
    return (
      new Date(b.updatedAt || 0) -
      new Date(a.updatedAt || 0)
    );
  });

  return weddings;
}


/* =========================================================
   SESSION
========================================================= */

async function createAdminSession() {
  if (!redis) {
    throw new Error(
      "Upstash Redis belum dikonfigurasi."
    );
  }

  const token = createSessionToken();

  await redis.set(
    `session:${token}`,
    {
      username: ADMIN_USERNAME,
      createdAt: new Date().toISOString()
    },
    {
      ex: 60 * 60 * 24
    }
  );

  return token;
}


async function getAdminSession(req) {
  const token = getCookie(req, COOKIE_NAME);

  if (!verifySessionToken(token)) {
    return null;
  }

  if (!redis) {
    return null;
  }

  return await redis.get(`session:${token}`);
}


async function destroyAdminSession(req) {
  const token = getCookie(req, COOKIE_NAME);

  if (!token || !redis) {
    return;
  }

  await redis.del(`session:${token}`);
}


/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function requireAdmin(req, res, next) {
  try {
    const session = await getAdminSession(req);

    if (!session) {
      return res.redirect("/login");
    }

    req.admin = session;

    next();
  } catch (error) {
    console.error("AUTH ERROR:", error);

    return res.status(500).send(
      "Terjadi kesalahan autentikasi."
    );
  }
}


/* =========================================================
   CSRF
========================================================= */

async function createCsrfToken(req) {
  const sessionToken = getCookie(
    req,
    COOKIE_NAME
  );

  if (!sessionToken || !redis) {
    return "";
  }

  const token = crypto
    .randomBytes(32)
    .toString("hex");

  await redis.set(
    `csrf:${sessionToken}`,
    token,
    {
      ex: 60 * 60 * 24
    }
  );

  return token;
}


async function verifyCsrfToken(req) {
  const sessionToken = getCookie(
    req,
    COOKIE_NAME
  );

  const submitted =
    req.body?._csrf ||
    req.headers["x-csrf-token"];

  if (!sessionToken || !submitted || !redis) {
    return false;
  }

  const stored = await redis.get(
    `csrf:${sessionToken}`
  );

  if (!stored) {
    return false;
  }

  return (
    String(stored) ===
    String(submitted)
  );
}


async function requireCsrf(req, res, next) {
  try {
    const valid = await verifyCsrfToken(req);

    if (!valid) {
      return res.status(403).send(
        "CSRF token tidak valid."
      );
    }

    next();
  } catch (error) {
    console.error("CSRF ERROR:", error);

    return res.status(403).send(
      "CSRF validation gagal."
    );
  }
}


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", async (req, res) => {
  let redisStatus = "not-configured";

  if (redis) {
    try {
      await redis.ping();
      redisStatus = "ok";
    } catch {
      redisStatus = "error";
    }
  }

  res.json({
    status: "ok",
    application: "LOVEFOREVER",
    redis: redisStatus,
    time: new Date().toISOString()
  });
});


/* =========================================================
   LANDING PAGE
========================================================= */

app.get("/", async (req, res) => {
  try {
    const weddings = await getAllWeddings();

    const publishedWeddings =
      weddings.filter(
        (wedding) =>
          wedding.status === "published"
      );

    return res.render("index", {
      weddings: publishedWeddings,
      baseUrl: BASE_URL
    });
  } catch (error) {
    console.error("LANDING ERROR:", error);

    return res.render("index", {
      weddings: [],
      baseUrl: BASE_URL,
      error:
        "Data wedding belum dapat dimuat."
    });
  }
});


/* =========================================================
   LOGIN PAGE
========================================================= */

app.get("/login", async (req, res) => {
  const session = await getAdminSession(req);

  if (session) {
    return res.redirect("/admin");
  }

  return res.render("login", {
    error: null,
    csrfToken: ""
  });
});


/* =========================================================
   LOGIN
========================================================= */

app.post("/admin/login", async (req, res) => {
  try {
    const username = safeString(
      req.body.username,
      200
    );

    const password = safeString(
      req.body.password,
      500
    );

    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      return res.status(500).render(
        "login",
        {
          error:
            "ADMIN_USERNAME dan ADMIN_PASSWORD belum dikonfigurasi di Environment Variables.",
          csrfToken: ""
        }
      );
    }

    /*
      Sesuai keputusan kita:
      ADMIN_USERNAME + ADMIN_PASSWORD
      TANPA HASH PASSWORD.
    */

    const usernameValid =
      username === ADMIN_USERNAME;

    const passwordValid =
      password === ADMIN_PASSWORD;

    if (!usernameValid || !passwordValid) {
      return res.status(401).render(
        "login",
        {
          error:
            "Username atau password salah.",
          csrfToken: ""
        }
      );
    }

    const sessionToken =
      await createAdminSession();

    setSessionCookie(
      res,
      sessionToken
    );

    return res.redirect("/admin");
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return res.status(500).render(
      "login",
      {
        error:
          "Login gagal. Silakan coba lagi.",
        csrfToken: ""
      }
    );
  }
});


/* =========================================================
   LOGOUT
========================================================= */

app.post(
  "/admin/logout",
  requireAdmin,
  async (req, res) => {
    try {
      await destroyAdminSession(req);

      clearSessionCookie(res);

      return res.redirect("/login");
    } catch (error) {
      console.error("LOGOUT ERROR:", error);

      clearSessionCookie(res);

      return res.redirect("/login");
    }
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
      const weddings =
        await getAllWeddings();

      const published =
        weddings.filter(
          (w) =>
            w.status === "published"
        ).length;

      const draft =
        weddings.filter(
          (w) =>
            w.status !== "published"
        ).length;

      let totalRsvp = 0;

      weddings.forEach((wedding) => {
        if (
          Array.isArray(wedding.rsvps)
        ) {
          totalRsvp +=
            wedding.rsvps.length;
        }
      });

      const csrfToken =
        await createCsrfToken(req);

      return res.render(
        "admin",
        {
          weddings,
          wedding: null,

          stats: {
            total: weddings.length,
            published,
            draft,
            totalRsvp
          },

          csrfToken,
          baseUrl: BASE_URL,
          error: null,
          success: null
        }
      );
    } catch (error) {
      console.error(
        "ADMIN DASHBOARD ERROR:",
        error
      );

      return res.status(500).render(
        "admin",
        {
          weddings: [],
          wedding: null,

          stats: {
            total: 0,
            published: 0,
            draft: 0,
            totalRsvp: 0
          },

          csrfToken: "",
          baseUrl: BASE_URL,

          error:
            "Dashboard gagal dimuat.",
          success: null
        }
      );
    }
  }
);


/* =========================================================
   ADMIN EDIT WEDDING
   FIX FOR:
   GET /admin/wedding/:slug -> 404
========================================================= */

app.get(
  "/admin/wedding/:slug",
  requireAdmin,
  async (req, res) => {
    try {
      const slug = normalizeSlug(
        req.params.slug
      );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return res.status(404).render(
          "admin",
          {
            weddings:
              await getAllWeddings(),

            wedding: null,

            stats: {
              total: 0,
              published: 0,
              draft: 0,
              totalRsvp: 0
            },

            csrfToken:
              await createCsrfToken(req),

            baseUrl: BASE_URL,

            error:
              `Wedding dengan slug "${slug}" tidak ditemukan.`,

            success: null
          }
        );
      }

      const weddings =
        await getAllWeddings();

      const published =
        weddings.filter(
          (w) =>
            w.status === "published"
        ).length;

      const draft =
        weddings.filter(
          (w) =>
            w.status !== "published"
        ).length;

      let totalRsvp = 0;

      weddings.forEach((w) => {
        totalRsvp += Array.isArray(w.rsvps)
          ? w.rsvps.length
          : 0;
      });

      return res.render(
        "admin",
        {
          weddings,
          wedding,

          stats: {
            total: weddings.length,
            published,
            draft,
            totalRsvp
          },

          csrfToken:
            await createCsrfToken(req),

          baseUrl: BASE_URL,

          error: null,
          success: null
        }
      );
    } catch (error) {
      console.error(
        "ADMIN EDIT ERROR:",
        error
      );

      return res.status(500).send(
        "Gagal membuka wedding."
      );
    }
  }
);


/* =========================================================
   CREATE / UPDATE WEDDING
   MULTIPART UPLOAD
========================================================= */

app.post(
  "/admin/wedding/save",
  requireAdmin,
  requireCsrf,
  upload.fields([
    {
      name: "coverImage",
      maxCount: 1
    },
    {
      name: "groomImage",
      maxCount: 1
    },
    {
      name: "brideImage",
      maxCount: 1
    },
    {
      name: "musicFile",
      maxCount: 1
    },
    {
      name: "galleryImages",
      maxCount: 20
    }
  ]),
  async (req, res) => {
    try {
      const body = req.body;

      let slug =
        normalizeSlug(body.slug);

      if (!slug) {
        return res.status(400).send(
          "Slug wajib diisi."
        );
      }

      if (!isValidSlug(slug)) {
        return res.status(400).send(
          "Slug hanya boleh menggunakan huruf kecil, angka dan tanda -."
        );
      }

      if (isReservedSlug(slug)) {
        return res.status(400).send(
          "Slug tersebut merupakan reserved route."
        );
      }

      const originalSlug =
        normalizeSlug(
          body.originalSlug
        );

      /*
        Jika edit dan slug berubah,
        hapus data lama setelah data baru berhasil.
      */

      let wedding = null;

      if (originalSlug) {
        wedding =
          await getWedding(
            originalSlug
          );
      }

      if (!wedding) {
        wedding =
          await getWedding(slug);
      }

      const isNew = !wedding;

      if (
        isNew &&
        (await getWedding(slug))
      ) {
        return res.status(409).send(
          "Slug sudah digunakan."
        );
      }

      /*
        Jika rename slug:
        pastikan slug baru belum digunakan.
      */

      if (
        wedding &&
        originalSlug &&
        originalSlug !== slug
      ) {
        const existing =
          await getWedding(slug);

        if (existing) {
          return res.status(409).send(
            "Slug baru sudah digunakan oleh wedding lain."
          );
        }
      }


      /* =====================================================
         EXISTING DATA
      ===================================================== */

      const old =
        wedding || {};


      /* =====================================================
         MEDIA
      ===================================================== */

      const files =
        req.files || {};

      const coverFile =
        files.coverImage?.[0];

      const groomFile =
        files.groomImage?.[0];

      const brideFile =
        files.brideImage?.[0];

      const musicFile =
        files.musicFile?.[0];

      const galleryFiles =
        files.galleryImages || [];


      const coverImage =
        coverFile
          ? fileToBase64(coverFile)
          : old.coverImage || null;

      const groomImage =
        groomFile
          ? fileToBase64(groomFile)
          : old.groomImage || null;

      const brideImage =
        brideFile
          ? fileToBase64(brideFile)
          : old.brideImage || null;

      const music =
        musicFile
          ? fileToBase64(musicFile)
          : old.music || null;


      let gallery =
        Array.isArray(old.gallery)
          ? old.gallery
          : [];

      /*
        Jika Admin mengirim gallery baru,
        tambahkan ke gallery lama.

        Jangan langsung menghapus gallery
        lama agar edit tidak merusak data.
      */

      if (galleryFiles.length > 0) {
        const newGallery =
          galleryFiles
            .map(fileToBase64)
            .filter(Boolean);

        gallery = [
          ...gallery,
          ...newGallery
        ];
      }


      /* =====================================================
         WEDDING DATA
      ===================================================== */

      const updatedWedding = {
        ...old,

        id:
          old.id ||
          generateId("wedding"),

        slug,

        status:
          body.status === "published"
            ? "published"
            : "draft",

        createdAt:
          old.createdAt ||
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString(),


        /* ---------------------------------------------
           BASIC
        --------------------------------------------- */

        title:
          safeString(
            body.title,
            300
          ),

        quote:
          safeString(
            body.quote,
            1000
          ),

        openingTitle:
          safeString(
            body.openingTitle,
            500
          ),

        openingMessage:
          safeString(
            body.openingMessage,
            3000
          ),


        /* ---------------------------------------------
           GROOM
        --------------------------------------------- */

        groom: {
          ...(old.groom || {}),

          name:
            safeString(
              body.groomName,
              200
            ),

          fullName:
            safeString(
              body.groomFullName,
              300
            ),

          father:
            safeString(
              body.groomFather,
              300
            ),

          mother:
            safeString(
              body.groomMother,
              300
            )
        },


        /* ---------------------------------------------
           BRIDE
        --------------------------------------------- */

        bride: {
          ...(old.bride || {}),

          name:
            safeString(
              body.brideName,
              200
            ),

          fullName:
            safeString(
              body.brideFullName,
              300
            ),

          father:
            safeString(
              body.brideFather,
              300
            ),

          mother:
            safeString(
              body.brideMother,
              300
            )
        },


        /* ---------------------------------------------
           DATE
        --------------------------------------------- */

        weddingDate:
          safeString(
            body.weddingDate,
            50
          ),

        timezone:
          safeString(
            body.timezone ||
              "Asia/Jakarta",
            100
          ),


        /* ---------------------------------------------
           EVENT
        --------------------------------------------- */

        events:
          parseJSON(
            body.events,
            old.events || []
          ),


        /* ---------------------------------------------
           STORY
        --------------------------------------------- */

        story:
          parseJSON(
            body.story,
            old.story || []
          ),


        /* ---------------------------------------------
           GALLERY
        --------------------------------------------- */

        gallery,


        /* ---------------------------------------------
           LOCATION
        --------------------------------------------- */

        location: {
          ...(old.location || {}),

          venue:
            safeString(
              body.venue,
              300
            ),

          address:
            safeString(
              body.address,
              1000
            ),

          mapUrl:
            safeString(
              body.mapUrl,
              2000
            )
        },


        /* ---------------------------------------------
           GIFT
        --------------------------------------------- */

        gift:
          parseJSON(
            body.gift,
            old.gift || []
          ),


        /* ---------------------------------------------
           RSVP
        --------------------------------------------- */

        rsvpEnabled:
          body.rsvpEnabled === "on" ||
          body.rsvpEnabled === "true",


        /* ---------------------------------------------
           MUSIC
        --------------------------------------------- */

        musicEnabled:
          body.musicEnabled === "on" ||
          body.musicEnabled === "true",

        music,


        /* ---------------------------------------------
           MEDIA
        --------------------------------------------- */

        coverImage,
        groomImage,
        brideImage,


        /* ---------------------------------------------
           CUSTOM
        --------------------------------------------- */

        settings: {
          ...(old.settings || {}),

          primaryFont:
            safeString(
              body.primaryFont,
              100
            ),

          secondaryFont:
            safeString(
              body.secondaryFont,
              100
            ),

          backgroundColor:
            safeString(
              body.backgroundColor,
              50
            ),

          accentColor:
            safeString(
              body.accentColor,
              50
            )
        },


        /* ---------------------------------------------
           RSVP DATA
        --------------------------------------------- */

        rsvps:
          Array.isArray(old.rsvps)
            ? old.rsvps
            : [],

        wishes:
          Array.isArray(old.wishes)
            ? old.wishes
            : []
      };


      /* =====================================================
         SAVE
      ===================================================== */

      await saveWedding(
        updatedWedding
      );


      /*
        Jika slug berubah,
        hapus key lama SETELAH save sukses.
      */

      if (
        originalSlug &&
        originalSlug !== slug
      ) {
        await deleteWedding(
          originalSlug
        );
      }


      const invitationUrl =
        `${BASE_URL}/${encodeURIComponent(
          slug
        )}`;

      return res.redirect(
        `/admin/wedding/${encodeURIComponent(
          slug
        )}?saved=1`
      );
    } catch (error) {
      console.error(
        "SAVE WEDDING ERROR:",
        error
      );

      return res.status(500).send(
        `Gagal menyimpan wedding: ${error.message}`
      );
    }
  }
);


/* =========================================================
   DELETE WEDDING
========================================================= */

app.post(
  "/admin/wedding/:slug/delete",
  requireAdmin,
  requireCsrf,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      await deleteWedding(slug);

      return res.redirect("/admin");
    } catch (error) {
      console.error(
        "DELETE WEDDING ERROR:",
        error
      );

      return res.status(500).send(
        "Gagal menghapus wedding."
      );
    }
  }
);


/* =========================================================
   PUBLISH / UNPUBLISH
========================================================= */

app.post(
  "/admin/wedding/:slug/status",
  requireAdmin,
  requireCsrf,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      const status =
        req.body.status ===
        "published"
          ? "published"
          : "draft";

      wedding.status = status;

      wedding.updatedAt =
        new Date().toISOString();

      await saveWedding(wedding);

      return res.redirect(
        "/admin"
      );
    } catch (error) {
      console.error(
        "STATUS ERROR:",
        error
      );

      return res.status(500).send(
        "Gagal mengubah status wedding."
      );
    }
  }
);


/* =========================================================
   DELETE GALLERY ITEM
========================================================= */

app.post(
  "/admin/wedding/:slug/gallery/delete",
  requireAdmin,
  requireCsrf,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const index =
        Number(req.body.index);

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      if (
        !Array.isArray(
          wedding.gallery
        )
      ) {
        return res.redirect(
          `/admin/wedding/${slug}`
        );
      }

      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index <
          wedding.gallery.length
      ) {
        wedding.gallery.splice(
          index,
          1
        );
      }

      wedding.updatedAt =
        new Date().toISOString();

      await saveWedding(
        wedding
      );

      return res.redirect(
        `/admin/wedding/${encodeURIComponent(
          slug
        )}`
      );
    } catch (error) {
      console.error(
        "DELETE GALLERY ERROR:",
        error
      );

      return res.status(500).send(
        "Gagal menghapus gambar."
      );
    }
  }
);


/* =========================================================
   DELETE MUSIC
========================================================= */

app.post(
  "/admin/wedding/:slug/music/delete",
  requireAdmin,
  requireCsrf,
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      wedding.music = null;

      wedding.musicEnabled =
        false;

      wedding.updatedAt =
        new Date().toISOString();

      await saveWedding(
        wedding
      );

      return res.redirect(
        `/admin/wedding/${encodeURIComponent(
          slug
        )}`
      );
    } catch (error) {
      console.error(
        "DELETE MUSIC ERROR:",
        error
      );

      return res.status(500).send(
        "Gagal menghapus musik."
      );
    }
  }
);


/* =========================================================
   RSVP API
========================================================= */

app.post(
  "/api/wedding/:slug/rsvp",
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.params.slug
        );

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return res.status(404).json({
          success: false,
          message:
            "Wedding tidak ditemukan."
        });
      }

      if (
        wedding.rsvpEnabled ===
        false
      ) {
        return res.status(403).json({
          success: false,
          message:
            "RSVP sedang dinonaktifkan."
        });
      }

      const name =
        sanitizeGuestName(
          req.body.name
        );

      const attendance =
        safeString(
          req.body.attendance,
          50
        );

      const guests =
        Number(
          req.body.guests || 0
        );

      const message =
        safeString(
          req.body.message,
          1000
        );


      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            "Nama wajib diisi."
        });
      }

      const allowedAttendance = [
        "Hadir",
        "Tidak Hadir",
        "Tidak Menentukan"
      ];

      if (
        !allowedAttendance.includes(
          attendance
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Status kehadiran tidak valid."
        });
      }


      const rsvp = {
        id:
          generateId("rsvp"),

        name,

        attendance,

        guests:
          Math.max(
            0,
            Math.min(
              guests,
              20
            )
          ),

        message,

        createdAt:
          new Date().toISOString()
      };


      if (
        !Array.isArray(
          wedding.rsvps
        )
      ) {
        wedding.rsvps = [];
      }

      wedding.rsvps.push(rsvp);

      /*
        Wishes tetap dipisahkan
        dari RSVP.
      */

      if (message) {
        if (
          !Array.isArray(
            wedding.wishes
          )
        ) {
          wedding.wishes = [];
        }

        wedding.wishes.push({
          id:
            generateId("wish"),

          name,

          message,

          createdAt:
            new Date().toISOString()
        });
      }


      wedding.updatedAt =
        new Date().toISOString();

      await saveWedding(
        wedding
      );


      return res.json({
        success: true,
        message:
          "RSVP berhasil disimpan."
      });
    } catch (error) {
      console.error(
        "RSVP ERROR:",
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

      /*
        Jangan menangkap system route.
      */

      if (
        isReservedSlug(slug)
      ) {
        return next();
      }

      if (
        !isValidSlug(slug)
      ) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      const wedding =
        await getWedding(slug);

      if (!wedding) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }

      /*
        Wedding draft tidak boleh
        diakses publik.
      */

      if (
        wedding.status !==
        "published"
      ) {
        return res.status(404).send(
          "Wedding tidak ditemukan."
        );
      }


      /*
        Personalized guest name
        dari ?to=
      */

      const guestName =
        sanitizeGuestName(
          req.query.to
        );


      return res.render(
        "wedding",
        {
          wedding,

          guestName,

          slug,

          baseUrl: BASE_URL,

          invitationUrl:
            `${BASE_URL}/${encodeURIComponent(
              slug
            )}`,

          csrfToken: ""
        }
      );
    } catch (error) {
      console.error(
        "PUBLIC WEDDING ERROR:",
        error
      );

      return res.status(500).send(
        "Terjadi kesalahan saat membuka undangan."
      );
    }
  }
);


/* =========================================================
   MULTER ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      console.error(
        "MULTER ERROR:",
        error
      );

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res.status(413).send(
          "Ukuran file terlalu besar. Maksimal 8 MB per file."
        );
      }

      return res.status(400).send(
        `Upload error: ${error.message}`
      );
    }

    if (error) {
      console.error(
        "GLOBAL ERROR:",
        error
      );

      return res.status(500).send(
        `Server error: ${error.message}`
      );
    }

    next();
  }
);


/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    return res.status(404).send(
      "Halaman tidak ditemukan."
    );
  }
);


/* =========================================================
   LOCAL SERVER
========================================================= */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `LOVEFOREVER running on port ${PORT}`
    );
  });
}


/* =========================================================
   VERCEL EXPORT
========================================================= */

module.exports = app;
