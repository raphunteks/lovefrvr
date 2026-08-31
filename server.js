require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const { Redis } = require("@upstash/redis");

const app = express();

const PORT =
  process.env.PORT || 3000;

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME || "";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET || "";

const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL || "";

const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || "";


/*
   Request body dibuat cukup besar agar upload Base64
   masih dapat diproses.

   WARNING:
   Tetap sesuaikan dengan batas deployment Vercel.
*/

const MAX_BODY_SIZE =
  "16mb";


/*
   Batas gambar.

   Target MVP:
   ± 1 MB per image.
*/

const MAX_IMAGE_BYTES =
  1024 * 1024;


/*
   Batas MP3.

   MP3 sengaja dibatasi.
   Base64 membuat ukuran request bertambah ±33%.
*/

const MAX_AUDIO_BYTES =
  8 * 1024 * 1024;


/*
   Maksimal gallery.
*/

const MAX_GALLERY_IMAGES =
  15;


/*
   Maksimal data teks.
*/

const MAX_WEDDING_TEXT =
  5000;


/*
   RSVP maksimum per wedding.
*/

const MAX_RSVP =
  5000;


/*
   Reserved slug.
*/

const RESERVED_SLUGS = [
  "admin",
  "login",
  "health",
  "api",
  "media",
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
  redis =
    new Redis({
      url:
        UPSTASH_REDIS_REST_URL,

      token:
        UPSTASH_REDIS_REST_TOKEN
    });
}


/* =========================================================
   EXPRESS
========================================================= */

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


/*
   JSON parser.
*/

app.use(
  express.json({
    limit:
      MAX_BODY_SIZE
  })
);


/*
   Form parser.
*/

app.use(
  express.urlencoded({
    extended:
      true,

    limit:
      MAX_BODY_SIZE
  })
);


/*
   Static files.
*/

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    ),
    {
      maxAge:
        process.env.NODE_ENV ===
        "production"
          ? "7d"
          : 0
    }
  )
);


/* =========================================================
   SECURITY HEADERS
========================================================= */

app.use(
  function securityHeaders(
    req,
    res,
    next
  ) {

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

    res.setHeader(
      "X-XSS-Protection",
      "0"
    );

    next();
  }
);


/* =========================================================
   BASIC UTILITY
========================================================= */

function nowISO() {

  return new Date()
    .toISOString();

}


function createId(
  prefix = "id"
) {

  return (
    prefix +
    "_" +
    Date.now()
      .toString(36) +
    "_" +
    crypto
      .randomBytes(6)
      .toString("hex")
  );

}


function safeString(
  value,
  maxLength = 1000
) {

  if (
    value ===
      undefined ||
    value ===
      null
  ) {

    return "";

  }

  return String(
    value
  )
    .replace(
      /\u0000/g,
      ""
    )
    .trim()
    .slice(
      0,
      maxLength
    );

}


/* =========================================================
   SLUG
========================================================= */

function normalizeSlug(
  value
) {

  return safeString(
    value,
    100
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      "-"
    )
    .replace(
      /[^a-z0-9-]/g,
      ""
    )
    .replace(
      /-+/g,
      "-"
    )
    .replace(
      /^-|-$/g,
      ""
    );

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


/* =========================================================
   GUEST
========================================================= */

function normalizeGuestName(
  value
) {

  return safeString(
    value,
    150
  );

}


/* =========================================================
   RSVP
========================================================= */

function validAttendance(
  value
) {

  return [
    "hadir",
    "tidak_hadir",
    "masih_menentukan"
  ].includes(
    value
  );

}


function parseInteger(
  value,
  fallback = 0
) {

  const number =
    Number(
      value
    );

  if (
    !Number.isInteger(
      number
    )
  ) {

    return fallback;

  }

  return number;

}


/* =========================================================
   REDIS KEYS
========================================================= */

function weddingKey(
  slug
) {

  return (
    `wedding:${slug}`
  );

}


function rsvpKey(
  slug
) {

  return (
    `rsvp:${slug}`
  );

}


function mediaKey(
  slug,
  mediaId
) {

  return (
    `wedding:${slug}:media:${mediaId}`
  );

}


const WEDDING_INDEX_KEY =
  "weddings";


/* =========================================================
   REDIS HELPERS
========================================================= */

async function getWedding(
  slug
) {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  return await redis.get(
    weddingKey(
      slug
    )
  );

}


async function saveWedding(
  wedding
) {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  await redis.set(
    weddingKey(
      wedding.slug
    ),
    wedding
  );

  return wedding;

}


async function deleteWeddingRedis(
  slug
) {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  await redis.del(
    weddingKey(
      slug
    )
  );

  await redis.del(
    rsvpKey(
      slug
    )
  );

}


async function getWeddingSlugs() {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  let slugs =
    await redis.get(
      WEDDING_INDEX_KEY
    );

  if (
    !Array.isArray(
      slugs
    )
  ) {

    slugs = [];

  }

  return slugs
    .map(
      normalizeSlug
    )
    .filter(Boolean);

}


async function saveWeddingSlugs(
  slugs
) {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  const unique =
    [
      ...new Set(
        slugs
      )
    ];

  await redis.set(
    WEDDING_INDEX_KEY,
    unique
  );

  return unique;

}


/* =========================================================
   DEFAULT WEDDING
========================================================= */

function createDefaultWedding() {

  const timestamp =
    nowISO();

  return {

    id:
      createId(
        "wedding"
      ),

    slug:
      "",

    status:
      "draft",

    groom: {

      name:
        "",

      fullName:
        "",

      photo:
        null

    },

    bride: {

      name:
        "",

      fullName:
        "",

      photo:
        null

    },

    coverImage:
      null,

    opening: {

      enabled:
        true,

      title:
        "The Wedding Of",

      subtitle:
        "Dengan penuh kebahagiaan",

      description:
        "Kami mengundang Bapak/Ibu/Saudara/i untuk hadir dan memberikan doa restu pada hari bahagia kami."

    },

    quote:
      "",

    description:
      "",

    date:
      "",

    timezone:
      "Asia/Jakarta",

    events:
      [],

    story:
      [],

    gallery:
      [],

    gift:
      [],

    music: {

      enabled:
        false,

      url:
        "",

      mediaId:
        "",

      name:
        ""

    },

    theme: {

      primary:
        "#2d2926",

      background:
        "#f7f2ec",

      accent:
        "#8b7565",

      font:
        "serif"

    },

    settings: {

      showCountdown:
        true,

      showStory:
        true,

      showGallery:
        true,

      showGift:
        true,

      showRsvp:
        true,

      showMusic:
        true,

      bottomNavigation:
        true

    },

    createdAt:
      timestamp,

    updatedAt:
      timestamp

  };

}


/* =========================================================
   ARRAY NORMALIZER
========================================================= */

function asArray(
  value
) {

  return Array.isArray(
    value
  )
    ? value
    : [];

}


/* =========================================================
   BASE64 VALIDATION
========================================================= */

function extractBase64(
  data
) {

  if (
    typeof data !==
    "string"
  ) {

    return null;

  }

  const comma =
    data.indexOf(
      ","
    );

  if (
    comma ===
    -1
  ) {

    return null;

  }

  return data.substring(
    comma + 1
  );

}


function estimateBase64Bytes(
  data
) {

  const base64 =
    extractBase64(
      data
    );

  if (!base64) {

    return 0;

  }

  const padding =
    base64.endsWith(
      "=="
    )
      ? 2
      : base64.endsWith(
          "="
        )
      ? 1
      : 0;

  return Math.floor(
    (
      base64.length *
      3
    ) /
      4
  ) - padding;

}


function validImageMime(
  mime
) {

  return [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ].includes(
    mime
  );

}


function validAudioMime(
  mime
) {

  return [
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/ogg"
  ].includes(
    mime
  );

}


/* =========================================================
   MEDIA NORMALIZATION
========================================================= */

function normalizeMediaRef(
  value
) {

  if (
    !value
  ) {

    return null;

  }

  /*
     Legacy Base64 object.
  */

  if (
    typeof value ===
      "object" &&
    typeof value.data ===
      "string"
  ) {

    return {

      legacy:
        true,

      data:
        value.data,

      mime:
        value.mime ||
        "image/jpeg",

      caption:
        value.caption ||
        ""

    };

  }

  /*
     New media reference.
  */

  if (
    typeof value ===
      "object" &&
    value.mediaId
  ) {

    return {

      mediaId:
        safeString(
          value.mediaId,
          100
        ),

      mime:
        safeString(
          value.mime,
          100
        ),

      name:
        safeString(
          value.name,
          200
        ),

      caption:
        safeString(
          value.caption,
          200
        ),

      size:
        Number(
          value.size ||
            0
        )

    };

  }

  return null;

}


/* =========================================================
   CREATE MEDIA RECORD
========================================================= */

async function saveMedia(
  slug,
  {
    data,
    mime,
    name,
    caption,
    kind
  }
) {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  if (
    typeof data !==
      "string" ||
    !data.startsWith(
      "data:"
    )
  ) {

    throw new Error(
      "Format media Base64 tidak valid."
    );

  }

  const bytes =
    estimateBase64Bytes(
      data
    );

  const isImage =
    validImageMime(
      mime
    );

  const isAudio =
    validAudioMime(
      mime
    );

  if (
    !isImage &&
    !isAudio
  ) {

    throw new Error(
      "Format media tidak didukung."
    );

  }

  if (
    isImage &&
    bytes >
      MAX_IMAGE_BYTES
  ) {

    throw new Error(
      "Ukuran gambar maksimal 1 MB."
    );

  }

  if (
    isAudio &&
    bytes >
      MAX_AUDIO_BYTES
  ) {

    throw new Error(
      "Ukuran audio maksimal 8 MB."
    );

  }

  const mediaId =
    createId(
      "media"
    );

  const record = {

    id:
      mediaId,

    slug:
      slug,

    kind:
      safeString(
        kind,
        50
      ),

    mime:
      safeString(
        mime,
        100
      ),

    name:
      safeString(
        name,
        200
      ),

    caption:
      safeString(
        caption,
        200
      ),

    size:
      bytes,

    data:
      data,

    createdAt:
      nowISO()

  };

  await redis.set(
    mediaKey(
      slug,
      mediaId
    ),
    record
  );

  return {

    id:
      mediaId,

    mime:
      record.mime,

    name:
      record.name,

    caption:
      record.caption,

    size:
      record.size

  };

}


/* =========================================================
   DELETE MEDIA
========================================================= */

async function deleteMedia(
  slug,
  mediaId
) {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  await redis.del(
    mediaKey(
      slug,
      mediaId
    )
  );

}


/* =========================================================
   GET MEDIA
========================================================= */

async function getMedia(
  slug,
  mediaId
) {

  if (!redis) {

    throw new Error(
      "Redis belum dikonfigurasi."
    );

  }

  return await redis.get(
    mediaKey(
      slug,
      mediaId
    )
  );

}


/* =========================================================
   BUILD WEDDING FROM PAYLOAD
========================================================= */

function buildWeddingFromPayload(
  payload,
  existing = null
) {

  const wedding =
    existing ||
    createDefaultWedding();

  wedding.status =
    payload.status ===
    "published"
      ? "published"
      : "draft";

  wedding.groom = {

    name:
      safeString(
        payload.groomName,
        100
      ),

    fullName:
      safeString(
        payload.groomFullName,
        200
      ),

    photo:
      normalizeMediaRef(
        payload.groomPhoto
      )

  };

  wedding.bride = {

    name:
      safeString(
        payload.brideName,
        100
      ),

    fullName:
      safeString(
        payload.brideFullName,
        200
      ),

    photo:
      normalizeMediaRef(
        payload.bridePhoto
      )

  };

  wedding.coverImage =
    normalizeMediaRef(
      payload.coverImage
    );

  wedding.opening = {

    enabled:
      payload.openingEnabled !==
      false,

    title:
      safeString(
        payload.openingTitle,
        200
      ) ||
      "The Wedding Of",

    subtitle:
      safeString(
        payload.openingSubtitle,
        500
      ) ||
      "Dengan penuh kebahagiaan",

    description:
      safeString(
        payload.openingDescription,
        1000
      )

  };

  wedding.quote =
    safeString(
      payload.quote,
      MAX_WEDDING_TEXT
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
    "Asia/Jakarta";

  wedding.events =
    asArray(
      payload.events
    )
      .slice(
        0,
        10
      )
      .map(
        function(event) {

          return {

            id:
              safeString(
                event.id,
                100
              ) ||
              createId(
                "event"
              ),

            type:
              safeString(
                event.type,
                50
              ),

            title:
              safeString(
                event.title,
                200
              ),

            date:
              safeString(
                event.date,
                100
              ),

            startTime:
              safeString(
                event.startTime,
                50
              ),

            endTime:
              safeString(
                event.endTime,
                50
              ),

            venue:
              safeString(
                event.venue,
                300
              ),

            address:
              safeString(
                event.address,
                1000
              ),

            mapsUrl:
              safeString(
                event.mapsUrl,
                1000
              ),

            description:
              safeString(
                event.description,
                1000
              )

          };

        }
      );

  wedding.story =
    asArray(
      payload.story
    )
      .slice(
        0,
        20
      )
      .map(
        function(item) {

          return {

            id:
              safeString(
                item.id,
                100
              ) ||
              createId(
                "story"
              ),

            date:
              safeString(
                item.date,
                100
              ),

            title:
              safeString(
                item.title,
                200
              ),

            description:
              safeString(
                item.description,
                1500
              ),

            photo:
              normalizeMediaRef(
                item.photo
              )

          };

        }
      );

  wedding.gallery =
    asArray(
      payload.gallery
    )
      .slice(
        0,
        MAX_GALLERY_IMAGES
      )
      .map(
        normalizeMediaRef
      )
      .filter(Boolean);

  wedding.gift =
    asArray(
      payload.gift
    )
      .slice(
        0,
        10
      )
      .map(
        function(item) {

          return {

            id:
              safeString(
                item.id,
                100
              ) ||
              createId(
                "gift"
              ),

            type:
              safeString(
                item.type,
                50
              ) ||
              "Bank",

            bank:
              safeString(
                item.bank,
                100
              ),

            accountNumber:
              safeString(
                item.accountNumber,
                100
              ),

            accountName:
              safeString(
                item.accountName,
                200
              ),

            description:
              safeString(
                item.description,
                1000
              )

          };

        }
      );

  wedding.music = {

    enabled:
      payload.musicEnabled ===
      true,

    url:
      safeString(
        payload.musicUrl,
        1000
      ),

    mediaId:
      safeString(
        payload.musicMediaId,
        100
      ),

    name:
      safeString(
        payload.musicName,
        200
      )

  };

  wedding.settings = {

    showCountdown:
      payload.showCountdown !==
      false,

    showStory:
      payload.showStory !==
      false,

    showGallery:
      payload.showGallery !==
      false,

    showGift:
      payload.showGift !==
      false,

    showRsvp:
      payload.showRsvp !==
      false,

    showMusic:
      payload.showMusic !==
      false,

    bottomNavigation:
      payload.bottomNavigation !==
      false

  };

  wedding.updatedAt =
    nowISO();

  return wedding;

}


/* =========================================================
   COOKIE HELPERS
========================================================= */

function parseCookies(
  req
) {

  const cookieHeader =
    req.headers.cookie ||
    "";

  const cookies = {};

  cookieHeader
    .split(";")
    .forEach(
      function(part) {

        const index =
          part.indexOf(
            "="
          );

        if (
          index ===
          -1
        ) {

          return;

        }

        const key =
          part
            .substring(
              0,
              index
            )
            .trim();

        const value =
          part
            .substring(
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


/* =========================================================
   HMAC SESSION
========================================================= */

function base64UrlEncode(
  value
) {

  return Buffer
    .from(
      value
    )
    .toString(
      "base64"
    )
    .replace(
      /\+/g,
      "-"
    )
    .replace(
      /\//g,
      "_"
    )
    .replace(
      /=+$/,
      ""
    );

}


function base64UrlDecode(
  value
) {

  try {

    const normalized =
      value
        .replace(
          /-/g,
          "+"
        )
        .replace(
          /_/g,
          "/"
        );

    const padding =
      normalized.length %
      4;

    const padded =
      normalized +
      (
        padding
          ? "=".repeat(
              4 - padding
            )
          : ""
      );

    return Buffer
      .from(
        padded,
        "base64"
      )
      .toString(
        "utf8"
      );

  } catch {

    return null;

  }

}


function signValue(
  value
) {

  return crypto
    .createHmac(
      "sha256",
      SESSION_SECRET
    )
    .update(
      value
    )
    .digest(
      "base64url"
    );

}


function createAdminSession() {

  const csrf =
    crypto
      .randomBytes(
        24
      )
      .toString(
        "hex"
      );

  const payload = {

    username:
      ADMIN_USERNAME,

    csrf:
      csrf,

    exp:
      Date.now() +
      (
        8 *
        60 *
        60 *
        1000
      )

  };

  const encoded =
    base64UrlEncode(
      JSON.stringify(
        payload
      )
    );

  const signature =
    signValue(
      encoded
    );

  return {

    token:
      encoded +
      "." +
      signature,

    csrf:
      csrf

  };

}


function verifyAdminSession(
  token
) {

  if (
    !token ||
    !SESSION_SECRET
  ) {

    return null;

  }

  const parts =
    token.split(
      "."
    );

  if (
    parts.length !==
    2
  ) {

    return null;

  }

  const encoded =
    parts[0];

  const signature =
    parts[1];

  const expected =
    signValue(
      encoded
    );

  try {

    const a =
      Buffer.from(
        signature
      );

    const b =
      Buffer.from(
        expected
      );

    if (
      a.length !==
      b.length
    ) {

      return null;

    }

    if (
      !crypto.timingSafeEqual(
        a,
        b
      )
    ) {

      return null;

    }

  } catch {

    return null;

  }

  const decoded =
    base64UrlDecode(
      encoded
    );

  if (!decoded) {

    return null;

  }

  let payload;

  try {

    payload =
      JSON.parse(
        decoded
      );

  } catch {

    return null;

  }

  if (
    !payload.exp ||
    payload.exp <
      Date.now()
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


function getSession(
  req
) {

  const cookies =
    parseCookies(
      req
    );

  return verifyAdminSession(
    cookies.lf_admin
  );

}


function requireAdmin(
  req,
  res,
  next
) {

  const session =
    getSession(
      req
    );

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
  req
) {

  const session =
    req.adminSession ||
    getSession(
      req
    );

  if (!session) {

    return false;

  }

  const token =
    req.body?._csrf ||
    req.headers[
      "x-csrf-token"
    ];

  if (!token) {

    return false;

  }

  const a =
    Buffer.from(
      String(
        token
      )
    );

  const b =
    Buffer.from(
      String(
        session.csrf
      )
    );

  if (
    a.length !==
    b.length
  ) {

    return false;

  }

  try {

    return crypto.timingSafeEqual(
      a,
      b
    );

  } catch {

    return false;

  }

}


/* =========================================================
   RATE LIMIT
========================================================= */

async function checkRateLimit(
  key,
  max,
  windowSeconds
) {

  if (!redis) {

    return true;

  }

  const count =
    await redis.incr(
      key
    );

  if (
    count ===
    1
  ) {

    await redis.expire(
      key,
      windowSeconds
    );

  }

  return (
    count <=
    max
  );

}


function getClientIp(
  req
) {

  const forwarded =
    req.headers[
      "x-forwarded-for"
    ];

  if (
    forwarded
  ) {

    return forwarded
      .split(",")[0]
      .trim();

  }

  return (
    req.socket?.remoteAddress ||
    "unknown"
  );

}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async function(
    req,
    res
  ) {

    try {

      if (!redis) {

        return res
          .status(500)
          .json({

            status:
              "error",

            redis:
              false

          });

      }

      await redis.set(
        "health:lastCheck",
        nowISO()
      );

      return res.json({

        status:
          "ok",

        redis:
          true

      });

    } catch (
      error
    ) {

      console.error(
        "Health error:",
        error
      );

      return res
        .status(500)
        .json({

          status:
            "error",

          redis:
            false

        });

    }

  }
);


/* =========================================================
   LANDING PAGE
========================================================= */

app.get(
  "/",
  async function(
    req,
    res
  ) {

    try {

      const slugs =
        await getWeddingSlugs();

      const weddings = [];

      for (
        const slug of slugs
      ) {

        const wedding =
          await getWedding(
            slug
          );

        if (
          wedding &&
          wedding.status ===
            "published"
        ) {

          weddings.push(
            wedding
          );

        }

      }

      return res.render(
        "index",
        {
          weddings
        }
      );

    } catch (
      error
    ) {

      console.error(
        "Landing error:",
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


/* =========================================================
   ADMIN LOGIN PAGE
========================================================= */

app.get(
  "/admin/login",
  function(
    req,
    res
  ) {

    const session =
      getSession(
        req
      );

    if (session) {

      return res.redirect(
        "/admin"
      );

    }

    return res.render(
      "login",
      {

        error:
          null,

        csrfToken:
          ""

      }
    );

  }
);


/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/admin/login",
  async function(
    req,
    res
  ) {

    try {

      const ip =
        getClientIp(
          req
        );

      const allowed =
        await checkRateLimit(
          `rate:login:${ip}`,
          5,
          15 * 60
        );

      if (!allowed) {

        return res
          .status(429)
          .render(
            "login",
            {

              error:
                "Terlalu banyak percobaan login. Silakan coba lagi nanti.",

              csrfToken:
                ""

            }
          );

      }

      const username =
        safeString(
          req.body.username,
          100
        );

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !ADMIN_USERNAME ||
        !ADMIN_PASSWORD ||
        !SESSION_SECRET
      ) {

        return res
          .status(500)
          .render(
            "login",
            {

              error:
                "ADMIN_USERNAME, ADMIN_PASSWORD atau SESSION_SECRET belum dikonfigurasi.",

              csrfToken:
                ""

            }
          );

      }

      const usernameBuffer =
        Buffer.from(
          username
        );

      const expectedUsername =
        Buffer.from(
          ADMIN_USERNAME
        );

      const passwordBuffer =
        Buffer.from(
          password
        );

      const expectedPassword =
        Buffer.from(
          ADMIN_PASSWORD
        );

      const usernameValid =
        usernameBuffer.length ===
          expectedUsername.length &&
        crypto.timingSafeEqual(
          usernameBuffer,
          expectedUsername
        );

      const passwordValid =
        passwordBuffer.length ===
          expectedPassword.length &&
        crypto.timingSafeEqual(
          passwordBuffer,
          expectedPassword
        );

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

              csrfToken:
                ""

            }
          );

      }

      const session =
        createAdminSession();

      const secure =
        process.env.NODE_ENV ===
        "production"
          ? "; Secure"
          : "";

      res.setHeader(
        "Set-Cookie",
        [
          `lf_admin=${encodeURIComponent(
            session.token
          )}`,
          "HttpOnly",
          "Path=/",
          "SameSite=Lax",
          "Max-Age=28800",
          secure
        ]
          .filter(Boolean)
          .join("; ")
      );

      return res.redirect(
        "/admin"
      );

    } catch (
      error
    ) {

      console.error(
        "Login error:",
        error
      );

      return res
        .status(500)
        .render(
          "login",
          {

            error:
              "Login gagal diproses.",

            csrfToken:
              ""

          }
        );

    }

  }
);


/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/admin/logout",
  requireAdmin,
  function(
    req,
    res
  ) {

    if (
      !verifyCsrf(
        req
      )
    ) {

      return res
        .status(403)
        .send(
          "CSRF token tidak valid."
        );

    }

    res.setHeader(
      "Set-Cookie",
      [
        "lf_admin=",
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        "Max-Age=0"
      ].join("; ")
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
  async function(
    req,
    res
  ) {

    try {

      const slugs =
        await getWeddingSlugs();

      const weddings = [];

      for (
        const slug of slugs
      ) {

        const wedding =
          await getWedding(
            slug
          );

        if (!wedding) {

          continue;

        }

        let rsvps =
          await redis.get(
            rsvpKey(
              slug
            )
          );

        if (
          !Array.isArray(
            rsvps
          )
        ) {

          rsvps = [];

        }

        const stats = {

          total:
            rsvps.length,

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
              function(
                total,
                item
              ) {

                return (
                  total +
                  Number(
                    item.guestCount ||
                      0
                  )
                );

              },
              0
            )

        };

        weddings.push({

          ...wedding,

          stats

        });

      }

      /*
         JSON aman untuk ditanam
         ke JavaScript admin.ejs.
      */

      const weddingsJson =
        JSON.stringify(
          weddings
        )
          .replace(
            /</g,
            "\\u003c"
          )
          .replace(
            />/g,
            "\\u003e"
          )
          .replace(
            /&/g,
            "\\u0026"
          );

      return res.render(
        "admin",
        {

          weddings,

          weddingsJson,

          csrfToken:
            req.adminSession.csrf

        }
      );

    } catch (
      error
    ) {

      console.error(
        "Dashboard error:",
        error
      );

      return res
        .status(500)
        .send(
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
  async function(
    req,
    res
  ) {

    try {

      if (
        !verifyCsrf(
          req
        )
      ) {

        return res
          .status(403)
          .json({

            success:
              false,

            message:
              "CSRF token tidak valid."

          });

      }

      const payload =
        req.body ||
        {};

      const slug =
        normalizeSlug(
          payload.slug
        );

      if (
        !isValidSlug(
          slug
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Slug tidak valid. Gunakan 3-100 karakter huruf kecil, angka dan tanda -."

          });

      }

      const existing =
        await getWedding(
          slug
        );

      if (existing) {

        return res
          .status(409)
          .json({

            success:
              false,

            message:
              "Slug sudah digunakan."

          });

      }

      const wedding =
        buildWeddingFromPayload(
          payload
        );

      wedding.id =
        createId(
          "wedding"
        );

      wedding.slug =
        slug;

      wedding.createdAt =
        nowISO();

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      const slugs =
        await getWeddingSlugs();

      if (
        !slugs.includes(
          slug
        )
      ) {

        slugs.push(
          slug
        );

        await saveWeddingSlugs(
          slugs
        );

      }

      return res.json({

        success:
          true,

        message:
          "Wedding berhasil dibuat.",

        wedding

      });

    } catch (
      error
    ) {

      console.error(
        "Create wedding error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "Gagal membuat wedding."

        });

    }

  }
);


/* =========================================================
   GET WEDDING DATA FOR EDIT
========================================================= */

app.get(
  "/admin/wedding/:slug/data",
  requireAdmin,
  async function(
    req,
    res
  ) {

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

            success:
              false,

            message:
              "Wedding tidak ditemukan."

          });

      }

      return res.json({

        success:
          true,

        wedding

      });

    } catch (
      error
    ) {

      console.error(
        "Wedding data error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "Gagal mengambil wedding."

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
  async function(
    req,
    res
  ) {

    try {

      if (
        !verifyCsrf(
          req
        )
      ) {

        return res
          .status(403)
          .json({

            success:
              false,

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

        return res
          .status(404)
          .json({

            success:
              false,

            message:
              "Wedding tidak ditemukan."

          });

      }

      const newSlug =
        normalizeSlug(
          req.body.slug ||
            oldSlug
        );

      if (
        !isValidSlug(
          newSlug
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Slug baru tidak valid."

          });

      }

      if (
        newSlug !==
        oldSlug
      ) {

        const duplicate =
          await getWedding(
            newSlug
          );

        if (duplicate) {

          return res
            .status(409)
            .json({

              success:
                false,

              message:
                "Slug baru sudah digunakan."

            });

        }

      }

      const payload =
        req.body;

      const wedding =
        buildWeddingFromPayload(
          payload,
          existing
        );

      wedding.slug =
        newSlug;

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      if (
        newSlug !==
        oldSlug
      ) {

        await redis.del(
          weddingKey(
            oldSlug
          )
        );

        /*
           Pindahkan RSVP.
        */

        const oldRsvps =
          await redis.get(
            rsvpKey(
              oldSlug
            )
          );

        if (
          oldRsvps
        ) {

          await redis.set(
            rsvpKey(
              newSlug
            ),
            oldRsvps
          );

          await redis.del(
            rsvpKey(
              oldSlug
            )
          );

        }

        /*
           Media lama tetap perlu
           dipindahkan secara logical.
           Media key menggunakan slug,
           sehingga media lama harus
           disalin.
        */

        const mediaRefs = [];

        if (
          wedding.coverImage?.mediaId
        ) {

          mediaRefs.push(
            wedding.coverImage
              .mediaId
          );

        }

        if (
          wedding.groom?.photo?.mediaId
        ) {

          mediaRefs.push(
            wedding.groom.photo
              .mediaId
          );

        }

        if (
          wedding.bride?.photo?.mediaId
        ) {

          mediaRefs.push(
            wedding.bride.photo
              .mediaId
          );

        }

        for (
          const image of
          asArray(
            wedding.gallery
          )
        ) {

          if (
            image?.mediaId
          ) {

            mediaRefs.push(
              image.mediaId
            );

          }

        }

        if (
          wedding.music?.mediaId
        ) {

          mediaRefs.push(
            wedding.music.mediaId
          );

        }

        for (
          const mediaId of
          [
            ...new Set(
              mediaRefs
            )
          ]
        ) {

          const oldMedia =
            await redis.get(
              mediaKey(
                oldSlug,
                mediaId
              )
            );

          if (
            oldMedia
          ) {

            oldMedia.slug =
              newSlug;

            await redis.set(
              mediaKey(
                newSlug,
                mediaId
              ),
              oldMedia
            );

            await redis.del(
              mediaKey(
                oldSlug,
                mediaId
              )
            );

          }

        }

        const slugs =
          await getWeddingSlugs();

        const index =
          slugs.indexOf(
            oldSlug
          );

        if (
          index !==
          -1
        ) {

          slugs[
            index
          ] =
            newSlug;

        } else {

          slugs.push(
            newSlug
          );

        }

        await saveWeddingSlugs(
          slugs
        );

      }

      return res.json({

        success:
          true,

        message:
          "Wedding berhasil diperbarui.",

        wedding

      });

    } catch (
      error
    ) {

      console.error(
        "Update wedding error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "Gagal memperbarui wedding."

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
  async function(
    req,
    res
  ) {

    try {

      if (
        !verifyCsrf(
          req
        )
      ) {

        return res
          .status(403)
          .json({

            success:
              false,

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

        return res
          .status(404)
          .json({

            success:
              false,

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

        success:
          true,

        message:
          "Wedding berhasil dipublish."

      });

    } catch (
      error
    ) {

      console.error(
        "Publish error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "Gagal publish wedding."

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
  async function(
    req,
    res
  ) {

    try {

      if (
        !verifyCsrf(
          req
        )
      ) {

        return res
          .status(403)
          .json({

            success:
              false,

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

        return res
          .status(404)
          .json({

            success:
              false,

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

        success:
          true,

        message:
          "Wedding dikembalikan menjadi draft."

      });

    } catch (
      error
    ) {

      console.error(
        "Unpublish error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "Gagal mengubah status wedding."

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
  async function(
    req,
    res
  ) {

    try {

      if (
        !verifyCsrf(
          req
        )
      ) {

        return res
          .status(403)
          .json({

            success:
              false,

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

        return res
          .status(404)
          .json({

            success:
              false,

            message:
              "Wedding tidak ditemukan."

          });

      }

      /*
         Hapus media.
      */

      const mediaIds = [];

      if (
        wedding.coverImage?.mediaId
      ) {

        mediaIds.push(
          wedding.coverImage
            .mediaId
        );

      }

      if (
        wedding.groom?.photo?.mediaId
      ) {

        mediaIds.push(
          wedding.groom.photo
            .mediaId
        );

      }

      if (
        wedding.bride?.photo?.mediaId
      ) {

        mediaIds.push(
          wedding.bride.photo
            .mediaId
        );

      }

      for (
        const image of
        asArray(
          wedding.gallery
        )
      ) {

        if (
          image?.mediaId
        ) {

          mediaIds.push(
            image.mediaId
          );

        }

      }

      if (
        wedding.music?.mediaId
      ) {

        mediaIds.push(
          wedding.music.mediaId
        );

      }

      for (
        const mediaId of
        [
          ...new Set(
            mediaIds
          )
        ]
      ) {

        await deleteMedia(
          slug,
          mediaId
        );

      }

      await deleteWeddingRedis(
        slug
      );

      const slugs =
        await getWeddingSlugs();

      const filtered =
        slugs.filter(
          item =>
            item !==
            slug
        );

      await saveWeddingSlugs(
        filtered
      );

      return res.json({

        success:
          true,

        message:
          "Wedding berhasil dihapus."

      });

    } catch (
      error
    ) {

      console.error(
        "Delete wedding error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "Gagal menghapus wedding."

        });

    }

  }
);


/* =========================================================
   MEDIA UPLOAD
========================================================= */

app.post(
  "/admin/wedding/:slug/media",
  requireAdmin,
  async function(
    req,
    res
  ) {

    try {

      if (
        !verifyCsrf(
          req
        )
      ) {

        return res
          .status(403)
          .json({

            success:
              false,

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

        return res
          .status(404)
          .json({

            success:
              false,

            message:
              "Wedding tidak ditemukan."

          });

      }

      const {
        data,
        mime,
        name,
        caption,
        kind,
        role
      } =
        req.body;

      const media =
        await saveMedia(
          slug,
          {
            data,
            mime,
            name,
            caption,
            kind
          }
        );

      const ref = {

        mediaId:
          media.id,

        mime:
          media.mime,

        name:
          media.name,

        caption:
          media.caption,

        size:
          media.size

      };

      /*
         ROLE COVER
      */

      if (
        role ===
        "cover"
      ) {

        const old =
          wedding.coverImage;

        wedding.coverImage =
          ref;

        if (
          old?.mediaId
        ) {

          await deleteMedia(
            slug,
            old.mediaId
          );

        }

      }


      /*
         ROLE GROOM
      */

      else if (
        role ===
        "groom"
      ) {

        const old =
          wedding.groom?.photo;

        wedding.groom =
          wedding.groom ||
          {};

        wedding.groom.photo =
          ref;

        if (
          old?.mediaId
        ) {

          await deleteMedia(
            slug,
            old.mediaId
          );

        }

      }


      /*
         ROLE BRIDE
      */

      else if (
        role ===
        "bride"
      ) {

        const old =
          wedding.bride?.photo;

        wedding.bride =
          wedding.bride ||
          {};

        wedding.bride.photo =
          ref;

        if (
          old?.mediaId
        ) {

          await deleteMedia(
            slug,
            old.mediaId
          );

        }

      }


      /*
         ROLE MUSIC
      */

      else if (
        role ===
        "music"
      ) {

        const old =
          wedding.music?.mediaId;

        wedding.music =
          wedding.music ||
          {};

        wedding.music.enabled =
          true;

        wedding.music.mediaId =
          media.id;

        wedding.music.url =
          `/media/${encodeURIComponent(
            slug
          )}/${encodeURIComponent(
            media.id
          )}`;

        wedding.music.name =
          media.name;

        if (
          old &&
          old !==
            media.id
        ) {

          await deleteMedia(
            slug,
            old
          );

        }

      }


      /*
         ROLE GALLERY
      */

      else if (
        role ===
        "gallery"
      ) {

        wedding.gallery =
          asArray(
            wedding.gallery
          );

        if (
          wedding.gallery.length >=
          MAX_GALLERY_IMAGES
        ) {

          await deleteMedia(
            slug,
            media.id
          );

          return res
            .status(400)
            .json({

              success:
                false,

              message:
                `Gallery maksimal ${MAX_GALLERY_IMAGES} gambar.`

            });

        }

        wedding.gallery.push(
          ref
        );

      }


      else {

        await deleteMedia(
          slug,
          media.id
        );

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Role media tidak valid."

          });

      }

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      return res.json({

        success:
          true,

        message:
          "Media berhasil disimpan ke Upstash Redis.",

        media,

        wedding

      });

    } catch (
      error
    ) {

      console.error(
        "Media upload error:",
        error
      );

      return res
        .status(400)
        .json({

          success:
            false,

          message:
            error.message ||
            "Upload media gagal."

        });

    }

  }
);


/* =========================================================
   MEDIA DELETE
========================================================= */

app.delete(
  "/admin/wedding/:slug/media/:mediaId",
  requireAdmin,
  async function(
    req,
    res
  ) {

    try {

      if (
        !verifyCsrf(
          req
        )
      ) {

        return res
          .status(403)
          .json({

            success:
              false,

            message:
              "CSRF token tidak valid."

          });

      }

      const slug =
        normalizeSlug(
          req.params.slug
        );

      const mediaId =
        safeString(
          req.params.mediaId,
          100
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {

        return res
          .status(404)
          .json({

            success:
              false,

            message:
              "Wedding tidak ditemukan."

          });

      }

      wedding.gallery =
        asArray(
          wedding.gallery
        ).filter(
          item =>
            item?.mediaId !==
            mediaId
        );

      if (
        wedding.coverImage
          ?.mediaId ===
        mediaId
      ) {

        wedding.coverImage =
          null;

      }

      if (
        wedding.groom
          ?.photo
          ?.mediaId ===
        mediaId
      ) {

        wedding.groom.photo =
          null;

      }

      if (
        wedding.bride
          ?.photo
          ?.mediaId ===
        mediaId
      ) {

        wedding.bride.photo =
          null;

      }

      if (
        wedding.music
          ?.mediaId ===
        mediaId
      ) {

        wedding.music.mediaId =
          "";

        wedding.music.url =
          "";

        wedding.music.name =
          "";

        wedding.music.enabled =
          false;

      }

      await deleteMedia(
        slug,
        mediaId
      );

      wedding.updatedAt =
        nowISO();

      await saveWedding(
        wedding
      );

      return res.json({

        success:
          true,

        message:
          "Media berhasil dihapus."

      });

    } catch (
      error
    ) {

      console.error(
        "Delete media error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "Gagal menghapus media."

        });

    }

  }
);


/* =========================================================
   MEDIA DELIVERY
========================================================= */

app.get(
  "/media/:slug/:mediaId",
  async function(
    req,
    res
  ) {

    try {

      const slug =
        normalizeSlug(
          req.params.slug
        );

      const mediaId =
        safeString(
          req.params.mediaId,
          100
        );

      const wedding =
        await getWedding(
          slug
        );

      if (!wedding) {

        return res
          .status(404)
          .send(
            "Media tidak ditemukan."
          );

      }

      /*
         Draft hanya dapat diakses
         jika Admin login.
      */

      if (
        wedding.status !==
        "published"
      ) {

        const session =
          getSession(
            req
          );

        if (!session) {

          return res
            .status(404)
            .send(
              "Media tidak ditemukan."
            );

        }

      }

      const media =
        await getMedia(
          slug,
          mediaId
        );

      if (!media) {

        return res
          .status(404)
          .send(
            "Media tidak ditemukan."
          );

      }

      const base64 =
        extractBase64(
          media.data
        );

      if (!base64) {

        return res
          .status(404)
          .send(
            "Data media rusak."
          );

      }

      const buffer =
        Buffer.from(
          base64,
          "base64"
        );

      res.setHeader(
        "Content-Type",
        media.mime ||
          "application/octet-stream"
      );

      res.setHeader(
        "Content-Length",
        buffer.length
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=86400"
      );

      return res.end(
        buffer
      );

    } catch (
      error
    ) {

      console.error(
        "Media delivery error:",
        error
      );

      return res
        .status(500)
        .send(
          "Media gagal diproses."
        );

    }

  }
);


/* =========================================================
   RSVP LIST
========================================================= */

app.get(
  "/admin/wedding/:slug/rsvp",
  requireAdmin,
  async function(
    req,
    res
  ) {

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

            success:
              false,

            message:
              "Wedding tidak ditemukan."

          });

      }

      let rsvps =
        await redis.get(
          rsvpKey(
            slug
          )
        );

      if (
        !Array.isArray(
          rsvps
        )
      ) {

        rsvps = [];

      }

      const stats = {

        total:
          rsvps.length,

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
            function(
              total,
              item
            ) {

              return (
                total +
                Number(
                  item.guestCount ||
                    0
                )
              );

            },
            0
          )

      };

      return res.json({

        success:
          true,

        total:
          rsvps.length,

        stats,

        rsvps

      });

    } catch (
      error
    ) {

      console.error(
        "RSVP list error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

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
  async function(
    req,
    res,
    next
  ) {

    /*
       Jangan biarkan route dynamic
       menangkap route system.
    */

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
          .render(
            "wedding",
            {

              wedding:
                null,

              guestName:
                "",

              notFound:
                true

            }
          );

      }

      const guestName =
        normalizeGuestName(
          req.query.to
        );

      /*
         URL media dibuat server-side
         supaya wedding.ejs tidak perlu
         menerima Base64 besar.
      */

      return res.render(
        "wedding",
        {

          wedding,

          guestName,

          notFound:
            false

        }
      );

    } catch (
      error
    ) {

      console.error(
        "Wedding page error:",
        error
      );

      return res
        .status(500)
        .render(
          "wedding",
          {

            wedding:
              null,

            guestName:
              "",

            notFound:
              false

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
  async function(
    req,
    res
  ) {

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

        return res
          .status(404)
          .json({

            success:
              false,

            message:
              "Wedding tidak ditemukan."

          });

      }

      const ip =
        getClientIp(
          req
        );

      const allowed =
        await checkRateLimit(
          `rate:rsvp:${slug}:${ip}`,
          10,
          10 * 60
        );

      if (!allowed) {

        return res
          .status(429)
          .json({

            success:
              false,

            message:
              "Terlalu banyak pengiriman RSVP. Silakan coba lagi nanti."

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
        name.length <
          2
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Nama wajib diisi."

          });

      }

      if (
        !validAttendance(
          attendance
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Pilihan kehadiran tidak valid."

          });

      }

      if (
        guestCount <
          1 ||
        guestCount >
          10
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Jumlah tamu harus antara 1-10."

          });

      }

      let existing =
        await redis.get(
          rsvpKey(
            slug
          )
        );

      if (
        !Array.isArray(
          existing
        )
      ) {

        existing = [];

      }

      if (
        existing.length >=
        MAX_RSVP
      ) {

        return res
          .status(429)
          .json({

            success:
              false,

            message:
              "RSVP untuk wedding ini sudah mencapai batas penyimpanan."

          });

      }

      const rsvp = {

        id:
          createId(
            "rsvp"
          ),

        name,

        attendance,

        guestCount,

        message,

        createdAt:
          nowISO(),

        guestNameFromUrl:
          normalizeGuestName(
            req.query.to
          )

      };

      existing.unshift(
        rsvp
      );

      await redis.set(
        rsvpKey(
          slug
        ),
        existing
      );

      return res.json({

        success:
          true,

        message:
          "Terima kasih, RSVP Anda telah diterima."

      });

    } catch (
      error
    ) {

      console.error(
        "RSVP error:",
        error
      );

      return res
        .status(500)
        .json({

          success:
            false,

          message:
            "RSVP gagal disimpan."

        });

    }

  }
);


/* =========================================================
   404
========================================================= */

app.use(
  function(
    req,
    res
  ) {

    return res
      .status(404)
      .send(
        `
        <!DOCTYPE html>
        <html lang="id">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>404 — LOVEFOREVER</title>
          <style>
            body{
              margin:0;
              min-height:100vh;
              display:grid;
              place-items:center;
              background:#f7f2ec;
              color:#2d2926;
              font-family:Arial,sans-serif;
              text-align:center;
              padding:24px;
            }
            a{
              color:inherit;
            }
          </style>
        </head>
        <body>
          <main>
            <p>LOVEFOREVER</p>
            <h1>404</h1>
            <p>Halaman yang Anda cari tidak ditemukan.</p>
            <a href="/">Kembali ke halaman utama</a>
          </main>
        </body>
        </html>
        `
      );

  }
);


/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  function(
    error,
    req,
    res,
    next
  ) {

    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }

    return res
      .status(500)
      .send(
        "Terjadi kesalahan pada server."
      );

  }
);


/* =========================================================
   VERCEL EXPORT
========================================================= */

module.exports =
  app;


/*
   Local development only.
*/

if (
  require.main ===
  module
) {

  app.listen(
    PORT,
    function() {

      console.log(
        `LOVEFOREVER running on port ${PORT}`
      );

    }
  );

}
