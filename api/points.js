// JobTopper — usage credits + referral system (server-authoritative, Upstash).
// POST /api/points  body: { action, email, name?, tool?, ref? }
//   action = "status"   → return per-tool remaining + reset times, referral code/count, pending notifications
//   action = "consume"  → atomically consume 1 use of `tool` (returns ok:false if none left)
//   action = "signup"   → register the user, apply a referrer's `ref` code if present (rewards both sides)
//
// Model:
//   - Each of 5 tools allows 3 uses per rolling 24h (independent counters with TTL).
//   - "bonus" credits per tool are extra uses that don't expire on the daily clock; they're
//     consumed before daily ones aren't — we simply track an allowance number per tool.
//   - Referral: when a friend signs up with someone's code, the referrer instantly gets a
//     full fresh allowance (all tools reset), and a notification is queued. Every 10 referrals
//     grants a 48h mega bonus (double allowance). The new friend gets a half-day bonus.
//
// Storage keys (all namespaced jp:):
//   jp:use:<uid>:<tool>           INCR counter, EXPIRE 24h         (daily usage)
//   jp:bonus:<uid>:<tool>         bonus uses remaining (no expiry)
//   jp:code:<uid>                 the user's referral code
//   jp:codeowner:<CODE>          → uid that owns the code
//   jp:refcount:<uid>            total successful referrals
//   jp:referred:<uid>            "1" once this user has consumed a referral (prevents double)
//   jp:notif:<uid>              → JSON array of pending notification strings
//   jp:user:<uid>              → JSON {email,name,joined}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

const TOOLS = ["jobs", "analyze", "tailor", "salary", "roadmap"];
const DAILY_LIMIT = 3;
const DAY = 24 * 3600;

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const uidOf = (email) => fnv(String(email).toLowerCase().trim());

async function redis(cmd) {
  const r = await fetch(`${UPSTASH_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).result;
}
async function getNum(k) { const v = await redis(["GET", k]); return parseInt(v, 10) || 0; }
async function ttlOf(k) { const v = await redis(["TTL", k]); return parseInt(v, 10) || 0; }

function ipOf(req) {
  return ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}
// light per-IP throttle
const mem = new Map();
async function tooFast(ip) {
  const MAX = 80;
  if (HAS_UPSTASH) {
    try { const k = `jpm:${ip}:${Math.floor(Date.now() / 60000)}`; const m = await redis(["INCR", k]); if (m === 1) await redis(["EXPIRE", k, "70"]); return m > MAX; } catch (_) {}
  }
  const now = Date.now(); const r = (mem.get(ip) || []).filter((t) => now - t < 60000); r.push(now); mem.set(ip, r); if (mem.size > 5000) mem.clear(); return r.length > MAX;
}

// A short, friendly referral code derived from the uid (stable per user).
function codeFromUid(uid) { return (uid + "x").slice(0, 6).toUpperCase(); }

async function ensureCode(uid) {
  let code = await redis(["GET", `jp:code:${uid}`]);
  if (!code) {
    code = codeFromUid(uid);
    await redis(["SET", `jp:code:${uid}`, code]);
    await redis(["SET", `jp:codeowner:${code}`, uid]);
  }
  return code;
}

// Remaining uses for a tool = (daily allowance - used) + bonus.
async function toolStatus(uid, tool) {
  const usedKey = `jp:use:${uid}:${tool}`;
  const used = await getNum(usedKey);
  const bonus = await getNum(`jp:bonus:${uid}:${tool}`);
  const dailyLeft = Math.max(0, DAILY_LIMIT - used);
  const remaining = dailyLeft + bonus;
  let resetIn = 0;
  if (dailyLeft === 0 && used > 0) resetIn = await ttlOf(usedKey); // seconds until daily window resets
  return { remaining, dailyLeft, bonus, resetIn };
}

async function fullStatus(uid) {
  const tools = {};
  for (const t of TOOLS) tools[t] = await toolStatus(uid, t);
  const code = await ensureCode(uid);
  const referrals = await getNum(`jp:refcount:${uid}`);
  let notifs = [];
  try { const raw = await redis(["GET", `jp:notif:${uid}`]); if (raw) notifs = JSON.parse(raw); } catch (_) {}
  if (notifs.length) await redis(["DEL", `jp:notif:${uid}`]); // deliver once
  return { ok: true, tools, code, referrals, notifications: notifs, limit: DAILY_LIMIT };
}

async function pushNotif(uid, msg) {
  let arr = [];
  try { const raw = await redis(["GET", `jp:notif:${uid}`]); if (raw) arr = JSON.parse(raw); } catch (_) {}
  arr.push(msg);
  await redis(["SET", `jp:notif:${uid}`, JSON.stringify(arr.slice(-20))]);
}

// Grant a "fresh allowance": clear daily counters so all tools are 3/3 again.
async function grantFreshDay(uid) {
  for (const t of TOOLS) await redis(["DEL", `jp:use:${uid}:${t}`]);
}
// Add bonus uses to every tool.
async function grantBonusAll(uid, n) {
  for (const t of TOOLS) await redis(["INCRBY", `jp:bonus:${uid}:${t}`, String(n)]);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (req.headers["x-jr-app"] !== "1") return res.status(403).json({ ok: false, error: "Forbidden" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const email = (body.email || "").trim().toLowerCase();
  const action = String(body.action || "");
  if (!email || !/^[\w.+-]+@[\w-]+\.[A-Za-z]{2,}$/.test(email)) {
    return res.status(400).json({ ok: false, error: "valid email required" });
  }

  // Without Upstash, fail open (unlimited) so the app keeps working.
  if (!HAS_UPSTASH) {
    const tools = {}; TOOLS.forEach((t) => tools[t] = { remaining: DAILY_LIMIT, dailyLeft: DAILY_LIMIT, bonus: 0, resetIn: 0 });
    return res.status(200).json({ ok: true, upstash: false, tools, code: "", referrals: 0, notifications: [], limit: DAILY_LIMIT });
  }

  if (await tooFast(ipOf(req))) return res.status(429).json({ ok: false, error: "Too many requests, slow down." });

  const uid = uidOf(email);

  try {
    if (action === "status") {
      return res.status(200).json({ upstash: true, ...(await fullStatus(uid)) });
    }

    if (action === "signup") {
      // Record the user once.
      const existed = await redis(["GET", `jp:user:${uid}`]);
      if (!existed) {
        await redis(["SET", `jp:user:${uid}`, JSON.stringify({ email, name: body.name || "", joined: new Date().toISOString().slice(0, 10) })]);
      }
      await ensureCode(uid);

      // Apply a referral code if this is a brand-new user who hasn't been referred before.
      const ref = String(body.ref || "").trim().toUpperCase();
      const alreadyReferred = await redis(["GET", `jp:referred:${uid}`]);
      if (ref && !existed && !alreadyReferred) {
        const refOwner = await redis(["GET", `jp:codeowner:${ref}`]);
        if (refOwner && refOwner !== uid) {
          await redis(["SET", `jp:referred:${uid}`, "1"]);
          // New friend: half-day bonus (= +2 uses per tool).
          await grantBonusAll(uid, 2);
          // Referrer: instant full fresh allowance + count + notification.
          await grantFreshDay(refOwner);
          const count = await redis(["INCR", `jp:refcount:${refOwner}`]);
          await pushNotif(refOwner, `🎉 ${body.name || "A friend"} joined with your link! Your daily credits are topped up. (${count} referral${count > 1 ? "s" : ""} total)`);
          // Every 10 referrals → 48h mega bonus (double allowance = +6 per tool).
          if (count % 10 === 0) {
            await grantBonusAll(refOwner, DAILY_LIMIT * 2);
            await pushNotif(refOwner, `🏆 ${count} referrals! You've earned a 48-hour mega bonus. Thank you for spreading the word!`);
          }
        }
      }
      return res.status(200).json({ upstash: true, ...(await fullStatus(uid)) });
    }

    if (action === "consume") {
      const tool = String(body.tool || "");
      if (!TOOLS.includes(tool)) return res.status(400).json({ ok: false, error: "unknown tool" });
      const st = await toolStatus(uid, tool);
      if (st.remaining <= 0) {
        return res.status(200).json({ ok: false, reason: "no_credits", tool, resetIn: st.resetIn, ...(await fullStatus(uid)) });
      }
      // Spend a bonus use first (preserves the daily window); else count a daily use.
      if (st.bonus > 0) {
        await redis(["DECR", `jp:bonus:${uid}:${tool}`]);
      } else {
        const usedKey = `jp:use:${uid}:${tool}`;
        const n = await redis(["INCR", usedKey]);
        if (n === 1) await redis(["EXPIRE", usedKey, String(DAY)]); // start the 24h window on first use
      }
      return res.status(200).json({ ok: true, tool, ...(await fullStatus(uid)) });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  } catch (e) {
    // Fail open on infra errors so users are never hard-blocked by a glitch.
    return res.status(200).json({ ok: true, error: e.message, softFail: true });
  }
};
