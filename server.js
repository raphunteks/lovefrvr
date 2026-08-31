require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Redis } = require("@upstash/redis");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const MAX_BODY_SIZE = "50mb";
const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB (Bebas untuk semua gambar)
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // Diperbesar jadi 15MB
const MAX_GALLERY_IMAGES = 25; // Diperbesar jadi 25 foto
const MAX_WEDDING_TEXT = 5000;
const MAX_RSVP = 5000;
const RESERVED_SLUGS = ["admin", "login", "health", "api", "media", "favicon.ico", "robots.txt", "sitemap.xml"];

let redis = null;
if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY_SIZE }));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: process.env.NODE_ENV === "production" ? "7d" : 0
}));

app.use(function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-XSS-Protection", "0");
  next();
});

function nowISO() { return new Date().toISOString(); }
function createId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}
function safeString(value, maxLength = 1000) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\u0000/g, "").trim().slice(0, maxLength);
}
function normalizeSlug(value) {
  return safeString(value, 100).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function isValidSlug(slug) {
  if (!slug || slug.length < 3 || slug.length > 100) return false;
  if (!/^[a-z0-9-]+$/.test(slug)) return false;
  return !RESERVED_SLUGS.includes(slug);
}
function normalizeGuestName(value) { return safeString(value, 150); }
function validAttendance(value) { return ["hadir", "tidak_hadir", "masih_menentukan", "ragu", "tidak_menentukan"].includes(value); }
function parseInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function weddingKey(slug) { return `wedding:${slug}`; }
function rsvpKey(slug) { return `rsvp:${slug}`; }
function mediaKey(slug, mediaId) { return `wedding:${slug}:media:${mediaId}`; }
const WEDDING_INDEX_KEY = "weddings";

async function getWedding(slug) {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  return await redis.get(weddingKey(slug));
}
async function saveWedding(wedding) {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  await redis.set(weddingKey(wedding.slug), wedding);
  return wedding;
}
async function deleteWeddingRedis(slug) {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  await redis.del(weddingKey(slug));
  await redis.del(rsvpKey(slug));
}
async function getWeddingSlugs() {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  let slugs = await redis.get(WEDDING_INDEX_KEY);
  if (!Array.isArray(slugs)) slugs = [];
  return slugs.map(normalizeSlug).filter(Boolean);
}
async function saveWeddingSlugs(slugs) {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  const unique = [...new Set(slugs)];
  await redis.set(WEDDING_INDEX_KEY, unique);
  return unique;
}

function createDefaultWedding() {
  const timestamp = nowISO();
  return {
    id: createId("wedding"),
    slug: "",
    status: "draft",
    groom: { name: "", fullName: "", photo: null, parents: "", instagram: "" },
    bride: { name: "", fullName: "", photo: null, parents: "", instagram: "" },
    coverImage: null,
    opening: {
      enabled: true,
      eyebrow: "ASSALAMU'ALAIKUM WARAHMATULLAHI WABARAKATUH",
      title: "Dengan Penuh Rasa Syukur & Bahagia",
      text: "Merupakan suatu kehormatan dan kebahagiaan bagi kami sekeluarga apabila Bapak/Ibu/Saudara/i berkenan hadir dan memberikan doa restu pada hari pernikahan kami.",
      button: "BUKA UNDANGAN"
    },
    quote: { text: "", source: "" },
    date: "",
    timezone: "Asia/Jakarta",
    events: [],
    story: [],
    gallery: [],
    gift: { text: "", bankName: "", accountNumber: "", accountName: "", address: "" },
    music: { enabled: false, url: "", mediaId: "", name: "" },
    theme: { background: "#fbf9f5", accent: "#8a735c", text: "#2b2623", muted: "#787068" },
    settings: {
      showCountdown: true,
      showStory: true,
      showGallery: true,
      showGift: true,
      showRSVP: true,
      bottomNavigation: true
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function asArray(value) { return Array.isArray(value) ? value : []; }

function extractBase64(data) {
  if (typeof data !== "string") return null;
  const comma = data.indexOf(",");
  return comma === -1 ? null : data.substring(comma + 1);
}
function estimateBase64Bytes(data) {
  const base64 = extractBase64(data);
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
function validImageMime(mime) { return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime); }
function validAudioMime(mime) { return ["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg"].includes(mime); }

function normalizeMediaRef(value) {
  if (!value) return null;
  if (typeof value === "object" && typeof value.data === "string") {
    return { legacy: true, data: value.data, mime: value.mime || "image/jpeg", caption: value.caption || "" };
  }
  if (typeof value === "object" && value.mediaId) {
    return {
      mediaId: safeString(value.mediaId, 100),
      mime: safeString(value.mime, 100),
      name: safeString(value.name, 200),
      caption: safeString(value.caption, 200),
      size: Number(value.size || 0),
      url: value.url || `/media/${value.slug || 'slug'}/${value.mediaId}`
    };
  }
  return null;
}

async function saveMedia(slug, { data, mime, name, caption, kind, role }) {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  if (typeof data !== "string" || !data.startsWith("data:")) throw new Error("Format media Base64 tidak valid.");
  
  const bytes = estimateBase64Bytes(data);
  const isImage = validImageMime(mime);
  const isAudio = validAudioMime(mime);
  
  if (!isImage && !isAudio) throw new Error("Format media tidak didukung.");
  if (isAudio && bytes > MAX_AUDIO_BYTES) throw new Error(`Ukuran audio maksimal ${MAX_AUDIO_BYTES / (1024 * 1024)} MB.`);
  if (isImage && bytes > MAX_IMAGE_BYTES) throw new Error(`Ukuran gambar maksimal ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);

  const mediaId = createId("media");
  const record = {
    id: mediaId,
    slug: slug,
    kind: safeString(kind, 50),
    mime: safeString(mime, 100),
    name: safeString(name, 200),
    caption: safeString(caption, 200),
    size: bytes,
    data: data,
    createdAt: nowISO()
  };
  await redis.set(mediaKey(slug, mediaId), record);
  return { id: mediaId, mime: record.mime, name: record.name, caption: record.caption, size: record.size };
}

async function deleteMedia(slug, mediaId) {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  await redis.del(mediaKey(slug, mediaId));
}
async function getMedia(slug, mediaId) {
  if (!redis) throw new Error("Redis belum dikonfigurasi.");
  return await redis.get(mediaKey(slug, mediaId));
}

function buildWeddingFromPayload(payload, existing = null) {
  const wedding = existing || createDefaultWedding();
  wedding.status = payload.status === "published" ? "published" : "draft";
  
  const injectUrl = (ref) => {
    if (ref && ref.mediaId) ref.url = `/media/${payload.slug || existing.slug}/${ref.mediaId}`;
    return ref;
  };

  wedding.groom = {
    name: safeString(payload.groomName, 100),
    fullName: safeString(payload.groomFullName, 200),
    parents: safeString(payload.groomParents, 200),
    instagram: safeString(payload.groomInstagram, 100),
    photo: injectUrl(normalizeMediaRef(payload.groomPhoto))
  };
  wedding.bride = {
    name: safeString(payload.brideName, 100),
    fullName: safeString(payload.brideFullName, 200),
    parents: safeString(payload.brideParents, 200),
    instagram: safeString(payload.brideInstagram, 100),
    photo: injectUrl(normalizeMediaRef(payload.bridePhoto))
  };
  wedding.coverImage = injectUrl(normalizeMediaRef(payload.coverImage));
  wedding.opening = {
    enabled: payload.openingEnabled !== false,
    eyebrow: safeString(payload.openingEyebrow, 200) || "ASSALAMU'ALAIKUM WARAHMATULLAHI WABARAKATUH",
    title: safeString(payload.openingTitle, 200) || "Dengan Penuh Rasa Syukur & Bahagia",
    text: safeString(payload.openingText, 1000) || "Merupakan suatu kehormatan dan kebahagiaan bagi kami sekeluarga apabila Bapak/Ibu/Saudara/i berkenan hadir dan memberikan doa restu pada hari pernikahan kami.",
    button: safeString(payload.openingButton, 100) || "BUKA UNDANGAN"
  };
  wedding.quote = {
    text: safeString(payload.quoteText, MAX_WEDDING_TEXT),
    source: safeString(payload.quoteSource, 200)
  };
  wedding.date = safeString(payload.date, 100);
  wedding.timezone = safeString(payload.timezone, 100) || "Asia/Jakarta";
  wedding.events = asArray(payload.events).slice(0, 10).map(event => ({
    id: safeString(event.id, 100) || createId("event"),
    title: safeString(event.title, 200),
    date: safeString(event.date, 100),
    time: safeString(event.time, 100),
    venue: safeString(event.venue, 300),
    address: safeString(event.address, 1000),
    mapsUrl: safeString(event.mapsUrl, 1000)
  }));
  wedding.story = asArray(payload.story).slice(0, 20).map(item => ({
    id: safeString(item.id, 100) || createId("story"),
    year: safeString(item.year, 100),
    title: safeString(item.title, 200),
    text: safeString(item.text, 1500)
  }));
  wedding.gallery = asArray(payload.gallery).slice(0, MAX_GALLERY_IMAGES).map(normalizeMediaRef).filter(Boolean).map(injectUrl);
  wedding.gift = payload.gift ? {
    text: safeString(payload.gift.text, 1000),
    bankName: safeString(payload.gift.bankName, 100),
    accountNumber: safeString(payload.gift.accountNumber, 100),
    accountName: safeString(payload.gift.accountName, 200),
    address: safeString(payload.gift.address, 1000)
  } : null;
  wedding.music = {
    enabled: payload.musicEnabled === true,
    url: safeString(payload.musicUrl, 1000),
    mediaId: safeString(payload.musicMediaId, 100),
    name: safeString(payload.musicName, 200)
  };
  wedding.theme = {
    background: safeString(payload.themeBackground, 20) || "#fbf9f5",
    accent: safeString(payload.themeAccent, 20) || "#8a735c",
    text: safeString(payload.themeText, 20) || "#2b2623",
    muted: safeString(payload.themeMuted, 20) || "#787068"
  };
  wedding.settings = {
    showCountdown: payload.showCountdown !== false,
    showStory: payload.showStory !== false,
    showGallery: payload.showGallery !== false,
    showGift: payload.showGift !== false,
    showRSVP: payload.showRSVP !== false,
    bottomNavigation: payload.bottomNavigation !== false
  };
  wedding.updatedAt = nowISO();
  return wedding;
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = {};
  cookieHeader.split(";").forEach(part => {
    const index = part.indexOf("=");
    if (index === -1) return;
    const key = part.substring(0, index).trim();
    const value = part.substring(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4;
    const padded = normalized + (padding ? "=".repeat(4 - padding) : "");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}
function signValue(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function createAdminSession() {
  const csrf = crypto.randomBytes(24).toString("hex");
  const payload = { username: ADMIN_USERNAME, csrf: csrf, exp: Date.now() + (8 * 60 * 60 * 1000) };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = signValue(encoded);
  return { token: `${encoded}.${signature}`, csrf: csrf };
}
function verifyAdminSession(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const encoded = parts[0];
  const signature = parts[1];
  const expected = signValue(encoded);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  const decoded = base64UrlDecode(encoded);
  if (!decoded) return null;
  let payload;
  try { payload = JSON.parse(decoded); } catch { return null; }
  if (!payload.exp || payload.exp < Date.now() || payload.username !== ADMIN_USERNAME) return null;
  return payload;
}
function getSession(req) {
  const cookies = parseCookies(req);
  return verifyAdminSession(cookies.lf_admin);
}
function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.redirect("/admin/login");
  req.adminSession = session;
  next();
}
function verifyCsrf(req) {
  const session = req.adminSession || getSession(req);
  if (!session) return false;
  const token = req.body?._csrf || req.headers["x-csrf-token"];
  if (!token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(session.csrf));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

async function checkRateLimit(key, max, windowSeconds) {
  if (!redis) return true;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= max;
}
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

app.get("/health", async function(req, res) {
  try {
    if (!redis) return res.status(500).json({ status: "error", redis: false });
    await redis.set("health:lastCheck", nowISO());
    return res.json({ status: "ok", redis: true });
  } catch (error) {
    console.error("Health error:", error);
    return res.status(500).json({ status: "error", redis: false });
  }
});

app.get("/", async function(req, res) {
  try {
    const slugs = await getWeddingSlugs();
    const weddings = [];
    for (const slug of slugs) {
      const wedding = await getWedding(slug);
      if (wedding && wedding.status === "published") weddings.push(wedding);
    }
    return res.render("index", { weddings });
  } catch (error) {
    console.error("Landing error:", error);
    return res.status(500).send("Terjadi kesalahan server.");
  }
});

app.get("/admin/login", function(req, res) {
  const session = getSession(req);
  if (session) return res.redirect("/admin");
  return res.render("login", { error: null, csrfToken: "" });
});

app.post("/admin/login", async function(req, res) {
  try {
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(`rate:login:${ip}`, 5, 15 * 60);
    if (!allowed) {
      return res.status(429).render("login", { error: "Terlalu banyak percobaan login. Silakan coba lagi nanti.", csrfToken: "" });
    }
    const username = safeString(req.body.username, 100);
    const password = String(req.body.password || "");

    if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET) {
      return res.status(500).render("login", { error: "ADMIN_USERNAME, ADMIN_PASSWORD atau SESSION_SECRET belum dikonfigurasi.", csrfToken: "" });
    }

    const usernameBuffer = Buffer.from(username);
    const expectedUsername = Buffer.from(ADMIN_USERNAME);
    const passwordBuffer = Buffer.from(password);
    const expectedPassword = Buffer.from(ADMIN_PASSWORD);

    const usernameValid = usernameBuffer.length === expectedUsername.length && crypto.timingSafeEqual(usernameBuffer, expectedUsername);
    const passwordValid = passwordBuffer.length === expectedPassword.length && crypto.timingSafeEqual(passwordBuffer, expectedPassword);

    if (!usernameValid || !passwordValid) {
      return res.status(401).render("login", { error: "Username atau password salah.", csrfToken: "" });
    }

    const session = createAdminSession();
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", [`lf_admin=${encodeURIComponent(session.token)}`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=28800", secure].filter(Boolean).join("; "));
    return res.redirect("/admin");
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).render("login", { error: "Login gagal diproses.", csrfToken: "" });
  }
});

app.post("/admin/logout", requireAdmin, function(req, res) {
  if (!verifyCsrf(req)) return res.status(403).send("CSRF token tidak valid.");
  res.setHeader("Set-Cookie", ["lf_admin=", "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"].join("; "));
  return res.redirect("/admin/login");
});

app.get("/admin", requireAdmin, async function(req, res) {
  try {
    const slugs = await getWeddingSlugs();
    const weddings = [];
    for (const slug of slugs) {
      const wedding = await getWedding(slug);
      if (!wedding) continue;
      let rsvps = await redis.get(rsvpKey(slug));
      if (!Array.isArray(rsvps)) rsvps = [];
      const stats = {
        total: rsvps.length,
        hadir: rsvps.filter(x => x.attendance === "hadir").length,
        tidakHadir: rsvps.filter(x => x.attendance === "tidak_hadir").length,
        belumTentu: rsvps.filter(x => ["masih_menentukan","ragu","tidak_menentukan"].includes(x.attendance)).length,
        guestCount: rsvps.reduce((total, item) => total + Number(item.guestCount || 0), 0)
      };
      weddings.push({ ...wedding, stats });
    }
    const weddingsJson = JSON.stringify(weddings).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
    return res.render("admin", { weddings, weddingsJson, csrfToken: req.adminSession.csrf });
  } catch (error) {
    console.error("Dashboard error:", error);
    return res.status(500).send("Gagal membuka dashboard.");
  }
});

app.post("/admin/wedding/new", requireAdmin, async function(req, res) {
  try {
    if (!verifyCsrf(req)) return res.status(403).json({ success: false, message: "CSRF token tidak valid." });
    const payload = req.body || {};
    const slug = normalizeSlug(payload.slug);
    if (!isValidSlug(slug)) return res.status(400).json({ success: false, message: "Slug tidak valid. Gunakan 3-100 karakter huruf kecil, angka dan tanda -." });
    const existing = await getWedding(slug);
    if (existing) return res.status(409).json({ success: false, message: "Slug sudah digunakan." });

    const wedding = buildWeddingFromPayload(payload);
    wedding.id = createId("wedding");
    wedding.slug = slug;
    wedding.createdAt = nowISO();
    wedding.updatedAt = nowISO();

    await saveWedding(wedding);
    const slugs = await getWeddingSlugs();
    if (!slugs.includes(slug)) {
      slugs.push(slug);
      await saveWeddingSlugs(slugs);
    }
    return res.json({ success: true, message: "Wedding berhasil dibuat.", wedding });
  } catch (error) {
    console.error("Create wedding error:", error);
    return res.status(500).json({ success: false, message: "Gagal membuat wedding." });
  }
});

app.get("/admin/wedding/:slug/data", requireAdmin, async function(req, res) {
  try {
    const slug = normalizeSlug(req.params.slug);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });
    return res.json({ success: true, wedding });
  } catch (error) {
    console.error("Wedding data error:", error);
    return res.status(500).json({ success: false, message: "Gagal mengambil wedding." });
  }
});

app.post("/admin/wedding/:slug/edit", requireAdmin, async function(req, res) {
  try {
    if (!verifyCsrf(req)) return res.status(403).json({ success: false, message: "CSRF token tidak valid." });
    const oldSlug = normalizeSlug(req.params.slug);
    const existing = await getWedding(oldSlug);
    if (!existing) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });

    const newSlug = normalizeSlug(req.body.slug || oldSlug);
    if (!isValidSlug(newSlug)) return res.status(400).json({ success: false, message: "Slug baru tidak valid." });

    if (newSlug !== oldSlug) {
      const duplicate = await getWedding(newSlug);
      if (duplicate) return res.status(409).json({ success: false, message: "Slug baru sudah digunakan." });
    }

    const payload = req.body;
    const wedding = buildWeddingFromPayload(payload, existing);
    wedding.slug = newSlug;
    wedding.updatedAt = nowISO();

    await saveWedding(wedding);

    if (newSlug !== oldSlug) {
      await redis.del(weddingKey(oldSlug));
      const oldRsvps = await redis.get(rsvpKey(oldSlug));
      if (oldRsvps) {
        await redis.set(rsvpKey(newSlug), oldRsvps);
        await redis.del(rsvpKey(oldSlug));
      }

      const mediaRefs = [];
      if (wedding.coverImage?.mediaId) mediaRefs.push(wedding.coverImage.mediaId);
      if (wedding.groom?.photo?.mediaId) mediaRefs.push(wedding.groom.photo.mediaId);
      if (wedding.bride?.photo?.mediaId) mediaRefs.push(wedding.bride.photo.mediaId);
      for (const image of asArray(wedding.gallery)) {
        if (image?.mediaId) mediaRefs.push(image.mediaId);
      }
      if (wedding.music?.mediaId) mediaRefs.push(wedding.music.mediaId);

      for (const mediaId of [...new Set(mediaRefs)]) {
        const oldMedia = await redis.get(mediaKey(oldSlug, mediaId));
        if (oldMedia) {
          oldMedia.slug = newSlug;
          await redis.set(mediaKey(newSlug, mediaId), oldMedia);
          await redis.del(mediaKey(oldSlug, mediaId));
        }
      }

      const slugs = await getWeddingSlugs();
      const index = slugs.indexOf(oldSlug);
      if (index !== -1) slugs[index] = newSlug;
      else slugs.push(newSlug);
      await saveWeddingSlugs(slugs);
    }

    return res.json({ success: true, message: "Wedding berhasil diperbarui.", wedding });
  } catch (error) {
    console.error("Update wedding error:", error);
    return res.status(500).json({ success: false, message: "Gagal memperbarui wedding." });
  }
});

app.post("/admin/wedding/:slug/publish", requireAdmin, async function(req, res) {
  try {
    if (!verifyCsrf(req)) return res.status(403).json({ success: false, message: "CSRF token tidak valid." });
    const slug = normalizeSlug(req.params.slug);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });

    wedding.status = "published";
    wedding.updatedAt = nowISO();
    await saveWedding(wedding);
    return res.json({ success: true, message: "Wedding berhasil dipublish." });
  } catch (error) {
    console.error("Publish error:", error);
    return res.status(500).json({ success: false, message: "Gagal publish wedding." });
  }
});

app.post("/admin/wedding/:slug/unpublish", requireAdmin, async function(req, res) {
  try {
    if (!verifyCsrf(req)) return res.status(403).json({ success: false, message: "CSRF token tidak valid." });
    const slug = normalizeSlug(req.params.slug);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });

    wedding.status = "draft";
    wedding.updatedAt = nowISO();
    await saveWedding(wedding);
    return res.json({ success: true, message: "Wedding dikembalikan menjadi draft." });
  } catch (error) {
    console.error("Unpublish error:", error);
    return res.status(500).json({ success: false, message: "Gagal mengubah status wedding." });
  }
});

app.post("/admin/wedding/:slug/delete", requireAdmin, async function(req, res) {
  try {
    if (!verifyCsrf(req)) return res.status(403).json({ success: false, message: "CSRF token tidak valid." });
    const slug = normalizeSlug(req.params.slug);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });

    const mediaIds = [];
    if (wedding.coverImage?.mediaId) mediaIds.push(wedding.coverImage.mediaId);
    if (wedding.groom?.photo?.mediaId) mediaIds.push(wedding.groom.photo.mediaId);
    if (wedding.bride?.photo?.mediaId) mediaIds.push(wedding.bride.photo.mediaId);
    for (const image of asArray(wedding.gallery)) {
      if (image?.mediaId) mediaIds.push(image.mediaId);
    }
    if (wedding.music?.mediaId) mediaIds.push(wedding.music.mediaId);

    for (const mediaId of [...new Set(mediaIds)]) {
      await deleteMedia(slug, mediaId);
    }
    await deleteWeddingRedis(slug);
    const slugs = await getWeddingSlugs();
    const filtered = slugs.filter(item => item !== slug);
    await saveWeddingSlugs(filtered);
    return res.json({ success: true, message: "Wedding berhasil dihapus." });
  } catch (error) {
    console.error("Delete wedding error:", error);
    return res.status(500).json({ success: false, message: "Gagal menghapus wedding." });
  }
});

app.post("/admin/wedding/:slug/media", requireAdmin, async function(req, res) {
  try {
    if (!verifyCsrf(req)) return res.status(403).json({ success: false, message: "CSRF token tidak valid." });
    const slug = normalizeSlug(req.params.slug);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });

    const { data, mime, name, caption, kind, role } = req.body;
    
    // Save Media
    const media = await saveMedia(slug, { data, mime, name, caption, kind, role });
    
    const ref = { 
      mediaId: media.id, 
      mime: media.mime, 
      name: media.name, 
      caption: media.caption, 
      size: media.size,
      url: `/media/${encodeURIComponent(slug)}/${encodeURIComponent(media.id)}`
    };

    if (role === "cover") {
      const old = wedding.coverImage;
      wedding.coverImage = ref;
      if (old?.mediaId) await deleteMedia(slug, old.mediaId);
    } else if (role === "groom") {
      const old = wedding.groom?.photo;
      wedding.groom = wedding.groom || {};
      wedding.groom.photo = ref;
      if (old?.mediaId) await deleteMedia(slug, old.mediaId);
    } else if (role === "bride") {
      const old = wedding.bride?.photo;
      wedding.bride = wedding.bride || {};
      wedding.bride.photo = ref;
      if (old?.mediaId) await deleteMedia(slug, old.mediaId);
    } else if (role === "music") {
      const old = wedding.music?.mediaId;
      wedding.music = wedding.music || {};
      wedding.music.enabled = true;
      wedding.music.mediaId = media.id;
      wedding.music.url = `/media/${encodeURIComponent(slug)}/${encodeURIComponent(media.id)}`;
      wedding.music.name = media.name;
      if (old && old !== media.id) await deleteMedia(slug, old);
    } else if (role === "gallery") {
      wedding.gallery = asArray(wedding.gallery);
      if (wedding.gallery.length >= MAX_GALLERY_IMAGES) {
        await deleteMedia(slug, media.id);
        return res.status(400).json({ success: false, message: `Gallery maksimal ${MAX_GALLERY_IMAGES} gambar.` });
      }
      wedding.gallery.push(ref);
    } else {
      await deleteMedia(slug, media.id);
      return res.status(400).json({ success: false, message: "Role media tidak valid." });
    }

    wedding.updatedAt = nowISO();
    await saveWedding(wedding);
    return res.json({ success: true, message: "Media berhasil disimpan ke Upstash Redis.", media, wedding });
  } catch (error) {
    console.error("Media upload error:", error);
    return res.status(400).json({ success: false, message: error.message || "Upload media gagal." });
  }
});

app.delete("/admin/wedding/:slug/media/:mediaId", requireAdmin, async function(req, res) {
  try {
    if (!verifyCsrf(req)) return res.status(403).json({ success: false, message: "CSRF token tidak valid." });
    const slug = normalizeSlug(req.params.slug);
    const mediaId = safeString(req.params.mediaId, 100);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });

    wedding.gallery = asArray(wedding.gallery).filter(item => item?.mediaId !== mediaId);
    if (wedding.coverImage?.mediaId === mediaId) wedding.coverImage = null;
    if (wedding.groom?.photo?.mediaId === mediaId) wedding.groom.photo = null;
    if (wedding.bride?.photo?.mediaId === mediaId) wedding.bride.photo = null;
    if (wedding.music?.mediaId === mediaId) {
      wedding.music.mediaId = "";
      wedding.music.url = "";
      wedding.music.name = "";
      wedding.music.enabled = false;
    }

    await deleteMedia(slug, mediaId);
    wedding.updatedAt = nowISO();
    await saveWedding(wedding);
    return res.json({ success: true, message: "Media berhasil dihapus." });
  } catch (error) {
    console.error("Delete media error:", error);
    return res.status(500).json({ success: false, message: "Gagal menghapus media." });
  }
});

app.get("/media/:slug/:mediaId", async function(req, res) {
  try {
    const slug = normalizeSlug(req.params.slug);
    const mediaId = safeString(req.params.mediaId, 100);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).send("Media tidak ditemukan.");

    if (wedding.status !== "published") {
      const session = getSession(req);
      if (!session) return res.status(404).send("Media tidak ditemukan.");
    }

    const media = await getMedia(slug, mediaId);
    if (!media) return res.status(404).send("Media tidak ditemukan.");

    const base64 = extractBase64(media.data);
    if (!base64) return res.status(404).send("Data media rusak.");

    const buffer = Buffer.from(base64, "base64");
    res.setHeader("Content-Type", media.mime || "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end(buffer);
  } catch (error) {
    console.error("Media delivery error:", error);
    return res.status(500).send("Media gagal diproses.");
  }
});

app.get("/admin/wedding/:slug/rsvp", requireAdmin, async function(req, res) {
  try {
    const slug = normalizeSlug(req.params.slug);
    const wedding = await getWedding(slug);
    if (!wedding) return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });

    let rsvps = await redis.get(rsvpKey(slug));
    if (!Array.isArray(rsvps)) rsvps = [];

    const stats = {
      total: rsvps.length,
      hadir: rsvps.filter(x => x.attendance === "hadir").length,
      tidakHadir: rsvps.filter(x => x.attendance === "tidak_hadir").length,
      belumTentu: rsvps.filter(x => ["masih_menentukan","ragu","tidak_menentukan"].includes(x.attendance)).length,
      guestCount: rsvps.reduce((total, item) => total + Number(item.guestCount || 0), 0)
    };
    return res.json({ success: true, total: rsvps.length, stats, rsvps });
  } catch (error) {
    console.error("RSVP list error:", error);
    return res.status(500).json({ success: false, message: "Gagal mengambil RSVP." });
  }
});

app.get("/api/weddings/:slug/rsvp", async function(req, res) {
  return res.status(405).json({ success: false, message: "Method Not Allowed. Use POST."});
});

app.get("/:slug", async function(req, res, next) {
  const slug = normalizeSlug(req.params.slug);
  if (RESERVED_SLUGS.includes(slug)) return next();
  try {
    const wedding = await getWedding(slug);
    if (!wedding || wedding.status !== "published") {
      return res.status(404).render("wedding", { wedding: null, guestName: "", notFound: true });
    }
    const guestName = normalizeGuestName(req.query.to);
    return res.render("wedding", { wedding, guestName, notFound: false });
  } catch (error) {
    console.error("Wedding page error:", error);
    return res.status(500).render("wedding", { wedding: null, guestName: "", notFound: false });
  }
});

app.post("/api/weddings/:slug/rsvp", async function(req, res) {
  try {
    const slug = normalizeSlug(req.params.slug);
    const wedding = await getWedding(slug);
    if (!wedding || wedding.status !== "published") {
      return res.status(404).json({ success: false, message: "Wedding tidak ditemukan." });
    }

    const ip = getClientIp(req);
    const allowed = await checkRateLimit(`rate:rsvp:${slug}:${ip}`, 10, 10 * 60);
    if (!allowed) {
      return res.status(429).json({ success: false, message: "Terlalu banyak pengiriman RSVP. Silakan coba lagi nanti." });
    }

    const name = safeString(req.body.name, 100);
    const attendance = safeString(req.body.attendance, 30);
    const guestCount = parseInteger(req.body.guestCount, 0);
    const message = safeString(req.body.message, 500);

    if (!name || name.length < 2) return res.status(400).json({ success: false, message: "Nama wajib diisi." });
    if (!validAttendance(attendance)) return res.status(400).json({ success: false, message: "Pilihan kehadiran tidak valid." });
    if (guestCount < 1 || guestCount > 10) return res.status(400).json({ success: false, message: "Jumlah tamu harus antara 1-10." });

    let existing = await redis.get(rsvpKey(slug));
    if (!Array.isArray(existing)) existing = [];
    if (existing.length >= MAX_RSVP) {
      return res.status(429).json({ success: false, message: "RSVP untuk wedding ini sudah mencapai batas penyimpanan." });
    }

    const rsvp = {
      id: createId("rsvp"),
      name, attendance, guestCount, message,
      createdAt: nowISO(),
      guestNameFromUrl: normalizeGuestName(req.query.to)
    };

    existing.unshift(rsvp);
    await redis.set(rsvpKey(slug), existing);
    return res.json({ success: true, message: "Terima kasih, RSVP Anda telah diterima." });
  } catch (error) {
    console.error("RSVP error:", error);
    return res.status(500).json({ success: false, message: "RSVP gagal disimpan." });
  }
});

app.use(function(req, res) {
  return res.status(404).send(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>404 — LOVEFOREVER</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f2ec;color:#2d2926;font-family:Arial,sans-serif;text-align:center;padding:24px;}a{color:inherit;}</style></head><body><main><p>LOVEFOREVER</p><h1>404</h1><p>Halaman yang Anda cari tidak ditemukan.</p><a href="/">Kembali ke halaman utama</a></main></body></html>`);
});

app.use(function(error, req, res, next) {
  console.error("GLOBAL ERROR:", error);
  if (res.headersSent) return next(error);
  return res.status(500).send("Terjadi kesalahan pada server.");
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, function() {
    console.log(`LOVEFOREVER running on port ${PORT}`);
  });
}
