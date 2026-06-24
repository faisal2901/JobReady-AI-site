// JobReady AI — diagnostics. Open https://your-site/api/health in a browser.
// Shows exactly which Gemini models/keys work right now, and whether Upstash is connected.

const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash,gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);

function keys() {
  const list = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY2, process.env.GEMINI_API_KEY3]
    .concat((process.env.GEMINI_API_KEYS || "").split(","))
    .map((k) => (k || "").trim()).filter(Boolean);
  return [...new Set(list)];
}
function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pingModel(model, key) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say OK" }] }], generationConfig: { maxOutputTokens: 5 } }),
        signal: ctrl.signal,
      }
    );
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (r.ok) return { status: r.status, ok: true, ms };
    const body = await r.text();
    let detail = "";
    try { detail = JSON.parse(body)?.error?.message?.slice(0, 180) || ""; } catch (_) { detail = body.slice(0, 120); }
    return { status: r.status, ok: false, ms, detail };
  } catch (e) {
    return { status: 0, ok: false, ms: Date.now() - t0, detail: e.name === "AbortError" ? "timed out" : e.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  if (!ADMIN_TOKEN) return res.status(404).json({ ok: false, error: "Not found" });
  const token = req.headers["x-admin-token"];
  if (!safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const ks = keys();
  const out = {
    time: new Date().toISOString(),
    env: {
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      extraGeminiKeys: Math.max(0, ks.length - 1),
      RAPIDAPI_KEY: !!process.env.RAPIDAPI_KEY,
      UPSTASH: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
    },
    models: {},
    upstash: null,
    verdict: "",
  };

  if (out.env.UPSTASH) {
    try {
      const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/ping`, {
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
      });
      out.upstash = (await r.json()).result === "PONG" ? "connected ✅" : "responded but not PONG";
    } catch (e) { out.upstash = "ERROR: " + e.message; }
  }

  if (!ks.length) {
    out.verdict = "No GEMINI_API_KEY set.";
    return res.status(200).json(out);
  }

  let anyOk = false;
  for (let ki = 0; ki < ks.length; ki++) {
    for (const m of MODELS) {
      const r = await pingModel(m, ks[ki]);
      out.models[`key${ki + 1}:${m}`] = r;
      if (r.ok) anyOk = true;
    }
  }

  out.verdict = anyOk
    ? "✅ At least one model is healthy. The app should work."
    : "❌ ALL models are refusing requests right now. If statuses are 429 with 'quota' in the detail, the free daily limit is exhausted: wait for the daily reset, add a second API key from a different Google Cloud project (GEMINI_API_KEY2), or enable pay-as-you-go billing.";
  return res.status(200).json(out);
};
