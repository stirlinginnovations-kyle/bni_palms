import crypto from "node:crypto";
import cookie from "cookie";

export const SUPABASE_REQUIRED_DETAIL =
  "Supabase is required for uploads and analytics. Set SUPABASE_URL and SUPABASE_SERVICE_KEY, then restart the server.";

export const ANALYTICS_GOALS = {
  visitors: 190,
  one_to_ones: 4400,
  referrals: 1550,
  ceu: 2630,
  tyfcb: 2500000,
};

export const AUTH_COOKIE_NAME = "bni_palms_auth_v2";
export const AUTH_COOKIE_MAX_AGE_SECONDS = Math.max(
  300,
  Number.parseInt(process.env.APP_AUTH_SESSION_SECONDS || "43200", 10) || 43200,
);
export const AUTH_DEFAULT_PASSWORD = "giversgain";
export const AUTH_SESSION_SECRET =
  (process.env.APP_AUTH_SESSION_SECRET || "").trim() ||
  (process.env.SUPABASE_SERVICE_KEY || "").trim() ||
  "bni-palms-local-session";
export const AUTH_COOKIE_SECURE = ["1", "true", "yes"].includes(
  String(process.env.APP_AUTH_COOKIE_SECURE || "0")
    .trim()
    .toLowerCase(),
);

export const DEFAULT_CHAPTER_UPLOAD_PIN =
  (process.env.APP_DEFAULT_CHAPTER_UPLOAD_PIN || "12345").trim() || "12345";
export const DEFAULT_TRAFFIC_UPLOAD_PIN =
  (process.env.APP_TRAFFIC_UPLOAD_PIN || "").trim() ||
  (process.env.APP_DEFAULT_TRAFFIC_UPLOAD_PIN || "innovation").trim() ||
  "innovation";
export const TRAFFIC_UPLOAD_PIN_SLUG = "traffic_lights_global";
export const CHAPTER_PIN_MIN_LENGTH = Math.max(
  1,
  Number.parseInt((process.env.APP_CHAPTER_PIN_MIN_LENGTH || "4").trim(), 10) || 4,
);
export const CHAPTER_PIN_MAX_LENGTH = Math.max(CHAPTER_PIN_MIN_LENGTH, 32);

export const REFERRAL_COLUMNS = ["RGI", "RGO"];
export const REFERRALS_TOTAL_COLUMN = "Referrals Total";
export const SPREADSHEET_TABLE_START_ROW = 9;

export function stripRegionSuffix(name) {
  return String(name || "")
    .trim()
    .replace(/\s*-\s*(MO St\. Louis|IL Southern)\s*$/i, "");
}

export function normalizeChapter(name) {
  return stripRegionSuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function slugify(value) {
  const text = stripRegionSuffix(value).replace(/[^a-zA-Z0-9]+/g, "_");
  return text.replace(/^_+|_+$/g, "").toLowerCase() || "unknown";
}

export function safeFilename(name) {
  const cleaned = String(name || "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.replace(/^[._]+|[._]+$/g, "") || "upload";
}

export function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

export function nullableNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function roundTotal(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? n : Number(n.toFixed(2));
}

export function sampleMembers(rows, limit = 5) {
  const out = [];
  for (const row of rows || []) {
    const first = String(row?.["First Name"] || "").trim();
    const last = String(row?.["Last Name"] || "").trim();
    const full = `${first} ${last}`.trim();
    if (full) {
      out.push(full);
    }
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

export function extractColumns(rows) {
  const seen = new Set();
  const ordered = [];
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(String(key));
      }
    }
  }
  return ordered;
}

export function tallyReferralColumns(rows) {
  const totals = {};
  for (const col of REFERRAL_COLUMNS) {
    totals[col] = 0;
  }
  for (const row of rows || []) {
    for (const col of REFERRAL_COLUMNS) {
      totals[col] += asNumber(row?.[col]);
    }
  }
  const rounded = {};
  for (const col of REFERRAL_COLUMNS) {
    rounded[col] = roundTotal(totals[col]);
  }
  return rounded;
}

export function inferTrafficReportMonth(filename) {
  const stem = String(filename || "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();

  const yearMonth = stem.match(/(20\d{2})[-_](0[1-9]|1[0-2])/);
  if (yearMonth) {
    return `${yearMonth[1]}-${yearMonth[2]}-01`;
  }

  const monthYear = stem.match(/(0[1-9]|1[0-2])[-_](20\d{2})/);
  if (monthYear) {
    return `${monthYear[2]}-${monthYear[1]}-01`;
  }

  const monthMap = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };

  const namedMonth = stem.match(
    /(20\d{2})[-_ ]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/,
  );
  if (namedMonth) {
    return `${namedMonth[1]}-${monthMap[namedMonth[2]]}-01`;
  }

  const reverseNamed = stem.match(
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-_ ]?(20\d{2})/,
  );
  if (reverseNamed) {
    return `${reverseNamed[2]}-${monthMap[reverseNamed[1]]}-01`;
  }

  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

export function configuredAuthPasswords() {
  const values = [];
  const csv =
    (process.env.APP_AUTH_PASSWORDS || "").trim() ||
    (process.env.BNI_AUTH_PASSWORDS || "").trim();
  if (csv) {
    for (const part of csv.split(",")) {
      const value = part.trim();
      if (value) {
        values.push(value);
      }
    }
  }

  const single =
    (process.env.APP_AUTH_PASSWORD || "").trim() ||
    (process.env.APP_AUTH_PIN || "").trim();
  if (single) {
    values.push(single);
  }

  if (values.length === 0) {
    return [AUTH_DEFAULT_PASSWORD];
  }
  return Array.from(new Set(values)).sort();
}

export const AUTH_PASSWORDS = configuredAuthPasswords();

export function configuredChapterUploadPins() {
  const raw = (process.env.APP_CHAPTER_UPLOAD_PINS || "").trim();
  if (!raw) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out = {};
  for (const [chapterName, pinValue] of Object.entries(parsed)) {
    const chapterKey = slugify(String(chapterName));
    const pinText = String(pinValue || "").trim();
    if (chapterKey && pinText) {
      out[chapterKey] = pinText;
    }
  }
  return out;
}

export const CHAPTER_UPLOAD_PINS = configuredChapterUploadPins();

export function secureCompare(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function authSignature(payload) {
  return crypto
    .createHmac("sha256", AUTH_SESSION_SECRET)
    .update(String(payload))
    .digest("hex");
}

export function buildAuthToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
  const payload = String(expiresAt);
  return `${payload}.${authSignature(payload)}`;
}

export function isValidAuthToken(token) {
  if (!token || !String(token).includes(".")) {
    return false;
  }
  const [expiresAtRaw, signature] = String(token).split(".", 2);
  if (!/^\d+$/.test(expiresAtRaw)) {
    return false;
  }
  const expected = authSignature(expiresAtRaw);
  if (!secureCompare(signature, expected)) {
    return false;
  }
  return Number(expiresAtRaw) >= Math.floor(Date.now() / 1000);
}

export function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  return cookie.parse(header);
}

export function isAuthenticated(request) {
  const cookies = parseCookies(request);
  return isValidAuthToken(cookies[AUTH_COOKIE_NAME]);
}

export function normalizeNextPath(value) {
  if (!value) {
    return "/";
  }
  const text = String(value).trim();
  if (!text.startsWith("/") || text.startsWith("//")) {
    return "/";
  }
  if (text.startsWith("/api/")) {
    return "/";
  }
  return text;
}

export function buildAuthCookieHeader() {
  return cookie.serialize(AUTH_COOKIE_NAME, buildAuthToken(), {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  });
}

export function buildDeleteAuthCookieHeader() {
  return cookie.serialize(AUTH_COOKIE_NAME, "", {
    maxAge: 0,
    expires: new Date(0),
    path: "/",
  });
}

export function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function requireJsonBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid JSON payload.");
  }
  return value;
}
