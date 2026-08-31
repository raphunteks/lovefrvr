require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

const app = express();

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME || "";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "";

const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL || "";

const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || "";

const SESSION_TTL =
  60 * 60 * 24;

const RESERVED_SLUGS = [
  "admin",
  "login",
  "api",
  "health",
  "favicon.ico",
];


/*
|--------------------------------------------------------------------------
| ENV WARNING
|--------------------------------------------------------------------------
*/

if (
  !ADMIN_USERNAME ||
  !ADMIN_PASSWORD
) {
  console.warn(
    "WARNING: ADMIN_USERNAME / ADMIN_PASSWORD belum dikonfigurasi."
  );
}

if (
  !UPSTASH_REDIS_REST_URL ||
  !UPSTASH_REDIS_REST_TOKEN
) {
  console.warn(
    "WARNING: Upstash Redis environment variables belum dikonfigurasi."
  );
}


/*
|--------------------------------------------------------------------------
| REDIS
|--------------------------------------------------------------------------
*/

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});


/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

app.set(
  "view engine",
  "ejs"
);

app.set(
  "views",
  path.join(
    __dirname,
    "views"
  )
);

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use(
  express.json()
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function generateId(
  prefix = ""
) {
  return (
    prefix +
    crypto
      .randomBytes(16)
      .toString("hex")
  );
}


function now() {
  return new Date().toISOString();
}


function normalizeSlug(
  value
) {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9-]/g,
      "-"
    )
    .replace(
      /-+/g,
      "-"
    )
    .replace(
      /^-|-$/g,
      "");
}


function isValidSlug(
  slug
) {
  if (!slug) {
    return false;
  }

  if (
    slug.length < 3 ||
    slug.length > 100
  ) {
    return false;
  }

  if (
    !/^[a-z0-9-]+$/.test(
      slug
    )
  ) {
    return false;
  }

  if (
    RESERVED_SLUGS.includes(
      slug
    )
  ) {
    return false;
  }

  return true;
}


function sanitizeGuestName(
  value
) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .replace(
      /[<>]/g,
      ""
    )
    .slice(0, 150);
}


function parseRedisValue(
  value
) {
  if (!value) {
    return null;
  }

  if (
    typeof value ===
    "string"
  ) {
    try {
      return JSON.parse(
        value
      );
    } catch {
      return null;
    }
  }

  return value;
}


/*
|--------------------------------------------------------------------------
| DYNAMIC DOMAIN
|--------------------------------------------------------------------------
|
| Tidak ada domain hardcode.
|
| Jika dibuka:
|
| https://loveforever.vercel.app
|
| hasil:
|
| https://loveforever.vercel.app
|
| Jika nanti menggunakan:
|
| https://domainanda.com
|
| hasil:
|
| https://domainanda.com
|
*/

function getBaseUrl(
  req
) {
  const protocol =
    req.headers[
      "x-forwarded-proto"
    ] ||
    req.protocol ||
    "http";

  const host =
    req.headers[
      "x-forwarded-host"
    ] ||
    req.get("host");

  return (
    protocol +
    "://" +
    host
  );
}


function getInvitationUrl(
  req,
  slug
) {
  return (
    getBaseUrl(req) +
    "/" +
    encodeURIComponent(
      slug
    )
  );
}


function getGuestInvitationUrl(
  req,
  slug,
  guestName
) {
  const base =
    getInvitationUrl(
      req,
      slug
    );

  if (!guestName) {
    return base;
  }

  return (
    base +
    "?to=" +
    encodeURIComponent(
      guestName
    )
  );
}


/*
|--------------------------------------------------------------------------
| COOKIE
|--------------------------------------------------------------------------
*/

function parseCookies(
  req
) {
  const cookies = {};

  const header =
    req.headers.cookie;

  if (!header) {
    return cookies;
  }

  header
    .split(";")
    .forEach(
      (item) => {
        const index =
          item.indexOf("=");

        if (
          index === -1
        ) {
          return;
        }

        const key =
          item
            .slice(
              0,
              index
            )
            .trim();

        const value =
          item
            .slice(
              index + 1
            )
            .trim();

        cookies[key] =
          decodeURIComponent(
            value
          );
      }
    );

  return cookies;
}


function setCookie(
  res,
  name,
  value,
  options = {}
) {
  const parts = [
    `${name}=${encodeURIComponent(
      value
    )}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (
    options.maxAge !==
    undefined
  ) {
    parts.push(
      `Max-Age=${options.maxAge}`
    );
  }

  if (options.secure) {
    parts.push(
      "Secure"
    );
  }

  res.setHeader(
    "Set-Cookie",
    parts.join("; ")
  );
}


function clearCookie(
  res,
  name
) {
  setCookie(
    res,
    name,
    "",
    {
      maxAge: 0,
      secure:
        process.env.NODE_ENV ===
        "production",
    }
  );
}


/*
|--------------------------------------------------------------------------
| SESSION
|--------------------------------------------------------------------------
*/

async function createAdminSession() {
  const sessionId =
    generateId(
      "sess_"
    );

  const session = {
    id: sessionId,
    username:
      ADMIN_USERNAME,
    authenticated: true,
    createdAt: now(),
  };

  await redis.set(
    `session:${sessionId}`,
    JSON.stringify(
      session
    ),
    {
      ex: SESSION_TTL,
    }
  );

  return sessionId;
}


async function getAdminSession(
  req
) {
  try {
    const cookies =
      parseCookies(req);

    const sessionId =
      cookies.admin_session;

    if (!sessionId) {
      return null;
    }

    const value =
      await redis.get(
        `session:${sessionId}`
      );

    return parseRedisValue(
      value
    );
  } catch (error) {
    console.error(
      "SESSION ERROR:",
      error
    );

    return null;
  }
}


async function destroyAdminSession(
  req
) {
  try {
    const cookies =
      parseCookies(req);

    const sessionId =
      cookies.admin_session;

    if (!sessionId) {
      return;
    }

    await redis.del(
      `session:${sessionId}`
    );

    await redis.del(
      `csrf:${sessionId}`
    );
  } catch (error) {
    console.error(
      "DESTROY SESSION ERROR:",
      error
    );
  }
}


/*
|--------------------------------------------------------------------------
| ADMIN AUTH
|--------------------------------------------------------------------------
*/

async function requireAdmin(
  req,
  res,
  next
) {
  const session =
    await getAdminSession(
      req
    );

  if (
    !session ||
    session.authenticated !==
      true
  ) {
    return res.redirect(
      "/admin/login"
    );
  }

  req.admin =
    session;

  next();
}


/*
|--------------------------------------------------------------------------
| CSRF
|--------------------------------------------------------------------------
*/

async function getCsrfToken(
  req
) {
  const cookies =
    parseCookies(req);

  const sessionId =
    cookies.admin_session;

  if (!sessionId) {
    return null;
  }

  const key =
    `csrf:${sessionId}`;

  let token =
    await redis.get(key);

  if (!token) {
    token =
      crypto
        .randomBytes(32)
        .toString("hex");

    await redis.set(
      key,
      token,
      {
        ex: SESSION_TTL,
      }
    );
  }

  return String(token);
}


async function verifyCsrf(
  req
) {
  const cookies =
    parseCookies(req);

  const sessionId =
    cookies.admin_session;

  if (!sessionId) {
    return false;
  }

  const submittedToken =
    String(
      req.body._csrf || ""
    );

  if (!submittedToken) {
    return false;
  }

  const storedToken =
    await redis.get(
      `csrf:${sessionId}`
    );

  if (!storedToken) {
    return false;
  }

  const stored =
    String(
      storedToken
    );

  if (
    submittedToken.length !==
    stored.length
  ) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(
        submittedToken
      ),
      Buffer.from(
        stored
      )
    );
  } catch {
    return false;
  }
}


/*
|--------------------------------------------------------------------------
| LOGIN RATE LIMIT
|--------------------------------------------------------------------------
*/

async function loginRateLimit(
  req,
  res,
  next
) {
  try {
    const forwarded =
      req.headers[
        "x-forwarded-for"
      ];

    const ip =
      forwarded
        ? String(
            forwarded
          )
            .split(",")[0]
            .trim()
        : req.socket
            .remoteAddress ||
          "unknown";

    const key =
      `login-attempt:${ip}`;

    const attempts =
      await redis.incr(key);

    if (attempts === 1) {
      await redis.expire(
        key,
        300
      );
    }

    if (attempts > 10) {
      return res
        .status(429)
        .render(
          "login",
          {
            error:
              "Terlalu banyak percobaan login. Silakan coba lagi dalam beberapa menit.",
            csrfToken: null,
          }
        );
    }

    next();
  } catch (error) {
    console.error(
      "RATE LIMIT ERROR:",
      error
    );

    next();
  }
}


/*
|--------------------------------------------------------------------------
| WEDDING STORAGE
|--------------------------------------------------------------------------
*/

async function getWedding(
  slug
) {
  const value =
    await redis.get(
      `wedding:${slug}`
    );

  return parseRedisValue(
    value
  );
}


async function getAllWeddings() {
  const slugs =
    await redis.smembers(
      "weddings"
    );

  if (
    !slugs ||
    !slugs.length
  ) {
    return [];
  }

  const weddings = [];

  for (
    const slug of slugs
  ) {
    const wedding =
      await getWedding(
        slug
      );

    if (wedding) {
      weddings.push(
        wedding
      );
    }
  }

  weddings.sort(
    (a, b) =>
      new Date(
        b.createdAt
      ) -
      new Date(
        a.createdAt
      )
  );

  return weddings;
}


async function saveWedding(
  wedding
) {
  await redis.set(
    `wedding:${wedding.slug}`,
    JSON.stringify(
      wedding
    )
  );

  await redis.sadd(
    "weddings",
    wedding.slug
  );
}


async function deleteWedding(
  slug
) {
  await redis.del(
    `wedding:${slug}`
  );

  await redis.srem(
    "weddings",
    slug
  );
}


/*
|--------------------------------------------------------------------------
| LANDING PAGE
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  async (req, res) => {
    try {
      const weddings =
        await getAllWeddings();

      const published =
        weddings.filter(
          (wedding) =>
            wedding.status ===
            "published"
        );

      return res.render(
        "index",
        {
          weddings: published,
          baseUrl:
            getBaseUrl(req),
        }
      );
    } catch (error) {
      console.error(
        "LANDING ERROR:",
        error
      );

      return res
        .status(500)
        .render(
          "index",
          {
            weddings: [],
            baseUrl:
              getBaseUrl(req),
          }
        );
    }
  }
);


/*
|--------------------------------------------------------------------------
| LOGIN PAGE
|--------------------------------------------------------------------------
*/

app.get(
  "/admin/login",
  async (req, res) => {
    const session =
      await getAdminSession(
        req
      );

    if (
      session &&
      session.authenticated ===
        true
    ) {
      return res.redirect(
        "/admin"
      );
    }

    return res.render(
      "login",
      {
        error: null,
        csrfToken: null,
      }
    );
  }
);


/*
|--------------------------------------------------------------------------
| LOGIN
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/login",
  loginRateLimit,
  async (req, res) => {
    try {
      const username =
        String(
          req.body.username ||
            ""
        ).trim();

      const password =
        String(
          req.body.password ||
            ""
        );

      /*
       * Tidak menggunakan hash.
       *
       * Credential langsung dibandingkan
       * dengan ENV:
       *
       * ADMIN_USERNAME
       * ADMIN_PASSWORD
       */

      const usernameValid =
        username ===
        ADMIN_USERNAME;

      const passwordValid =
        password ===
        ADMIN_PASSWORD;

      if (
        !usernameValid ||
        !passwordValid
      ) {
        return res
          .status(401)
          .render(
            "login",
            {
              error:
                "Username atau password salah.",
              csrfToken: null,
            }
          );
      }

      const sessionId =
        await createAdminSession();

      const csrfToken =
        crypto
          .randomBytes(32)
          .toString("hex");

      await redis.set(
        `csrf:${sessionId}`,
        csrfToken,
        {
          ex: SESSION_TTL,
        }
      );

      setCookie(
        res,
        "admin_session",
        sessionId,
        {
          maxAge:
            SESSION_TTL,
          secure:
            process.env.NODE_ENV ===
            "production",
        }
      );

      return res.redirect(
        "/admin"
      );
    } catch (error) {
      console.error(
        "LOGIN ERROR:",
        error
      );

      return res
        .status(500)
        .render(
          "login",
          {
            error:
              "Terjadi kesalahan server.",
            csrfToken: null,
          }
        );
    }
  }
);


/*
|--------------------------------------------------------------------------
| LOGOUT
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/logout",
  requireAdmin,
  async (req, res) => {
    try {
      const validCsrf =
        await verifyCsrf(req);

      if (!validCsrf) {
        return res
          .status(403)
          .send(
            "CSRF token tidak valid."
          );
      }

      await destroyAdminSession(
        req
      );

      clearCookie(
        res,
        "admin_session"
      );

      return res.redirect(
        "/admin/login"
      );
    } catch (error) {
      console.error(
        "LOGOUT ERROR:",
        error
      );

      return res.redirect(
        "/admin/login"
      );
    }
  }
);


/*
|--------------------------------------------------------------------------
| ADMIN DASHBOARD
|--------------------------------------------------------------------------
*/

app.get(
  "/admin",
  requireAdmin,
  async (req, res) => {
    try {
      const weddings =
        await getAllWeddings();

      const csrfToken =
        await getCsrfToken(req);

      let totalRsvp = 0;

      for (
        const wedding of weddings
      ) {
        const ids =
          await redis.smembers(
            `rsvp:${wedding.slug}`
          );

        if (ids) {
          totalRsvp +=
            ids.length;
        }
      }

      const published =
        weddings.filter(
          (wedding) =>
            wedding.status ===
            "published"
        ).length;

      const draft =
        weddings.filter(
          (wedding) =>
            wedding.status ===
            "draft"
        ).length;

      /*
       * Tambahkan invitation URL
       * menggunakan domain request saat ini.
       */

      const weddingList =
        weddings.map(
          (wedding) => ({
            ...wedding,

            invitationUrl:
              getInvitationUrl(
                req,
                wedding.slug
              ),
          })
        );

      return res.render(
        "admin",
        {
          admin:
            req.admin,

          weddings:
            weddingList,

          csrfToken,

          baseUrl:
            getBaseUrl(req),

          stats: {
            totalWeddings:
              weddings.length,

            publishedWeddings:
              published,

            draftWeddings:
              draft,

            totalRsvp,
          },

          message:
            req.query.message ||
            null,

          error:
            req.query.error ||
            null,
        }
      );
    } catch (error) {
      console.error(
        "ADMIN ERROR:",
        error
      );

      return res
        .status(500)
        .send(
          "Terjadi kesalahan pada dashboard."
        );
    }
  }
);


/*
|--------------------------------------------------------------------------
| CREATE WEDDING
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/create",
  requireAdmin,
  async (req, res) => {
    try {
      if (
        !(await verifyCsrf(req))
      ) {
        return res
          .status(403)
          .send(
            "CSRF token tidak valid."
          );
      }

      const slug =
        normalizeSlug(
          req.body.slug
        );

      if (
        !isValidSlug(slug)
      ) {
        return res.redirect(
          "/admin?error=" +
            encodeURIComponent(
              "Slug tidak valid."
            )
        );
      }

      const existing =
        await getWedding(
          slug
        );

      if (existing) {
        return res.redirect(
          "/admin?error=" +
            encodeURIComponent(
              "Slug sudah digunakan."
            )
        );
      }

      const wedding = {
        id: generateId(
          "wedding_"
        ),

        slug,

        status:
          req.body.status ===
          "published"
            ? "published"
            : "draft",

        groom: {
          name: String(
            req.body.groomName ||
              ""
          ).trim(),

          fullName: String(
            req.body.groomFullName ||
              ""
          ).trim(),

          nickname: String(
            req.body.groomNickname ||
              ""
          ).trim(),

          father: String(
            req.body.groomFather ||
              ""
          ).trim(),

          mother: String(
            req.body.groomMother ||
              ""
          ).trim(),

          photo: String(
            req.body.groomPhoto ||
              ""
          ).trim(),
        },

        bride: {
          name: String(
            req.body.brideName ||
              ""
          ).trim(),

          fullName: String(
            req.body.brideFullName ||
              ""
          ).trim(),

          nickname: String(
            req.body.brideNickname ||
              ""
          ).trim(),

          father: String(
            req.body.brideFather ||
              ""
          ).trim(),

          mother: String(
            req.body.brideMother ||
              ""
          ).trim(),

          photo: String(
            req.body.bridePhoto ||
              ""
          ).trim(),
        },

        date: String(
          req.body.date ||
            ""
        ).trim(),

        description:
          String(
            req.body.description ||
              ""
          ).trim(),

        quote: String(
          req.body.quote ||
            ""
        ).trim(),

        story: [],

        events: [],

        gallery: [],

        gift: [],

        music: {
          enabled:
            req.body.musicEnabled ===
            "on",

          url: String(
            req.body.musicUrl ||
              ""
          ).trim(),
        },

        createdAt:
          now(),

        updatedAt:
          now(),
      };

      await saveWedding(
        wedding
      );

      return res.redirect(
        "/admin?message=" +
          encodeURIComponent(
            "Wedding berhasil dibuat."
          )
      );
    } catch (error) {
      console.error(
        "CREATE ERROR:",
        error
      );

      return res.redirect(
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
| UPDATE WEDDING
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/update",
  requireAdmin,
  async (req, res) => {
    try {
      if (
        !(await verifyCsrf(req))
      ) {
        return res
          .status(403)
          .send(
            "CSRF token tidak valid."
          );
      }

      const slug =
        normalizeSlug(
          req.body.slug
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {
        return res.redirect(
          "/admin?error=" +
            encodeURIComponent(
              "Wedding tidak ditemukan."
            )
        );
      }

      wedding.status =
        req.body.status ===
        "published"
          ? "published"
          : "draft";

      wedding.groom =
        wedding.groom || {};

      wedding.bride =
        wedding.bride || {};

      wedding.music =
        wedding.music || {
          enabled: false,
          url: "",
        };

      wedding.groom.name =
        String(
          req.body.groomName ||
            ""
        ).trim();

      wedding.groom.fullName =
        String(
          req.body.groomFullName ||
            ""
        ).trim();

      wedding.groom.nickname =
        String(
          req.body.groomNickname ||
            ""
        ).trim();

      wedding.groom.father =
        String(
          req.body.groomFather ||
            ""
        ).trim();

      wedding.groom.mother =
        String(
          req.body.groomMother ||
            ""
        ).trim();

      wedding.groom.photo =
        String(
          req.body.groomPhoto ||
            ""
        ).trim();

      wedding.bride.name =
        String(
          req.body.brideName ||
            ""
        ).trim();

      wedding.bride.fullName =
        String(
          req.body.brideFullName ||
            ""
        ).trim();

      wedding.bride.nickname =
        String(
          req.body.brideNickname ||
            ""
        ).trim();

      wedding.bride.father =
        String(
          req.body.brideFather ||
            ""
        ).trim();

      wedding.bride.mother =
        String(
          req.body.brideMother ||
            ""
        ).trim();

      wedding.bride.photo =
        String(
          req.body.bridePhoto ||
            ""
        ).trim();

      wedding.date =
        String(
          req.body.date ||
            ""
        ).trim();

      wedding.description =
        String(
          req.body.description ||
            ""
        ).trim();

      wedding.quote =
        String(
          req.body.quote ||
            ""
        ).trim();

      wedding.music.enabled =
        req.body.musicEnabled ===
        "on";

      wedding.music.url =
        String(
          req.body.musicUrl ||
            ""
        ).trim();

      wedding.updatedAt =
        now();

      await saveWedding(
        wedding
      );

      return res.redirect(
        "/admin?message=" +
          encodeURIComponent(
            "Wedding berhasil diperbarui."
          )
      );
    } catch (error) {
      console.error(
        "UPDATE ERROR:",
        error
      );

      return res.redirect(
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
| PUBLISH / UNPUBLISH
|--------------------------------------------------------------------------
*/

app.post(
  "/admin/wedding/status",
  requireAdmin,
  async (req, res) => {
    try {
      if (
        !(await verifyCsrf(req))
      ) {
        return res
          .status(403)
          .send(
            "CSRF token tidak valid."
          );
      }

      const slug =
        normalizeSlug(
          req.body.slug
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {
        return res.redirect(
          "/admin?error=" +
            encodeURIComponent(
              "Wedding tidak ditemukan."
            )
        );
      }

      wedding.status =
        wedding.status ===
        "published"
          ? "draft"
          : "published";

      wedding.updatedAt =
        now();

      await saveWedding(
        wedding
      );

      return res.redirect(
        "/admin?message=" +
          encodeURIComponent(
            "Status berhasil diubah."
          )
      );
    } catch (error) {
      console.error(
        "STATUS ERROR:",
        error
      );

      return res.redirect(
        "/admin?error=" +
          encodeURIComponent(
            "Gagal mengubah status."
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
  "/admin/wedding/delete",
  requireAdmin,
  async (req, res) => {
    try {
      if (
        !(await verifyCsrf(req))
      ) {
        return res
          .status(403)
          .send(
            "CSRF token tidak valid."
          );
      }

      const slug =
        normalizeSlug(
          req.body.slug
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {
        return res.redirect(
          "/admin?error=" +
            encodeURIComponent(
              "Wedding tidak ditemukan."
            )
        );
      }

      await deleteWedding(
        slug
      );

      /*
       * Hapus RSVP.
       */

      const rsvpKey =
        `rsvp:${slug}`;

      const ids =
        await redis.smembers(
          rsvpKey
        );

      if (ids) {
        for (
          const id of ids
        ) {
          await redis.del(
            `rsvp:${slug}:${id}`
          );
        }
      }

      await redis.del(
        rsvpKey
      );

      return res.redirect(
        "/admin?message=" +
          encodeURIComponent(
            "Wedding berhasil dihapus."
          )
      );
    } catch (error) {
      console.error(
        "DELETE ERROR:",
        error
      );

      return res.redirect(
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
| RSVP API
|--------------------------------------------------------------------------
*/

app.post(
  "/api/rsvp",
  async (req, res) => {
    try {
      const slug =
        normalizeSlug(
          req.body.slug
        );

      if (
        !isValidSlug(slug)
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Slug tidak valid.",
          });
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
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Wedding tidak ditemukan.",
          });
      }

      const name =
        String(
          req.body.name ||
            ""
        )
          .trim()
          .slice(0, 100);

      const attendance =
        String(
          req.body.attendance ||
            ""
        )
          .trim()
          .toLowerCase();

      const guestCount =
        Number(
          req.body.guestCount
        );

      const message =
        String(
          req.body.message ||
            ""
        )
          .trim()
          .slice(0, 500);

      if (!name) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Nama wajib diisi.",
          });
      }

      const validAttendance = [
        "hadir",
        "tidak_hadir",
        "masih_menentukan",
      ];

      if (
        !validAttendance.includes(
          attendance
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Pilihan kehadiran tidak valid.",
          });
      }

      if (
        !Number.isInteger(
          guestCount
        ) ||
        guestCount < 1 ||
        guestCount > 20
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Jumlah tamu tidak valid.",
          });
      }

      const id =
        generateId(
          "rsvp_"
        );

      const rsvp = {
        id,

        weddingSlug:
          slug,

        name,

        attendance,

        guestCount,

        message,

        createdAt:
          now(),
      };

      await redis.set(
        `rsvp:${slug}:${id}`,
        JSON.stringify(
          rsvp
        )
      );

      await redis.sadd(
        `rsvp:${slug}`,
        id
      );

      return res.json({
        success: true,
        message:
          "RSVP berhasil dikirim.",
      });
    } catch (error) {
      console.error(
        "RSVP ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Terjadi kesalahan server.",
        });
    }
  }
);


/*
|--------------------------------------------------------------------------
| RSVP ADMIN
|--------------------------------------------------------------------------
*/

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
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Wedding tidak ditemukan.",
          });
      }

      const ids =
        await redis.smembers(
          `rsvp:${slug}`
        );

      const rsvps = [];

      if (ids) {
        for (
          const id of ids
        ) {
          const value =
            await redis.get(
              `rsvp:${slug}:${id}`
            );

          const rsvp =
            parseRedisValue(
              value
            );

          if (rsvp) {
            rsvps.push(
              rsvp
            );
          }
        }
      }

      rsvps.sort(
        (a, b) =>
          new Date(
            b.createdAt
          ) -
          new Date(
            a.createdAt
          )
      );

      return res.json({
        success: true,

        total:
          rsvps.length,

        rsvps,
      });
    } catch (error) {
      console.error(
        "GET RSVP ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Gagal mengambil RSVP.",
        });
    }
  }
);


/*
|--------------------------------------------------------------------------
| PUBLIC WEDDING
|--------------------------------------------------------------------------
*/

app.get(
  "/:slug",
  async (req, res, next) => {
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

    try {
      const wedding =
        await getWedding(
          slug
        );

      if (
        !wedding ||
        wedding.status !==
          "published"
      ) {
        return res
          .status(404)
          .send(
            "Wedding invitation tidak ditemukan."
          );
      }

      const guestName =
        sanitizeGuestName(
          req.query.to
        );

      return res.render(
        "wedding",
        {
          wedding,

          guestName,

          baseUrl:
            getBaseUrl(req),

          invitationUrl:
            getInvitationUrl(
              req,
              slug
            ),

          guestInvitationUrl:
            getGuestInvitationUrl(
              req,
              slug,
              guestName
            ),
        }
      );
    } catch (error) {
      console.error(
        "WEDDING ERROR:",
        error
      );

      return res
        .status(500)
        .send(
          "Terjadi kesalahan server."
        );
    }
  }
);


/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  async (req, res) => {
    try {
      await redis.set(
        "healthcheck",
        now(),
        {
          ex: 60,
        }
      );

      return res.json({
        status: "ok",

        app:
          "LOVEFOREVER",

        redis:
          "ok",

        domain:
          getBaseUrl(req),

        timestamp:
          now(),
      });
    } catch {
      return res
        .status(503)
        .json({
          status:
            "error",

          app:
            "LOVEFOREVER",

          redis:
            "error",

          timestamp:
            now(),
        });
    }
  }
);


/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use(
  (req, res) => {
    res
      .status(404)
      .send(
        "Halaman tidak ditemukan."
      );
  }
);


/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "UNHANDLED ERROR:",
      error
    );

    res
      .status(500)
      .send(
        "Internal Server Error."
      );
  }
);


/*
|--------------------------------------------------------------------------
| LOCAL SERVER
|--------------------------------------------------------------------------
*/

if (
  require.main ===
  module
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `LOVEFOREVER running at http://localhost:${PORT}`
      );
    }
  );
}


/*
|--------------------------------------------------------------------------
| VERCEL
|--------------------------------------------------------------------------
*/

module.exports = app;
