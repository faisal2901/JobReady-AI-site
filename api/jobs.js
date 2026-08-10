// JobTopper — live jobs endpoint (JSearch on RapidAPI: aggregates LinkedIn, Naukri, Indeed, Glassdoor, Shine…)
// GET /api/jobs?q=react+developer&location=Bengaluru&datePosted=today&page=1&remote=false&employmentType=FULLTIME

const crypto = require("crypto");

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-JR-App, X-JR-Credit");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (!origin) return false;
  const allowed = [
  "http://localhost:3000",
  "capacitor://localhost",
  "https://jobtopper.vercel.app",
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),
];

const normalizedOrigin = origin.replace(/\/$/, "");

let ok = allowed.includes(normalizedOrigin);
  try { if (new URL(origin).host === req.headers.host) ok = true; } catch (_) {}
  if (ok) res.setHeader("Access-Control-Allow-Origin", origin);
  return ok;
}

function tokenSecret() {
  return process.env.AI_TOKEN_SECRET || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.GEMINI_API_KEY || "dev-only-token-secret";
}
function verifyCreditToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch (_) { return false; }
  return data && data.tool === "jobs" && Number(data.exp) > Date.now();
}

/* ── Per-IP rate limiting (Upstash if configured, in-memory fallback) ── */
const JOBS_PER_MINUTE = Number(process.env.JOBS_PER_MINUTE) || 12;
const JOBS_PER_DAY = Number(process.env.JOBS_PER_DAY) || 200;
const memMinute = new Map(), memDay = new Map();
function ipOf(req) {
  return ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}
async function upstash(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/${cmd}`, { headers: { Authorization: `Bearer ${tok}` } });
  return (await r.json()).result;
}
async function rateLimited(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const mKey = `jbm:${ip}:${Math.floor(Date.now() / 60000)}`;
      const dKey = `jbd:${ip}:${day}`;
      // The minute and day counters are independent — increment both at once
      // instead of waiting on one Upstash round trip before starting the next.
      const [m, d] = await Promise.all([upstash(`incr/${mKey}`), upstash(`incr/${dKey}`)]);
      if (m === 1) upstash(`expire/${mKey}/70`).catch(() => {});   // housekeeping only, doesn't need to block the response
      if (d === 1) upstash(`expire/${dKey}/90000`).catch(() => {});
      if (m > JOBS_PER_MINUTE) return "minute";
      if (d > JOBS_PER_DAY) return "day";
      return null;
    } catch (_) { /* fall through to memory */ }
  }
  const now = Date.now();
  const recent = (memMinute.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now); memMinute.set(ip, recent);
  if (recent.length > JOBS_PER_MINUTE) return "minute";
  const dk = ip + day;
  const dn = (memDay.get(dk) || 0) + 1; memDay.set(dk, dn);
  if (memDay.size > 5000) memDay.clear();
  if (dn > JOBS_PER_DAY) return "day";
  return null;
}
// Cap and clean a query param: trims, removes control chars, enforces a max length.
function clean(v, max) {
  return String(v ?? "").replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max);
}

module.exports = async (req, res) => {
  const corsOk = applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(corsOk ? 200 : 403).end();
  if (!corsOk) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  if (req.headers["x-jr-app"] !== "1") return res.status(403).json({ ok: false, error: "Forbidden" });
  if (!verifyCreditToken(req.headers["x-jr-credit"])) return res.status(401).json({ ok: false, error: "Please search jobs from the app after credit check." });

  // Abuse protection: throttle per IP so bots can't drain the free JSearch quota.
  const limited = await rateLimited(ipOf(req));
  if (limited === "minute") return res.status(429).json({ ok: false, error: "⏳ Too many searches in a short time. Please wait a minute and try again." });
  if (limited === "day") return res.status(429).json({ ok: false, error: "🌙 You've hit today's job-search limit. It refreshes tomorrow." });

  // Cache identical searches at Vercel's edge for 10 minutes: saves JSearch quota and is much faster
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1800");

  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: "RAPIDAPI_KEY is not set. Get a free key at rapidapi.com (JSearch API) and add it in Vercel env vars." });
  }

  try {
    const rawq = req.query || {};
    // Validate & cap every input so oversized or malformed params can't be abused.
    const q = clean(rawq.q, 120) || "software developer";
    const location = clean(rawq.location, 80) || "India";
    const datePosted = ["all", "today", "3days", "week", "month"].includes(rawq.datePosted) ? rawq.datePosted : "today";
    const pageNum = Math.min(20, Math.max(1, parseInt(rawq.page, 10) || 1));
    const page = String(pageNum);
    const remote = rawq.remote;
    const employmentType = ["FULLTIME", "PARTTIME", "CONTRACTOR", "INTERN"].includes(rawq.employmentType) ? rawq.employmentType : "";

    const params = new URLSearchParams({
      query: `${q} in ${location}`,
      page: String(page),
      num_pages: "1",
      date_posted: datePosted, // all | today | 3days | week | month
      country: "in",
    });
    if (remote === "true") params.set("work_from_home", "true");
    if (employmentType) params.set("employment_types", employmentType);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(`https://jsearch.p.rapidapi.com/search?${params}`, {
      headers: {
        "X-RapidAPI-Key": key,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (r.status === 429) return res.status(429).json({ ok: false, error: "Jobs API rate limit reached (free tier). Try again in a minute." });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ ok: false, error: `Jobs API error ${r.status}: ${t.slice(0, 200)}` });
    }

    const data = await r.json();
    const jobs = (data.data || []).map((j) => ({
      id: j.job_id,
      title: j.job_title,
      company: j.employer_name,
      logo: j.employer_logo || "",
      location: [j.job_city, j.job_state].filter(Boolean).join(", ") || (j.job_country === "IN" ? "India" : j.job_country),
      remote: !!j.job_is_remote,
      employmentType: j.job_employment_type || "",
      postedAt: j.job_posted_at_datetime_utc || "",
      postedText: j.job_posted_at || "",
      applyLink: j.job_apply_link,
      applyOptions: (j.apply_options || []).map((o) => ({ publisher: o.publisher, link: o.apply_link })),
      publisher: j.job_publisher || "",
      salaryMin: j.job_min_salary,
      salaryMax: j.job_max_salary,
      salaryPeriod: j.job_salary_period,
      description: (j.job_description || "").slice(0, 6000),
      highlights: j.job_highlights || {},
    }));

    return res.status(200).json({ ok: true, count: jobs.length, jobs });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.name === "AbortError" ? "Jobs API timed out, please retry." : e.message });
  }
};
