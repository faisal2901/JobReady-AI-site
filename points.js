// JobTopper — usage credits + referral system (server-authoritative, Upstash).
// POST /api/points  body: { action, email, name?, tool?, ref?, day }
//   day = caller's LOCAL date "YYYY-MM-DD" so daily credits reset at the user's
//         own midnight (12am local), not on a rolling 24h-from-first-use clock.
//
//   action "status"  → per-tool { daily, bonus, remaining } + code + referrals + referral list + notifications
//   action "consume" → atomically spend 1 credit of `tool` (daily first, then bonus)
//   action "signup"  → register user; if `ref` present and valid, credit the referrer (+3 bonus/tool)
//                      and the new friend (+2 bonus/tool); track referral list; queue notification.
//
// Daily reset model: usage is counted under a key that INCLUDES the local date, e.g.
//   jp:use:<uid>:<tool>:<YYYY-MM-DD>. On a new local day the key name changes, so the
//   count is naturally 0 again (old keys expire after 48h). No timers needed.
//
// Referral bonus is a separate, non-expiring per-tool balance (jp:bonus:<uid>:<tool>),
// spent only AFTER the day's free 3 are used.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);
const crypto = require("crypto");

const TOOLS = ["jobs", "analyze", "tailor", "salary", "roadmap"];
const DAILY_LIMIT = 3;
const REF_BONUS_REFERRER = 3; // 1 friend → +3 per tool for the referrer
const REF_BONUS_FRIEND = 2;   // joining via a link → +2 per tool for the new friend

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

function ipOf(req) {
  return ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}
const mem = new Map();
async function tooFast(ip) {
  const MAX = 100;
  if (HAS_UPSTASH) {
    try { const k = `jpm:${ip}:${Math.floor(Date.now() / 60000)}`; const m = await redis(["INCR", k]); if (m === 1) redis(["EXPIRE", k, "70"]).catch(() => {}); return m > MAX; } catch (_) {}
  }
  const now = Date.now(); const r = (mem.get(ip) || []).filter((t) => now - t < 60000); r.push(now); mem.set(ip, r); if (mem.size > 5000) mem.clear(); return r.length > MAX;
}

const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-JR-App, X-JR-Credit");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (!origin) return false;
  const allowed = new Set([
    `https://${req.headers.host}`,
    "https://localhost",
    "capacitor://localhost",
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  ]);
  let ok = allowed.has(origin);
  try { if (new URL(origin).host === req.headers.host) ok = true; } catch (_) {}
  if (ok) res.setHeader("Access-Control-Allow-Origin", origin);
  return ok;
}
function codeFromUid(uid) { return (uid + "x").slice(0, 6).toUpperCase(); }
async function ensureCode(uid) {
  let code = await redis(["GET", `jp:code:${uid}`]);
  if (!code) {
    const base = codeFromUid(uid);
    code = base;
    for (let i = 0; i < 20; i++) {
      const owner = await redis(["GET", `jp:codeowner:${code}`]);
      if (!owner || owner === uid) break;
      code = (base.slice(0, 5) + i.toString(36)).toUpperCase();
    }
    await redis(["SET", `jp:code:${uid}`, code]);
    await redis(["SET", `jp:codeowner:${code}`, uid]);
  }
  return code;
}
const useKey = (uid, tool, day) => `jp:use:${uid}:${tool}:${day}`;
const bonusKey = (uid, tool) => `jp:bonus:${uid}:${tool}`;

async function toolStatus(uid, tool, day) {
  // These two reads don't depend on each other — fire them together instead of
  // waiting on one round trip before starting the next (cuts this in half).
  const [used, bonus] = await Promise.all([getNum(useKey(uid, tool, day)), getNum(bonusKey(uid, tool))]);
  const daily = Math.max(0, DAILY_LIMIT - used);
  return { daily, bonus, remaining: daily + bonus, limit: DAILY_LIMIT };
}
async function fullStatus(uid, day) {
  // Every branch below is independent of the others, so run them concurrently.
  // Previously this was ~15 sequential Redis round trips (5 tools × 2 keys, plus
  // code/referrals/reflist/notifs) — that serial chain was the main reason the
  // "checking your credits" step before a job search felt slow. Same reads, same
  // results, just fired in parallel.
  const [toolsArr, code, referrals, refListRaw, notifsRaw] = await Promise.all([
    Promise.all(TOOLS.map((t) => toolStatus(uid, t, day))),
    ensureCode(uid),
    getNum(`jp:refcount:${uid}`),
    redis(["GET", `jp:reflist:${uid}`]).catch(() => null),
    redis(["GET", `jp:notif:${uid}`]).catch(() => null),
  ]);
  const tools = {};
  TOOLS.forEach((t, i) => { tools[t] = toolsArr[i]; });
  let refList = [];
  try { if (refListRaw) refList = JSON.parse(refListRaw); } catch (_) {}
  let notifs = [];
  try { if (notifsRaw) notifs = JSON.parse(notifsRaw); } catch (_) {}
  if (notifs.length) redis(["DEL", `jp:notif:${uid}`]).catch(() => {}); // housekeeping only, doesn't need to block the response
  return { ok: true, upstash: true, tools, code, referrals, referralList: refList, notifications: notifs, limit: DAILY_LIMIT, referralCreditsCarryOver: true, dailyCreditsCarryOver: false };
}
async function pushNotif(uid, msg) {
  let arr = []; try { const raw = await redis(["GET", `jp:notif:${uid}`]); if (raw) arr = JSON.parse(raw); } catch (_) {}
  arr.push(msg); await redis(["SET", `jp:notif:${uid}`, JSON.stringify(arr.slice(-20))]);
}
async function addBonusAll(uid, n) { for (const t of TOOLS) await redis(["INCRBY", bonusKey(uid, t), String(n)]); }

function tokenSecret() {
  return process.env.AI_TOKEN_SECRET || UPSTASH_TOKEN || process.env.GEMINI_API_KEY || "dev-only-token-secret";
}
function b64url(s) { return Buffer.from(s).toString("base64url"); }
// kind ("daily" | "bonus") + day are embedded so a later refund can reverse the exact
// thing that was decremented, without the client having to know or report which it was.
function signCreditToken(uid, tool, kind, day) {
  const payload = b64url(JSON.stringify({ uid, tool, kind, day, exp: Date.now() + 5 * 60 * 1000 }));
  const sig = crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
// Verifies a token this server signed and returns its payload, or null if invalid/tampered.
function decodeCreditToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch (_) { return null; }
}
function hashSession(token) {
  return crypto.createHmac("sha256", tokenSecret()).update(String(token || "")).digest("hex");
}
function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}
const sessionKey = (uid) => `jp:session:${uid}`;
async function createSession(uid) {
  const token = newSessionToken();
  await redis(["SET", sessionKey(uid), hashSession(token)]);
  return token;
}
async function hasSession(uid, token) {
  if (!token) return false;
  const stored = await redis(["GET", sessionKey(uid)]);
  return !!stored && stored === hashSession(token);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const corsOk = applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(corsOk ? 200 : 403).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!corsOk) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  if (req.headers["x-jr-app"] !== "1") return res.status(403).json({ ok: false, error: "Forbidden" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  try { if (JSON.stringify(body).length > 8000) return res.status(413).json({ ok: false, error: "Request too large" }); } catch (_) {}

  const email = (body.email || "").trim().toLowerCase();
  const action = String(body.action || "");
  const sessionToken = String(body.sessionToken || "").trim();
  if (!["status", "signup", "consume", "refund"].includes(action)) return res.status(400).json({ ok: false, error: "unknown action" });
  const day = validDay(body.day) ? body.day : new Date().toISOString().slice(0, 10);
  if (!email || !/^[\w.+-]+@[\w-]+\.[A-Za-z]{2,}$/.test(email)) return res.status(400).json({ ok: false, error: "valid email required" });

  // Without Upstash, report unavailable so the client can fail safe (it should NOT silently allow unlimited).
  if (!HAS_UPSTASH) {
    const tools = {}; TOOLS.forEach((t) => tools[t] = { daily: DAILY_LIMIT, bonus: 0, remaining: DAILY_LIMIT, limit: DAILY_LIMIT });
    return res.status(200).json({ ok: true, upstash: false, tools, code: "", referrals: 0, referralList: [], notifications: [], limit: DAILY_LIMIT, referralCreditsCarryOver: true, dailyCreditsCarryOver: false, sessionToken: "" });
  }

  if (await tooFast(ipOf(req))) return res.status(429).json({ ok: false, error: "Too many requests, slow down." });
  const uid = uidOf(email);

  try {
    if (action === "status") {
      if (!(await hasSession(uid, sessionToken))) return res.status(401).json({ ok: false, error: "Login session required" });
      return res.status(200).json(await fullStatus(uid, day));
    }

    if (action === "signup") {
      const existed = await redis(["GET", `jp:user:${uid}`]);
      const cleanName = String(body.name || "").replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, 80);
      if (!existed) await redis(["SET", `jp:user:${uid}`, JSON.stringify({ email, name: cleanName, joined: day })]);
      await ensureCode(uid);

      const ref = String(body.ref || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
      const alreadyReferred = await redis(["GET", `jp:referred:${uid}`]);
      if (ref && !existed && !alreadyReferred) {
        const refOwner = await redis(["GET", `jp:codeowner:${ref}`]);
        if (refOwner && refOwner !== uid) {
          await redis(["SET", `jp:referred:${uid}`, ref]);
          await addBonusAll(uid, REF_BONUS_FRIEND);                 // new friend bonus
          await addBonusAll(refOwner, REF_BONUS_REFERRER);          // referrer bonus
          const count = await redis(["INCR", `jp:refcount:${refOwner}`]);
          // append to referrer's referral list (name + date + status)
          let list = []; try { const raw = await redis(["GET", `jp:reflist:${refOwner}`]); if (raw) list = JSON.parse(raw); } catch (_) {}
          list.unshift({ name: (cleanName || "A friend"), date: day, status: "joined" });
          await redis(["SET", `jp:reflist:${refOwner}`, JSON.stringify(list.slice(0, 100))]);
          await pushNotif(refOwner, `🎉 ${body.name || "A friend"} joined with your link! +${REF_BONUS_REFERRER} credits added to every tool. (${count} referral${count > 1 ? "s" : ""})`);
          if (count % 10 === 0) { await addBonusAll(refOwner, DAILY_LIMIT * 2); await pushNotif(refOwner, `🏆 ${count} referrals! 48-hour mega bonus unlocked across all tools. Thank you!`); }
        }
      }
      const sessionToken = await createSession(uid);
      return res.status(200).json({ ...(await fullStatus(uid, day)), sessionToken });
    }

    if (action === "consume") {
      if (!(await hasSession(uid, sessionToken))) return res.status(401).json({ ok: false, error: "Login session required" });
      const tool = String(body.tool || "");
      if (!TOOLS.includes(tool)) return res.status(400).json({ ok: false, error: "unknown tool" });
      const st = await toolStatus(uid, tool, day);
      if (st.remaining <= 0) {
        const full = await fullStatus(uid, day);
        return res.status(200).json({ ...full, ok: false, reason: "no_credits", tool });
      }
      // Spend the day's free credits first; only then dip into referral bonus.
      // Remember which one, so a failed run can be refunded precisely (see "refund" below).
      let kind;
      if (st.daily > 0) {
        kind = "daily";
        const k = useKey(uid, tool, day);
        const n = await redis(["INCR", k]);
        if (n === 1) redis(["EXPIRE", k, String(48 * 3600)]).catch(() => {}); // auto-clean after 2 days; housekeeping only, doesn't need to block the response
      } else {
        kind = "bonus";
        await redis(["DECR", bonusKey(uid, tool)]);
      }
      const full = await fullStatus(uid, day);
      return res.status(200).json({ ...full, ok: true, tool, creditToken: signCreditToken(uid, tool, kind, day) });
    }

    if (action === "refund") {
      // Called by the client when a tool run fails AFTER its credit was already spent —
      // gives the credit back instead of charging the user for a run that produced nothing.
      if (!(await hasSession(uid, sessionToken))) return res.status(401).json({ ok: false, error: "Login session required" });
      const tool = String(body.tool || "");
      if (!TOOLS.includes(tool)) return res.status(400).json({ ok: false, error: "unknown tool" });
      const parsed = decodeCreditToken(String(body.creditToken || ""));
      if (!parsed || parsed.uid !== uid || parsed.tool !== tool) {
        // No valid token = nothing we can prove was spent; report success with no changes
        // rather than an error, so the client's error-handling path never itself breaks.
        return res.status(200).json({ ...(await fullStatus(uid, day)), ok: true, refunded: false, tool });
      }
      // Idempotency: the same credit token can only ever be refunded once, even if the
      // client's error handling fires the refund call more than once.
      const marker = `jp:refunded:${crypto.createHash("sha256").update(String(body.creditToken)).digest("hex").slice(0, 32)}`;
      const already = await redis(["GET", marker]);
      if (!already) {
        await redis(["SET", marker, "1"]);
        redis(["EXPIRE", marker, "1200"]).catch(() => {}); // only needs to outlive the token's own 5-min lifetime
        if (parsed.kind === "bonus") {
          await redis(["INCRBY", bonusKey(uid, tool), "1"]);
        } else {
          const k = useKey(uid, tool, parsed.day || day);
          const cur = await getNum(k);
          if (cur > 0) await redis(["DECR", k]); // never go below 0
        }
      }
      const full = await fullStatus(uid, day);
      return res.status(200).json({ ...full, ok: true, refunded: !already, tool });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  } catch (e) {
    // On infra error, report it but DO NOT pretend success (client decides safe behaviour).
    return res.status(200).json({ ok: false, error: e.message, softFail: true });
  }
};
