// JobReady AI — cross-device streak sync.
// POST /api/streak  body: { email, today: "YYYY-MM-DD", streak, lastVisit }
// Stores one record per account (keyed by email) in Upstash Redis, merges the
// caller's local view with the stored value, and returns the authoritative streak.
// If Upstash is not configured it gracefully echoes the client's own values back,
// so the app keeps working (just without true cross-device sync).

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function sha(s) {
  // tiny FNV-1a hash so we never store raw emails as keys
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const keyFor = (email) => "jrstreak:" + sha(String(email).toLowerCase().trim());

async function redis(cmd) {
  const r = await fetch(`${UPSTASH_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).result;
}

// Days between two YYYY-MM-DD strings (b - a), calendar based.
function dayDiff(a, b) {
  const da = Date.parse(a + "T00:00:00Z"), db = Date.parse(b + "T00:00:00Z");
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 864e5);
}

// Roll a stored {streak,lastVisit} forward to `today`.
function roll(streak, lastVisit, today) {
  if (!lastVisit) return { streak: 1, lastVisit: today };
  if (lastVisit === today) return { streak: Math.max(1, streak), lastVisit: today };
  const diff = dayDiff(lastVisit, today);
  if (diff === 1) return { streak: Math.max(1, streak) + 1, lastVisit: today }; // consecutive day
  if (diff !== null && diff > 1) return { streak: 1, lastVisit: today };        // chain broken
  // diff <= 0 (clock skew / older date sent): keep the stronger record as-is
  return { streak: Math.max(1, streak), lastVisit };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; }
  } else if (!body) { body = {}; }

  const email = (body.email || "").trim();
  const today = (body.today || "").trim();
  const clientStreak = Math.max(1, parseInt(body.streak, 10) || 1);
  const clientLast = (body.lastVisit || today).trim();
  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return res.status(400).json({ ok: false, error: "email and today (YYYY-MM-DD) required" });
  }

  // No Upstash → behave like a pass-through using the client's own roll.
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    const out = roll(clientStreak, clientLast, today);
    return res.status(200).json({ ok: true, synced: false, ...out });
  }

  try {
    const key = keyFor(email);
    let stored = null;
    try { const raw = await redis(["GET", key]); if (raw) stored = JSON.parse(raw); } catch (_) {}

    // Start from whichever record is more advanced (handles a brand-new device
    // whose local streak is 1 but the account already has a long chain).
    let base;
    if (!stored) {
      base = { streak: clientStreak, lastVisit: clientLast };
    } else {
      const storedNewer = !clientLast || (stored.lastVisit && stored.lastVisit >= clientLast);
      base = storedNewer
        ? { streak: Math.max(stored.streak, stored.lastVisit === clientLast ? clientStreak : 0), lastVisit: stored.lastVisit }
        : { streak: clientStreak, lastVisit: clientLast };
    }

    const out = roll(base.streak, base.lastVisit, today);
    await redis(["SET", key, JSON.stringify(out)]);
    return res.status(200).json({ ok: true, synced: true, ...out });
  } catch (e) {
    const out = roll(clientStreak, clientLast, today);
    return res.status(200).json({ ok: true, synced: false, error: e.message, ...out });
  }
};
