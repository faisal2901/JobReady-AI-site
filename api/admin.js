// JobTopper — admin analytics (read-only, token protected).
// GET /api/admin?token=YOUR_ADMIN_TOKEN[&days=30]
// Returns traffic, signups, logins/logouts, feature usage and the user roster.
// Protect by setting ADMIN_TOKEN in Vercel → Settings → Environment Variables.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

async function redis(cmd) {
  const r = await fetch(`${UPSTASH_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).result;
}
// Constant-time-ish string compare to avoid trivial timing leaks.
function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function lastNDays(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    out.push(d);
  }
  return out.reverse();
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: "ADMIN_TOKEN is not set. Add it in Vercel → Settings → Environment Variables, then redeploy." });
  }
  const token = (req.query && req.query.token) || (req.headers["x-admin-token"]);
  if (!safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!HAS_UPSTASH) {
    return res.status(200).json({ ok: true, upstash: false, message: "Connect Upstash Redis to start collecting analytics. No data yet." });
  }

  const days = Math.min(90, Math.max(1, parseInt((req.query && req.query.days), 10) || 30));
  const dayList = lastNDays(days);

  try {
    const num = (v) => parseInt(v, 10) || 0;

    // Per-day series for each event type + unique visitors.
    const series = { visit: [], signup: [], login: [], logout: [], unique: [] };
    for (const d of dayList) {
      const [v, s, li, lo, u] = await Promise.all([
        redis(["GET", `stat:visit:${d}`]),
        redis(["GET", `stat:signup:${d}`]),
        redis(["GET", `stat:login:${d}`]),
        redis(["GET", `stat:logout:${d}`]),
        redis(["PFCOUNT", `uniq:${d}`]).catch(() => 0),
      ]);
      series.visit.push({ date: d, count: num(v) });
      series.signup.push({ date: d, count: num(s) });
      series.login.push({ date: d, count: num(li) });
      series.logout.push({ date: d, count: num(lo) });
      series.unique.push({ date: d, count: num(u) });
    }

    // All-time totals.
    const [tVisit, tSignup, tLogin, tLogout] = await Promise.all([
      redis(["GET", "stat:visit:all"]),
      redis(["GET", "stat:signup:all"]),
      redis(["GET", "stat:login:all"]),
      redis(["GET", "stat:logout:all"]),
    ]);

    // Feature usage: reuse the AI daily counters (jrd:*) is per-IP, so instead we
    // expose per-action usage if the app logged it. We read action counters keyed
    // stat:feat:<action>:all written by the app via /api/track is optional; here we
    // surface any that exist for a known action set.
    const FEATURES = ["analyze", "boost", "tailor", "coverletter", "jobs", "interview", "salary", "roadmap"];
    const featUsage = {};
    await Promise.all(FEATURES.map(async (f) => { featUsage[f] = num(await redis(["GET", `stat:feat:${f}:all`]).catch(() => 0)); }));

    // User roster.
    const usersRaw = await redis(["HVALS", "users"]).catch(() => []);
    const users = (Array.isArray(usersRaw) ? usersRaw : []).map((u) => { try { return JSON.parse(u); } catch { return null; } }).filter(Boolean);
    users.sort((a, b) => String(b.lastLogin || "").localeCompare(String(a.lastLogin || "")));

    return res.status(200).json({
      ok: true,
      upstash: true,
      generatedAt: new Date().toISOString(),
      days,
      totals: {
        visits: num(tVisit),
        signups: num(tSignup),
        logins: num(tLogin),
        logouts: num(tLogout),
        registeredUsers: users.length,
      },
      series,
      featureUsage: featUsage,
      users,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
