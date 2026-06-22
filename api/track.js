// JobTopper — analytics event logger.
// POST /api/track  body: { event, email?, name? }
//   event ∈ visit | signup | login | logout
// Records lightweight counters + a user roster in Upstash Redis so the owner can
// see traffic, signups and logins from the admin dashboard. Privacy-minded:
//   - visitor uniqueness is tracked by a hashed IP+UA per day (no raw IP stored)
//   - the only PII kept is the account name/email the user already gave at sign-in
// If Upstash is not configured the endpoint is a graceful no-op.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
async function redis(cmd) {
  const r = await fetch(`${UPSTASH_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).result;
}
function ipOf(req) {
  return ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}
const today = () => new Date().toISOString().slice(0, 10);
function sameOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}

/* ── per-IP throttle so the logger can't be spammed ── */
const mem = new Map();
async function tooFast(ip) {
  const MAX = 60;
  if (HAS_UPSTASH) {
    try {
      const k = `trm:${ip}:${Math.floor(Date.now() / 60000)}`;
      const m = await redis(["INCR", k]);
      if (m === 1) await redis(["EXPIRE", k, "70"]);
      return m > MAX;
    } catch (_) {}
  }
  const now = Date.now();
  const recent = (mem.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now); mem.set(ip, recent);
  if (mem.size > 5000) mem.clear();
  return recent.length > MAX;
}

const EVENTS = new Set(["visit", "signup", "login", "logout", "feature"]);
const FEATURES = new Set(["analyze", "boost", "tailor", "coverletter", "jobs", "interview", "salary", "roadmap"]);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  if (req.headers["x-jr-app"] !== "1") return res.status(403).json({ ok: false, error: "Forbidden" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  try { if (JSON.stringify(body).length > 4000) return res.status(413).json({ ok: false, error: "Request too large" }); } catch (_) {}

  const event = String(body.event || "").toLowerCase();
  if (!EVENTS.has(event)) return res.status(400).json({ ok: false, error: "bad event" });

  // No Upstash → accept but do nothing, so the client never errors.
  if (!HAS_UPSTASH) return res.status(200).json({ ok: true, logged: false });

  const ip = ipOf(req);
  if (await tooFast(ip)) return res.status(429).json({ ok: false, error: "slow down" });

  const day = today();
  try {
    // Feature-usage event: increment a per-action counter and stop.
    if (event === "feature") {
      const f = String(body.feature || "").toLowerCase();
      if (FEATURES.has(f)) {
        await redis(["INCR", `stat:feat:${f}:${day}`]);
        await redis(["INCR", `stat:feat:${f}:all`]);
        await redis(["SADD", "stat:days", day]);
      }
      return res.status(200).json({ ok: true, logged: true });
    }

    // Daily + all-time counter for this event type.
    await redis(["INCR", `stat:${event}:${day}`]);
    await redis(["INCR", `stat:${event}:all`]);

    if (event === "visit") {
      // Unique visitors per day, approximated by a hashed IP+UA fingerprint.
      const fp = fnv(ip + "|" + (req.headers["user-agent"] || ""));
      await redis(["PFADD", `uniq:${day}`, fp]); // HyperLogLog, tiny + privacy-friendly
      await redis(["EXPIRE", `uniq:${day}`, "7776000"]); // keep 90 days
    }

    // Keep a small set of recent active days for the dashboard to read.
    await redis(["SADD", "stat:days", day]);

    if ((event === "signup" || event === "login") && body.email) {
      const email = String(body.email).toLowerCase().trim().slice(0, 160);
      const name = String(body.name || "").trim().slice(0, 80);
      if (/^[\w.+-]+@[\w-]+\.[A-Za-z]{2,}$/.test(email)) {
        const id = fnv(email);
        const existing = await redis(["HGET", "users", id]);
        let rec = {};
        try { if (existing) rec = JSON.parse(existing); } catch (_) {}
        rec.email = email;
        rec.name = name || rec.name || "";
        rec.firstSeen = rec.firstSeen || day;
        rec.lastLogin = day;
        rec.logins = (rec.logins || 0) + (event === "login" || event === "signup" ? 1 : 0);
        if (event === "signup" && !rec.signedUp) rec.signedUp = day;
        await redis(["HSET", "users", id, JSON.stringify(rec)]);
      }
    }

    return res.status(200).json({ ok: true, logged: true });
  } catch (e) {
    return res.status(200).json({ ok: true, logged: false, error: e.message });
  }
};
