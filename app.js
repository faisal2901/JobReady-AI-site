/* ═══════════════ JobTopper — app.js (v3) ═══════════════ */
"use strict";

/* ── CONFIG ── */
const CONFIG = {
  // Optional: paste your Google OAuth Client ID here to enable "Sign in with Google".
  // Get one free: console.cloud.google.com, APIs & Services, Credentials, Create OAuth client ID (Web).
  // Add your site URL (https://job-ready-ai-site.vercel.app) under "Authorized JavaScript origins".
  GOOGLE_CLIENT_ID: "",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── State (localStorage) ── */
const store = {
  get: (k, d) => { try { const v = localStorage.getItem("jr_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem("jr_" + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem("jr_" + k),
};
let resumeText = store.get("resume", "");
let resumeName = store.get("resumeName", "");
let lastAnalysis = store.get("analysis", null);
let tracker = store.get("tracker", []);
let user = store.get("user", null);
let ivHistory = [];
let ivActive = false;
let jobsCache = [];
let botHistory = [];

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/* ── Splash ── */
(function splash() {
  const sp = $("splash");
  if (sessionStorage.getItem("jr_splashed")) { sp.classList.add("hide"); return; }
  sessionStorage.setItem("jr_splashed", "1");
  setTimeout(() => sp.classList.add("hide"), 1800);
})();

/* ── Toast ── */
let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3400);
}

/* ── API helper with retry + hard client timeout (UI never spins forever) ── */
async function api(path, opts = {}, retries = 1, timeoutMs = 95000) {
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(path, { ...opts, signal: ctrl.signal, headers: { ...(opts.headers || {}), "X-JR-App": "1" } });
      clearTimeout(timer);
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) throw new Error(j.error || "Rate limited");
      if (!r.ok || j.ok === false) throw new Error(j.error || `Request failed (${r.status})`);
      return j;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new Error("The request took too long and was stopped. Please try again.");
      if (i === retries || /free AI credits|pause between/i.test(e.message)) throw e;
      await new Promise((s) => setTimeout(s, 1800));
    }
  }
}
const TRACKED_FEATURES = new Set(["analyze", "boost", "tailor", "coverletter", "interview", "salary", "roadmap"]);
const creditTokens = {};
const aiCall = (action, payload, retries = 1) => {
  if (TRACKED_FEATURES.has(action)) track("feature", { feature: action });
  const creditToken = creditTokens[action] || creditTokens[{ boost: "analyze", coverletter: "tailor" }[action]];
  return api("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, creditToken, ...payload }) }, retries);
};

/* ── Analytics: fire-and-forget event logging (never blocks or breaks the UI) ── */
function track(event, extra = {}) {
  try {
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-JR-App": "1" },
      body: JSON.stringify({ event, ...extra }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) { /* analytics must never affect the user */ }
}

/* ── Usage credits + referrals (server-authoritative via /api/points) ── */
const TOOL_LABELS = { jobs: "Job Openings", analyze: "Resume Analyzer", tailor: "Tailor Resume", salary: "Salary Intel", roadmap: "Career Roadmap" };
let pointsState = null; // last known status from server
let creditInFlight = false; // guards against double-click double-spend
function localDayStr() {
  const d = new Date(); const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
}
async function pointsApi(action, extra = {}) {
  if (!user?.email) return null;
  try {
    const r = await fetch("/api/points", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-JR-App": "1" },
      body: JSON.stringify({ action, email: user.email, name: user.name, day: localDayStr(), ...extra }),
    });
    return await r.json();
  } catch (_) { return null; }
}
function applyPointsState(s) {
  if (!s || s.upstash === false) { pointsState = s || pointsState; renderCredits(); return; }
  pointsState = s;
  if (Array.isArray(s.notifications)) s.notifications.forEach((n) => setTimeout(() => toast(n), 400));
  renderCredits();
  // keep the Refer page live if it's currently open
  const rv = document.getElementById("v-refer");
  if (rv && rv.classList.contains("active")) renderReferView();
}
async function refreshPoints() { applyPointsState(await pointsApi("status")); }

// Gate a tool run. Returns true ONLY if a credit was genuinely consumed.
// Prevents double-spend (in-flight lock) and never silently allows when out of credits.
async function checkCredit(tool) {
  if (!user?.email) return true;            // anonymous handled by login gate
  if (creditInFlight) { toast("⏳ One moment…"); return false; } // block rapid double-clicks
  creditInFlight = true;
  try {
    const s = await pointsApi("consume", { tool });
    // If the points service can't be reached at all, allow (don't hard-block on a network blip),
    // but this is the ONLY fail-open path and it's a true outage, not "out of credits".
    if (!s) return true;
    if (s.upstash === false) { applyPointsState(s); return true; } // credits not configured → unlimited
    if (s.softFail) return true;             // transient infra error
    applyPointsState(s);
    if (s.ok === false && s.reason === "no_credits") { showOutOfCredits(tool); return false; }
    if (s.ok === true && s.creditToken) creditTokens[tool] = s.creditToken;
    return s.ok === true;                     // only proceed if server confirms consumption
  } finally {
    creditInFlight = false;
  }
}
function referralLink() {
  const code = pointsState?.code || "";
  return location.origin + "/?ref=" + code;
}
function creditsHTML() {
  const t = pointsState.tools || {};
  const rows = Object.keys(TOOL_LABELS).map((k) => {
    const r = t[k] || { daily: 0, bonus: 0, remaining: 0, limit: 3 };
    const cls = r.remaining > 0 ? "cg" : "cr";
    const parts = [`${r.daily} daily`];
    if (r.bonus > 0) parts.push(`+${r.bonus} referral`);
    const sub = r.remaining > 0 ? parts.join(" ") : "used up — resets at midnight, or refer a friend";
    return `<div class="credit-row"><span>${TOOL_LABELS[k]}</span><span class="credit-pill ${cls}">${r.remaining} left</span></div><div class="credit-sub">${sub}</div>`;
  }).join("");
  return `<h3>🎟️ Your free credits</h3>
    <div style="font-size:12px;color:var(--mut);margin:2px 0 12px">3 free uses per tool each day. Refer a friend to instantly add 3 more per tool.</div>
    ${rows}
    <div style="font-size:11px;color:var(--dim);margin-top:10px;display:flex;gap:6px;align-items:flex-start"><span>🕛</span><span>Credits auto-refill every midnight (12 AM your local time). Unused credits don't carry over.</span></div>
    <button class="btn sm" style="margin-top:12px;width:100%" onclick="go('refer')">🎁 Refer &amp; get free credits</button>`;
}
function renderCredits() {
  const box = $("creditsBox"), rail = $("creditsRail"), mobile = $("mobileCredits");
  const empty = (!pointsState || pointsState.upstash === false);
  const html = empty ? "" : creditsHTML();
  if (box) box.innerHTML = html;
  if (rail) rail.innerHTML = html;
  if (mobile) mobile.innerHTML = empty ? "" : mobileCreditsHTML();
}
function mobileCreditsHTML() {
  const t = pointsState?.tools || {};
  const short = { jobs: "Jobs", analyze: "ATS", tailor: "Tailor", salary: "Salary", roadmap: "Roadmap" };
  const pills = Object.keys(TOOL_LABELS).map((k) => {
    const r = t[k] || { daily: 0, bonus: 0, remaining: 0 };
    return `<span class="mc-pill">${short[k]} ${r.remaining}</span>`;
  }).join("");
  return `<div class="mc-head"><span>🎟️ Available credits</span><button class="btn sm ghost" onclick="go('refer')">Refer</button></div><div class="mc-row">${pills}</div>`;
}
// Auto-detect: if referral bonus exists for this tool, offer to use it; else prompt to refer.
function showOutOfCredits(tool) {
  const label = TOOL_LABELS[tool] || "this tool";
  const bonus = pointsState?.tools?.[tool]?.bonus || 0;
  if (bonus > 0) {
    // Bonus credits exist but weren't auto-consumed (daily=0). Offer to spend one now.
    showConfirm("🎟️", `Use a referral credit?`, `You're out of today's free ${label} credits, but you have ${bonus} referral credit${bonus > 1 ? "s" : ""} for it. Use one now?`,
      "Yes, use 1 credit", async () => {
        closeCelebrate();
        const s = await pointsApi("consume", { tool });
        applyPointsState(s);
        if (s && s.ok) { toast(`✅ Used 1 referral credit. Tap the button again to run.`); }
      }, "No, keep it");
    return;
  }
  showConfirm("🎁", `Out of ${label} credits`, `You've used your 3 free ${label} credits for today. They reset at midnight (your local time). Don't want to wait? Refer 1 friend and instantly get 3 more credits for every tool, the moment they sign up.`,
    "🎁 Refer a friend", () => { closeCelebrate(); openRefer(); }, "Maybe later");
}
// Shared referral markup, used by both the full-page view and the popup.
function referContentHTML() {
  const link = referralLink();
  const count = pointsState?.referrals || 0;
  const toNext = 10 - (count % 10);
  const list = pointsState?.referralList || [];
  const historyRows = list.length
    ? list.map((r) => `<div class="ref-hist-row"><span>${esc(r.name || "Friend")}</span><span class="ref-status ok">✅ joined</span><span class="ref-date">${esc(r.date || "")}</span></div>`).join("")
    : `<div style="font-size:12.5px;color:var(--dim);padding:8px 0">No referrals yet. Share your link below, your friends will appear here once they sign up.</div>`;
  return `
    <p style="color:var(--mut);font-size:13.5px">Share your link. The moment a friend signs up, <b style="color:var(--good)">+3 credits are added to every tool</b> instantly, no waiting. Your friend also gets bonus credits for joining.</p>
    <div class="refer-codebox"><span>${esc(link)}</span><button class="btn sm" onclick="navigator.clipboard.writeText('${esc(link)}');toast('📋 Link copied!')">Copy</button></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn sm good" onclick="shareReferral('whatsapp')">💬 WhatsApp</button>
      <button class="btn sm ghost" onclick="shareReferral('any')">🔗 Share</button>
    </div>
    <div class="refer-stats">
      <div><b>${count}</b><span>Friends referred</span></div>
      <div><b>${toNext}</b><span>more for a 48h mega bonus</span></div>
    </div>
    <h4 style="margin:16px 0 6px;font-size:14px">👥 Your referrals</h4>
    <div class="ref-hist">${historyRows}</div>
    <p style="font-size:12px;color:var(--dim);margin-top:12px">🏆 Every 10 referrals unlocks a 48-hour mega bonus across all tools.</p>`;
}
// Full-page Refer & Earn view (the nav target). Always shows content, never blank.
function renderReferView() {
  const box = $("referViewBox");
  if (!box) return;
  if (!user?.email) { box.innerHTML = `<h3>🎁 Refer & Earn Credits</h3><p style="color:var(--mut);margin-top:8px">Sign in to get your referral link and start earning free credits.</p><button class="btn" style="margin-top:14px" onclick="openLogin()">Sign in</button>`; return; }
  if (!pointsState) refreshPoints();
  box.innerHTML = `<h3>🎁 Refer & Earn Credits</h3>${referContentHTML()}`;
}
// Popup version (used from the out-of-credits flow).
function openRefer() {
  const cb = $("celebrateBtn"); if (cb) { cb.textContent = "Let's keep going 🚀"; cb.onclick = closeCelebrate; }
  if (!user?.email) { openLogin(); return; }
  if (!pointsState) refreshPoints();
  $("referBody").innerHTML = referContentHTML();
  $("referModal").classList.add("show");
  $("sidebar").classList.remove("open");
}
function closeRefer() { $("referModal").classList.remove("show"); }
function shareReferral(via) {
  const link = referralLink();
  const msg = `🚀 I'm using JobTopper, a free AI career companion (resume ATS score, JD tailoring, interview practice, live jobs & more). Sign up with my link and we both get bonus credits: ${link}`;
  if (via === "whatsapp") { window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank"); return; }
  if (navigator.share) { navigator.share({ title: "JobTopper", text: msg, url: link }).catch(() => {}); }
  else { navigator.clipboard.writeText(link); toast("📋 Link copied, share it anywhere!"); }
}

/* ── Fun rotating loaders & friendly errors ── */
function creditsHTML() {
  const t = pointsState.tools || {};
  const rows = Object.keys(TOOL_LABELS).map((k) => {
    const r = t[k] || { daily: 0, bonus: 0, remaining: 0, limit: 3 };
    const cls = r.remaining > 0 ? "cg" : "cr";
    const parts = [`${r.daily} daily`];
    if (r.bonus > 0) parts.push(`${r.bonus} referral saved`);
    const sub = r.remaining > 0 ? parts.join(" + ") : "daily used up — referral credits stay saved until used";
    return `<div class="credit-row"><span>${TOOL_LABELS[k]}</span><span class="credit-pill ${cls}">${r.remaining} left</span></div><div class="credit-sub">${sub}</div>`;
  }).join("");
  return `<h3>🎟️ Your free credits</h3>
    <div style="font-size:12px;color:var(--mut);margin:2px 0 12px">3 free daily uses per tool. Refer a friend to add 3 referral credits per tool.</div>
    ${rows}
    <div style="font-size:11px;color:var(--dim);margin-top:10px;display:flex;gap:6px;align-items:flex-start"><span>🕛</span><span>Daily credits reset every midnight and don't carry over. Referral credits carry over until you use them.</span></div>
    <button class="btn sm" style="margin-top:12px;width:100%" onclick="go('refer')">🎁 Refer &amp; get free credits</button>`;
}

function referContentHTML() {
  const link = referralLink();
  const code = pointsState?.code || "";
  const count = pointsState?.referrals || 0;
  const toNext = 10 - (count % 10);
  const list = pointsState?.referralList || [];
  const historyRows = list.length
    ? list.map((r) => `<div class="ref-hist-row"><span>${esc(r.name || "Friend")}</span><span class="ref-status ok">✅ joined</span><span class="ref-date">${esc(r.date || "")}</span></div>`).join("")
    : `<div style="font-size:12.5px;color:var(--dim);padding:8px 0">No referrals yet. Share your link or code below, your friends will appear here once they sign up.</div>`;
  return `
    <p style="color:var(--mut);font-size:13.5px">Share your link or code. When a friend signs up, <b style="color:var(--good)">+3 referral credits are added to every tool</b> and they stay saved until used. Your friend gets +2 referral credits per tool for joining.</p>
    <div class="refer-codebox"><span>Your referral code: <b style="color:var(--good)">${esc(code || "Loading...")}</b></span><button class="btn sm ghost" onclick="navigator.clipboard.writeText('${esc(code)}');toast('Code copied!')" ${code ? "" : "disabled"}>Copy code</button></div>
    <div class="refer-codebox"><span>${esc(link)}</span><button class="btn sm" onclick="navigator.clipboard.writeText('${esc(link)}');toast('Link copied!')">Copy link</button></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn sm good" onclick="shareReferral('whatsapp')">💬 WhatsApp</button>
      <button class="btn sm ghost" onclick="shareReferral('any')">🔗 Share</button>
    </div>
    <div class="refer-stats">
      <div><b>${count}</b><span>Friends referred</span></div>
      <div><b>${toNext}</b><span>more for a 48h mega bonus</span></div>
    </div>
    <h4 style="margin:16px 0 6px;font-size:14px">👥 Your referrals</h4>
    <div class="ref-hist">${historyRows}</div>
    <p style="font-size:12px;color:var(--dim);margin-top:12px">🏆 Every 10 referrals unlocks a 48-hour mega bonus across all tools.</p>`;
}

function shareReferral(via) {
  const link = referralLink();
  const code = pointsState?.code || "";
  const msg = `🚀 I'm using JobTopper, a free AI career companion (resume ATS score, JD tailoring, interview practice, live jobs & more). Sign up with my link and we both get referral credits that carry over until used: ${link}${code ? ` Code: ${code}` : ""}`;
  if (via === "whatsapp") { window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank"); return; }
  if (navigator.share) { navigator.share({ title: "JobTopper", text: msg, url: link }).catch(() => {}); }
  else { navigator.clipboard.writeText(link); toast("Link copied, share it anywhere!"); }
}

let loaderTimer = null;
function loadBox(messages, subText) {
  clearInterval(loaderTimer);
  const msgs = Array.isArray(messages) ? messages : [messages];
  const lid = "lmsg" + Date.now();
  setTimeout(() => {
    let i = 0;
    loaderTimer = setInterval(() => {
      const el = $(lid);
      if (!el) return clearInterval(loaderTimer);
      i = (i + 1) % msgs.length;
      el.style.opacity = 0;
      setTimeout(() => { if ($(lid)) { $(lid).textContent = msgs[i]; $(lid).style.opacity = 1; } }, 350);
    }, 2800);
  }, 0);
  return `<div class="card"><div class="loadbox"><div class="spin"></div>
    <div class="lmsg" id="${lid}">${esc(msgs[0])}</div>
    <div class="lsub">${esc(subText || "good things take 20 to 60 seconds, worth the wait ☕")}</div></div></div>`;
}
function errBox(e, retryJs) {
  clearInterval(loaderTimer);
  const m = String(e.message || e);
  const quota = /free AI credits|pause between/i.test(m);
  if (quota) return `<div class="errcard"><div class="eico">🌙</div><div style="flex:1"><b>Free credit limit</b><p>${esc(m)}</p></div></div>`;
  const busy = /high demand|rate.?limit|busy|503|429|chai|hang tight/i.test(m);
  const net = /failed to fetch|network|timed? ?out|504/i.test(m);
  const title = busy ? "☕ Hang tight, high demand right now!" : net ? "📡 Connection hiccup" : "😅 Something went wrong";
  const sub = busy
    ? "Lots of job seekers are using JobTopper at this moment. Take a sip of chai and hit retry in about 30 seconds. Your data is safe."
    : net
      ? "Your internet or our server blinked. One retry usually fixes it."
      : m;
  return `<div class="errcard"><div class="eico">${busy ? "☕" : net ? "📡" : "🛠️"}</div>
    <div style="flex:1"><b>${esc(title)}</b><p>${esc(sub)}</p>
    ${retryJs ? `<button class="btn sm" style="margin-top:10px" onclick="${retryJs}">🔄 Retry</button>` : ""}</div></div>`;
}
function busyBtn(btn, on, label) { const b = $(btn); if (!b) return; b.disabled = on; b.innerHTML = on ? `<span class="spin"></span> Working…` : label; }

/* ── Sidebar toggle (works on desktop and mobile) ── */
function toggleSidebar() {
  if (window.innerWidth <= 920) $("sidebar").classList.toggle("open");
  else { document.body.classList.toggle("scollapsed"); updateMotRail(); }
}
$("hamb").addEventListener("click", toggleSidebar);

/* ── Collapsed-sidebar motivation rail (subtle, non-distracting) ── */
const RAIL_LINES = [
  "Keep going, your dream job is closer than you think",
  "One application a day keeps unemployment away",
  "Small steps, big careers",
  "Consistency beats talent",
  "Today's effort is tomorrow's offer letter",
  "Stay ready so you don't have to get ready",
  "Every expert was once a beginner",
  "Your next yes is worth a hundred no's",
];
let railTimer = null;
function updateMotRail() {
  const collapsed = document.body.classList.contains("scollapsed");
  const el = $("motRailText");
  if (!el) return;
  if (collapsed) {
    const show = () => {
      el.style.opacity = 0;
      setTimeout(() => { el.textContent = RAIL_LINES[Math.floor(Math.random() * RAIL_LINES.length)]; el.style.opacity = 1; }, 500);
    };
    el.textContent = RAIL_LINES[Math.floor(Math.random() * RAIL_LINES.length)];
    el.style.opacity = 1;
    clearInterval(railTimer);
    railTimer = setInterval(show, 6000); // gentle rotation, not flashy
  } else {
    clearInterval(railTimer); railTimer = null;
  }
}

/* ── AUTH with per-user vaults ── */
const DATA_KEYS_PREFIX = "jr_";
function vaultKey(email) { return "jrvault_" + hashStr(email.toLowerCase().trim()); }
function snapshotToVault(email) {
  const snap = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(DATA_KEYS_PREFIX)) snap[k] = localStorage.getItem(k);
  }
  localStorage.setItem(vaultKey(email), JSON.stringify(snap));
}
function clearWorkspace() {
  const toDel = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(DATA_KEYS_PREFIX)) toDel.push(k);
  }
  toDel.forEach((k) => localStorage.removeItem(k));
}
function restoreVault(email) {
  const raw = localStorage.getItem(vaultKey(email));
  if (!raw) return false;
  try {
    const snap = JSON.parse(raw);
    Object.entries(snap).forEach(([k, v]) => localStorage.setItem(k, v));
    return true;
  } catch { return false; }
}
function reloadStateFromStorage() {
  resumeText = store.get("resume", "");
  resumeName = store.get("resumeName", "");
  lastAnalysis = store.get("analysis", null);
  tracker = store.get("tracker", []);
  $("resumeText").value = resumeText || "";
  $("analyzeOut").innerHTML = ""; $("tailorOut").innerHTML = ""; $("salaryOut").innerHTML = ""; $("roadmapOut").innerHTML = ""; $("jobsOut").innerHTML = "";
  updateResumeBadge(); renderDashboard(); renderTracker();
}

let gisTried = 0;
function mountGoogleBtn() {
  if (!CONFIG.GOOGLE_CLIENT_ID) { $("gBtn").style.display = "none"; $("gFallback").style.display = "block"; return; }
  if (window.google?.accounts?.id) {
    try {
      google.accounts.id.initialize({ client_id: CONFIG.GOOGLE_CLIENT_ID, callback: onGoogleCred });
      $("gBtn").innerHTML = "";
      $("gBtn").style.display = "flex";
      google.accounts.id.renderButton($("gBtn"), { theme: "filled_black", size: "large", shape: "pill", width: 280 });
      return;
    } catch (_) { /* fall through */ }
  }
  if (gisTried++ < 5) return setTimeout(mountGoogleBtn, 700); // GIS script may still be loading
  $("gBtn").style.display = "none"; $("gFallback").style.display = "block";
}
function openLogin() {
  $("loginModal").classList.add("show");
  mountGoogleBtn();
}
function closeLogin() { $("loginModal").classList.remove("show"); }
function completeLogin(u) {
  user = u;
  const returning = restoreVault(u.email);
  store.set("user", u);
  if (returning) reloadStateFromStorage();
  // Analytics: a brand-new email = signup, otherwise a login.
  const isNew = !store.get("registered_" + hashStr(u.email.toLowerCase()), false);
  track(isNew ? "signup" : "login", { email: u.email, name: u.name });
  store.set("registered_" + hashStr(u.email.toLowerCase()), true);
  calcStreak();
  closeLogin(); renderAuth(); renderDashboard();
  const first = u.name.split(" ")[0];
  toast(returning
    ? `🎉 Welcome back to your JobTopper journey, ${first}! Everything is right where you left it.`
    : `🌟 Welcome aboard, ${first}! Let's get you job ready.`);
  if (isNew && !returning) {
    // New user: collect name + optional referral code, then register with points.
    $("wName").value = u.name || "";
    $("wRef").value = store.get("pendingRef", "");
    $("welcomeModal").classList.add("show");
    // tour starts after they finish the welcome step (see submitWelcome/skipWelcome)
  } else {
    // Returning user: just load the credit balance.
    pointsApi("signup", { ref: "" }).then(applyPointsState);
  }
}
// New-user welcome: save chosen name, apply referral code, then continue.
function submitWelcome() {
  const name = ($("wName").value || "").trim();
  const ref = ($("wRef").value || "").trim().toUpperCase();
  if (name && user) { user.name = name; store.set("user", user); renderAuth(); renderDashboard(); }
  $("welcomeModal").classList.remove("show");
  store.del("pendingRef");
  pointsApi("signup", { ref, name }).then((s) => { applyPointsState(s); if (ref) toast("🎟️ Referral applied! +2 bonus credits on every tool."); });
  if (!tourSeen()) setTimeout(() => startTour(false), 500);
}
function skipWelcome() {
  $("welcomeModal").classList.remove("show");
  const ref = store.get("pendingRef", "");
  store.del("pendingRef");
  pointsApi("signup", { ref }).then(applyPointsState);
  if (!tourSeen()) setTimeout(() => startTour(false), 500);
}
function onGoogleCred(resp) {
  try {
    const payload = JSON.parse(atob(resp.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    completeLogin({ name: payload.name || "User", email: payload.email || "", pic: payload.picture || "", via: "google" });
  } catch (_) { toast("Sign in failed, please try again"); }
}
// Common throwaway/disposable email domains we politely refuse, to cut down on
// bot and spam signups on the no-password email login.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com", "temp-mail.org",
  "trashmail.com", "yopmail.com", "throwawaymail.com", "getnada.com", "sharklasers.com",
  "dispostable.com", "maildrop.cc", "fakeinbox.com", "tempmailo.com", "mailnesia.com",
]);
let lastLoginAttempt = 0;
function fallbackLogin() {
  // Throttle: block rapid repeated attempts (basic bot / brute-force guard).
  const now = Date.now();
  if (now - lastLoginAttempt < 2000) return toast("⏳ One moment, please try again in a couple of seconds.");
  lastLoginAttempt = now;

  const n = $("fName").value.trim(), e = $("fEmail").value.trim().toLowerCase();
  // Name: 2 to 60 chars, letters/spaces/.'- only (no scripts, no urls).
  if (n.length < 2 || n.length > 60 || !/^[A-Za-z][A-Za-z .'-]*$/.test(n)) {
    return toast("⚠️ Please enter your real name (letters only).");
  }
  // Email: stricter RFC-ish check plus a sane length cap.
  if (e.length > 120 || !/^[\w.+-]+@[\w-]+\.[A-Za-z]{2,}$/.test(e)) {
    return toast("⚠️ Please enter a valid email address.");
  }
  const domain = e.split("@")[1] || "";
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return toast("⚠️ Please use a permanent email so we can save your progress.");
  }
  completeLogin({ name: n, email: e, pic: "", via: "email" });
}
function openSignout() { $("soModal").classList.add("show"); }
function closeSignout() { $("soModal").classList.remove("show"); }
function confirmSignout() {
  if (user?.email) { track("logout", { email: user.email }); snapshotToVault(user.email); }
  clearWorkspace();
  user = null;
  resumeText = ""; resumeName = ""; lastAnalysis = null; tracker = []; ivHistory = []; ivActive = false; jobsCache = [];
  closeSignout();
  reloadStateFromStorage();
  renderAuth();
  toast("👋 Signed out. Your data is locked safely on this device until you return.");
}
function renderAuth() {
  document.body.classList.toggle("signed-in", !!user);
  document.body.classList.toggle("signed-out", !user);
  $("authArea").innerHTML = user
    ? `<span class="userchip">${user.pic ? `<img src="${esc(user.pic)}" referrerpolicy="no-referrer">` : `<span class="av">${esc(user.name[0].toUpperCase())}</span>`}${esc(user.name.split(" ")[0])}<button class="so" onclick="openSignout()">Sign out</button></span>`
    : `<button class="btn sm" onclick="openLogin()">Sign in</button>`;
}
function requireLogin() {
  if (user) return false;
  openLogin();
  toast("🔐 Sign in (free) to use the AI tools");
  return true;
}

/* ── Navigation ── */
function hasCookieConsent() {
  return store.get("cookieConsent", false) || /(?:^|;\s*)jr_cookie_consent=accepted\b/.test(document.cookie || "");
}
function acceptCookies() {
  store.set("cookieConsent", true);
  document.cookie = "jr_cookie_consent=accepted; Max-Age=31536000; Path=/; SameSite=Lax; Secure";
  const bar = $("cookieBar");
  if (bar) bar.classList.remove("show");
}
function initCookieNotice() {
  const bar = $("cookieBar");
  if (bar && !hasCookieConsent()) setTimeout(() => bar.classList.add("show"), 900);
}

const TITLES = {
  dashboard: ["Dashboard", "Your job search, supercharged."],
  analyzer: ["Resume Analyzer & ATS Score", "Genuine, stable ATS scoring. AI rubric plus deterministic checks."],
  tailor: ["Tailor Resume for a JD", "Truthfully rewritten and keyword optimized for any job description."],
  jobs: ["Job Openings", "Fresh listings from LinkedIn, Naukri, Indeed, Glassdoor and more."],
  tracker: ["Application Tracker", "Every application, from Saved to Offer."],
  interview: ["Interview Mentor", "Practice real rounds, calibrated to your resume."],
  salary: ["Salary Intelligence", "Realistic INR figures for the Indian market."],
  roadmap: ["Career Roadmap", "A step by step plan from where you are to where you want to be."],
  refer: ["Refer & Earn Credits", "Invite friends, instantly unlock free credits for every tool."],
};
const CREDIT_TOOL_VIEWS = new Set(["analyzer", "tailor", "jobs", "salary", "roadmap"]);
function go(view) {
  document.body.dataset.view = view;
  document.body.classList.toggle("show-mobile-credits", CREDIT_TOOL_VIEWS.has(view));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.v === view));
  const sec = $("v-" + view); if (sec) sec.classList.add("active");
  $("viewTitle").textContent = (TITLES[view] || ["", ""])[0];
  $("viewSub").textContent = (TITLES[view] || ["", ""])[1];
  $("sidebar").classList.remove("open");
  window.scrollTo({ top: 0 });
  if (view === "tracker") renderTracker();
  if (view === "dashboard") renderDashboard();
  if (view === "refer") renderReferView();
  renderCredits();
}
document.querySelectorAll(".nav a").forEach((a) => a.addEventListener("click", () => go(a.dataset.v)));

/* ── Resume upload & parsing (client side) ── */
const drop = $("drop"), fileInp = $("fileInp");
drop.addEventListener("click", () => fileInp.click());
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) parseFile(e.dataTransfer.files[0]); });
fileInp.addEventListener("change", () => fileInp.files[0] && parseFile(fileInp.files[0]));
$("resumeText").addEventListener("input", () => { resumeText = $("resumeText").value; store.set("resume", resumeText); updateResumeBadge(); });

async function parseFile(file) {
  toast("Reading " + file.name + "…");
  try {
    let text = "";
    if (file.name.toLowerCase().endsWith(".pdf")) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      for (let p = 1; p <= pdf.numPages; p++) {
        const content = await (await pdf.getPage(p)).getTextContent();
        text += content.items.map((it) => it.str).join(" ") + "\n";
      }
    } else if (file.name.toLowerCase().endsWith(".docx")) {
      text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
    } else {
      text = await file.text();
    }
    text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 100) return toast("⚠️ Couldn't extract enough text, try pasting it instead.");
    resumeText = text; resumeName = file.name;
    store.set("resume", text); store.set("resumeName", file.name);
    store.set("resumeDate", new Date().toISOString());
    recordResumeHistory("uploaded", file.name);
    $("resumeText").value = text;
    updateResumeBadge();
    toast("✅ Resume loaded: " + file.name);
  } catch (e) { toast("❌ Parse error: " + e.message); }
}
/* ── Resume history: track uploads, tailors, boosts ── */
function recordResumeHistory(type, label) {
  const h = store.get("resumeHistory", { uploaded: 0, tailored: 0, boosted: 0, items: [] });
  if (type === "uploaded") h.uploaded++;
  if (type === "tailored") h.tailored++;
  if (type === "boosted") h.boosted++;
  h.items.unshift({ type, label: label || "", date: new Date().toISOString() });
  h.items = h.items.slice(0, 30);
  store.set("resumeHistory", h);
  renderResumeHistory();
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch { return ""; }
}
function renderResumeHistory() {
  const box = $("resumeHistory");
  if (!box) return;
  const h = store.get("resumeHistory", null);
  if (!h || !h.items || !h.items.length) { box.innerHTML = ""; return; }
  const icon = { uploaded: "📄", tailored: "✂️", boosted: "🚀" };
  const rows = h.items.slice(0, 8).map((it) =>
    `<div class="rh-row"><span>${icon[it.type] || "•"} ${esc(it.type)}${it.label ? " · " + esc(it.label) : ""}</span><span class="rh-date">${esc(fmtDate(it.date))}</span></div>`).join("");
  box.innerHTML = `<h3>🗂️ Your resume history</h3>
    <div class="rh-stats"><div><b>${h.uploaded}</b><span>Uploaded</span></div><div><b>${h.tailored}</b><span>Tailored</span></div><div><b>${h.boosted}</b><span>Boosted</span></div></div>
    <div class="rh-list">${rows}</div>`;
}
function renderResumeHistory() {
  const box = $("resumeHistory");
  if (!box) return;
  const h = store.get("resumeHistory", { uploaded: 0, tailored: 0, boosted: 0, items: [] });
  h.items = Array.isArray(h.items) ? h.items : [];
  const activeResumeCount = resumeText.trim().length > 100 && !h.uploaded ? 1 : 0;
  const uploaded = (h.uploaded || 0) + activeResumeCount;
  const tailored = h.tailored || 0;
  const boosted = h.boosted || 0;
  const bestScore = lastAnalysis?.atsScore ?? store.get("analysis", null)?.atsScore ?? "-";
  const icon = { uploaded: "📄", tailored: "✂️", boosted: "🚀" };
  const inferredRow = activeResumeCount
    ? `<div class="rh-row"><span>📄 Current resume loaded${resumeName ? " · " + esc(resumeName) : ""}</span><span class="rh-date">${esc(fmtDate(store.get("resumeDate", "")) || "Active")}</span></div>`
    : "";
  const rows = h.items.slice(0, 8).map((it) =>
    `<div class="rh-row"><span>${icon[it.type] || "•"} ${esc(it.type)}${it.label ? " · " + esc(it.label) : ""}</span><span class="rh-date">${esc(fmtDate(it.date))}</span></div>`).join("");
  const empty = !inferredRow && !rows;
  box.innerHTML = `<h3>🗂️ Resume activity history</h3>
    <div class="rh-stats">
      <div><b>${uploaded}</b><span>Uploaded</span></div>
      <div><b>${boosted}</b><span>Boosted</span></div>
      <div><b>${tailored}</b><span>Tailored</span></div>
      <div><b>${bestScore}</b><span>Best ATS</span></div>
    </div>
    <div class="rh-list">${inferredRow}${rows}</div>
    ${empty ? `<div style="font-size:13px;color:var(--mut);padding-top:4px">Upload a resume, boost it, or tailor it for a job. Your activity count will appear here automatically.</div>` : ""}`;
}
function updateResumeBadge() {
  const has = resumeText.trim().length > 100;
  $("resumeBadge").textContent = has ? "📄 " + (resumeName || "Resume loaded") : "📄 No resume yet";
  $("resumeBadge").className = has ? "badge g" : "badge v";
  const info = $("resumeInfo");
  if (has && resumeName) {
    info.style.display = "block";
    const d = store.get("resumeDate", "");
    $("resumeFileBadge").textContent = "✅ " + resumeName + " · " + resumeText.split(/\s+/).length + " words" + (d ? " · added " + fmtDate(d) : "");
  } else info.style.display = "none";
}
function toggleResumeEdit() { const t = $("resumeText"); t.style.display = t.style.display === "none" ? "block" : "none"; }
function needResume() { if (resumeText.trim().length < 100) { toast("⚠️ Upload or paste your resume first (Analyzer tab)"); go("analyzer"); return true; } return false; }

/* ── ANALYZER ── */
function scoreCacheKey(text, jd) {
  return "score_" + hashStr(text.replace(/\s+/g, " ").trim() + "||" + (jd || "").replace(/\s+/g, " ").trim());
}
async function runAnalyze(force) {
  if (requireLogin() || needResume()) return;
  const jd = $("analyzeJd").value.trim();
  const cacheKey = scoreCacheKey(resumeText, jd);
  const cached = store.get(cacheKey, null);
  if (cached && !force) {
    lastAnalysis = cached; store.set("analysis", cached);
    renderAnalysis(cached, cacheKey);
    toast("🔒 Same resume and JD, so here is your locked score. Edit the text to re-score.");
    return;
  }
  if (!(await checkCredit("analyze"))) return;
  busyBtn("analyzeBtn", true);
  $("analyzeOut").innerHTML = loadBox([
    "☕ Grab a chai while our AI reads every single word…",
    "🔍 Running 8 structural ATS checks…",
    "🧮 Matching keywords like a strict recruiter…",
    "📊 Calculating your locked ATS score…",
  ]);
  try {
    const { data } = await aiCall("analyze", { resume: resumeText, jd: jd || undefined });
    lastAnalysis = data; store.set("analysis", data); store.set(cacheKey, data);
    renderAnalysis(data, cacheKey);
  } catch (e) { $("analyzeOut").innerHTML = errBox(e, "runAnalyze(true)"); }
  busyBtn("analyzeBtn", false, "🔍 Analyze Resume & Get ATS Score");
}
function clearScoreCache(key) { store.del(key); runAnalyze(true); }

function gaugeSVG(score) {
  const col = score >= 75 ? "var(--good)" : score >= 50 ? "var(--warn)" : "var(--bad)";
  const C = 2 * Math.PI * 66;
  return `<div class="gauge"><svg width="158" height="158">
    <circle cx="79" cy="79" r="66" fill="none" stroke="#1d1d38" stroke-width="13"/>
    <circle cx="79" cy="79" r="66" fill="none" stroke="${col}" stroke-width="13" stroke-linecap="round"
      stroke-dasharray="${(score / 100) * C} ${C}" style="transition:stroke-dasharray 1s ease"/>
  </svg><div class="val"><b style="color:${col}">${score}</b><span>ATS SCORE</span></div></div>`;
}

function renderAnalysis(d, cacheKey) {
  const r = d.rubric || {};
  const rubricRows = [["Impact", r.impact], ["Clarity", r.clarity], ["Keywords", r.keywords], ["Formatting", r.formatting], ["Relevance", r.relevance]]
    .map(([k, v]) => `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${k}</span><b>${v ?? 0}</b></div><div class="bar"><i style="width:${v ?? 0}%"></i></div></div>`).join("");
  const sev = { high: "🔴", medium: "🟡", low: "🔵" };
  const checks = (d.structural?.checks || []).map((c) => `<div style="font-size:13px;padding:4px 0">${c.pass ? "✅" : "❌"} ${esc(c.label)}</div>`).join("");
  const kw = d.keywordMatch;
  const boostBtn = d.atsScore < 90
    ? `<button class="btn gold" style="margin-top:14px" onclick="runBoost()">🚀 Boost my score (AI rewrite, verified higher before you see it)</button>`
    : `<span class="badge g" style="margin-top:14px;display:inline-flex">🏆 Elite resume, you're in the top tier!</span>`;
  $("analyzeOut").innerHTML = `
  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>Your ATS Score</h3>
      <div class="gauge-wrap" style="margin-top:12px">${gaugeSVG(d.atsScore)}
        <div style="flex:1;min-width:200px">${rubricRows}</div></div>
      <p style="margin-top:12px;font-size:13.5px;color:var(--mut)">${esc(d.summary || "")}</p>
      <div style="margin-top:8px"><span class="badge c">🎯 ${esc(d.roleGuess || "")}</span> <span class="badge v">${esc(d.experienceLevel || "")}</span> <span class="badge g">🔒 score locked for this version</span></div>
      ${boostBtn}
      ${cacheKey ? `<div><button class="btn sm ghost" style="margin-top:10px" onclick="clearScoreCache('${cacheKey}')">🔄 Force fresh re-analysis</button></div>` : ""}
    </div>
    <div class="card"><h3>🧱 ATS Structural Checks <span class="badge v" style="margin-left:6px">${d.structural?.score ?? 0}/100</span></h3>
      <div style="margin-top:8px">${checks}</div></div>
  </div>
  <div id="boostOut"></div>
  ${kw ? `<div class="card" style="margin-bottom:16px"><h3>🔑 Keyword Match vs JD <span class="badge ${kw.pct >= 60 ? "g" : kw.pct >= 35 ? "y" : "r"}" style="margin-left:6px">${kw.pct}%</span></h3>
    <div style="margin-top:10px;font-size:12.5px;color:var(--mut)">MISSING (add these if true for you):</div>
    <div>${kw.missing.slice(0, 25).map((w) => `<span class="chip miss">${esc(w)}</span>`).join("")}</div></div>` : ""}
  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>💪 Strengths</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(d.strengths || []).map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join("")}</ul></div>
    <div class="card"><h3>⚡ Quick Wins (10 minute fixes)</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(d.quickWins || []).map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join("")}</ul></div>
  </div>
  <div class="card"><h3>🛠️ Issues & Fixes</h3><div style="margin-top:12px">
    ${(d.issues || []).map((i) => `<div class="issue"><span class="sev">${sev[i.severity] || "🔵"}</span><div><div>${esc(i.issue)}</div><div class="fix">→ ${esc(i.fix)}</div></div></div>`).join("")}
  </div>
  <button class="btn" style="margin-top:10px" onclick="go('tailor')">✂️ Now tailor it to a JD</button></div>`;
  renderDashboard();
}

/* ── BOOST (verified higher score) ── */
let lastBoosted = null;
async function runBoost() {
  if (requireLogin() || needResume()) return;
  const out = $("boostOut") || $("analyzeOut");
  out.innerHTML = loadBox([
    "🚀 Rewriting every bullet for maximum impact…",
    "✍️ Upgrading weak phrases into recruiter magnets…",
    "🧪 Re-scoring the new version with the same strict audit…",
    "🔁 Polishing again if the score isn't clearly higher…",
    "☕ Almost there, verifying your improved score…",
  ], "this one double checks itself, allow up to 90 seconds");
  try {
    const { data } = await aiCall("boost", {
      resume: resumeText,
      jd: $("analyzeJd").value.trim() || undefined,
      originalScore: lastAnalysis?.atsScore,
    }, 0);
    lastBoosted = data;
    recordResumeHistory("boosted", "");
    const oldS = lastAnalysis?.atsScore;
    const newS = data.verifiedScore;
    const up = oldS ? newS - oldS : null;
    out.innerHTML = `
    <div class="card" style="margin-bottom:16px;border-color:rgba(251,191,36,.4)">
      <h3>🚀 Your Boosted Resume
        <span class="badge g" style="margin-left:6px">✅ Verified new score: ${newS}${oldS ? ` (was ${oldS}${up > 0 ? ", +" + up : ""})` : ""}</span>
      </h3>
      <p style="font-size:12.5px;color:var(--dim);margin-top:4px">We re-ran the exact same strict ATS audit on this version before showing it to you.</p>
      <div style="margin:12px 0;display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn good sm" onclick="useBoosted()">✅ Use this as my resume</button>
        <button class="btn sm ghost" onclick="downloadDoc(lastBoosted.boostedResume,'Resume_Boosted','pdf')">⬇️ PDF</button>
        <button class="btn sm ghost" onclick="downloadDoc(lastBoosted.boostedResume,'Resume_Boosted','word')">⬇️ Word</button>
        <button class="btn sm ghost" onclick="navigator.clipboard.writeText(lastBoosted.boostedResume);toast('📋 Copied!')">📋 Copy</button>
      </div>
      <pre class="resume-out">${esc(data.boostedResume)}</pre>
      ${data.honestyNote ? `<div style="margin-top:12px;font-size:13px;color:var(--warn)">🤝 Honesty note: ${esc(data.honestyNote)}</div>` : ""}
    </div>
    <div class="card" style="margin-bottom:16px"><h3>📝 What was improved</h3>
      <ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(data.improvements || []).map((c) => `<li style="margin-bottom:6px">${esc(c)}</li>`).join("")}</ul></div>`;
    out.scrollIntoView({ behavior: "smooth" });
  } catch (e) { out.innerHTML = errBox(e, "runBoost()"); }
}
function useBoosted() {
  if (!lastBoosted) return;
  resumeText = lastBoosted.boostedResume;
  resumeName = (resumeName || "resume").replace(/\.(pdf|docx|txt)$/i, "").replace(/ \(boosted\)$/, "") + " (boosted)";
  store.set("resume", resumeText); store.set("resumeName", resumeName);
  $("resumeText").value = resumeText;
  updateResumeBadge();
  // Seed the score cache with the verified analysis so re-scoring shows the exact same number
  if (lastBoosted.verifiedAnalysis) {
    const jd = $("analyzeJd").value.trim();
    const key = scoreCacheKey(resumeText, jd);
    store.set(key, lastBoosted.verifiedAnalysis);
    lastAnalysis = lastBoosted.verifiedAnalysis;
    store.set("analysis", lastAnalysis);
    renderAnalysis(lastAnalysis, key);
  }
  toast("✅ Boosted resume is now active, score " + (lastBoosted.verifiedScore || ""));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── Professional document rendering (PDF / Word) ── */
function parseResumeLines(text) {
  const lines = text.split("\n");
  const out = [];
  let first = true, second = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (first && t) { out.push({ type: "name", text: t }); first = false; second = true; continue; }
    if (second && t) { out.push({ type: "contact", text: t }); second = false; continue; }
    if (!t) { out.push({ type: "blank" }); continue; }
    if (/^[A-Z][A-Z &/()'.-]{3,}$/.test(t) && t.length < 45) { out.push({ type: "head", text: t }); continue; }
    if (/^[•\-\*]\s*/.test(t)) { out.push({ type: "bullet", text: t.replace(/^[•\-\*]\s*/, "") }); continue; }
    if (/\sat\s.*\||—|\s\|\s/.test(t) && t.length < 110 && !/[.:]$/.test(t)) { out.push({ type: "sub", text: t }); continue; }
    out.push({ type: "text", text: t });
  }
  return out;
}
function downloadDoc(text, name, fmt) {
  if (!text) return;
  if (fmt === "pdf") return resumePDF(text, name);
  if (fmt === "word") return resumeWord(text, name);
  dlBlob(new Blob([text], { type: "text/plain" }), name + ".txt");
}
function dlBlob(blob, fname) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname; a.click(); URL.revokeObjectURL(a.href); }

function resumePDF(text, fname) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = 595, M = 48, CW = W - 2 * M;
  let y = 52;
  const ensure = (need) => { if (y + need > 792) { doc.addPage(); y = 52; } };
  for (const seg of parseResumeLines(text)) {
    if (seg.type === "blank") { y += 4; continue; }
    if (seg.type === "name") {
      doc.setFont("helvetica", "bold"); doc.setFontSize(19); doc.setTextColor(20, 20, 40);
      doc.text(seg.text, W / 2, y, { align: "center" }); y += 18; continue;
    }
    if (seg.type === "contact") {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(90, 90, 110);
      doc.text(seg.text, W / 2, y, { align: "center" }); y += 10;
      doc.setDrawColor(120, 92, 255); doc.setLineWidth(1.2); doc.line(M, y + 6, W - M, y + 6); y += 22; continue;
    }
    if (seg.type === "head") {
      ensure(34); y += 10;
      doc.setFont("helvetica", "bold"); doc.setFontSize(11.5); doc.setTextColor(70, 50, 160);
      doc.text(seg.text, M, y); y += 5;
      doc.setDrawColor(200, 200, 215); doc.setLineWidth(0.7); doc.line(M, y, W - M, y); y += 13; continue;
    }
    if (seg.type === "sub") {
      ensure(16); doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 30, 50);
      const w = doc.splitTextToSize(seg.text, CW);
      w.forEach((ln) => { ensure(13); doc.text(ln, M, y); y += 13; });
      y += 1; continue;
    }
    if (seg.type === "bullet") {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.8); doc.setTextColor(45, 45, 60);
      const w = doc.splitTextToSize(seg.text, CW - 14);
      ensure(12 * w.length);
      doc.text("•", M + 2, y);
      w.forEach((ln) => { ensure(12); doc.text(ln, M + 14, y); y += 12; });
      y += 1.5; continue;
    }
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.8); doc.setTextColor(45, 45, 60);
    const w = doc.splitTextToSize(seg.text, CW);
    w.forEach((ln) => { ensure(12); doc.text(ln, M, y); y += 12; });
    y += 1;
  }
  doc.save(fname + ".pdf");
}

function resumeWord(text, fname) {
  let body = "";
  for (const seg of parseResumeLines(text)) {
    if (seg.type === "blank") { body += `<p style="margin:0;font-size:6pt">&nbsp;</p>`; continue; }
    const t = esc(seg.text);
    if (seg.type === "name") body += `<p style="text-align:center;font-size:19pt;font-weight:bold;margin:0 0 4pt;color:#141428">${t}</p>`;
    else if (seg.type === "contact") body += `<p style="text-align:center;font-size:9.5pt;color:#5a5a6e;margin:0 0 6pt;border-bottom:2px solid #7c5cff;padding-bottom:8pt">${t}</p>`;
    else if (seg.type === "head") body += `<p style="font-size:11.5pt;font-weight:bold;color:#4632a0;border-bottom:1px solid #c8c8d7;margin:12pt 0 5pt;letter-spacing:.5pt">${t}</p>`;
    else if (seg.type === "sub") body += `<p style="font-size:10pt;font-weight:bold;margin:7pt 0 2pt;color:#1e1e32">${t}</p>`;
    else if (seg.type === "bullet") body += `<p style="font-size:9.8pt;margin:0 0 2.5pt 14pt;text-indent:-9pt;color:#2d2d3c">•&nbsp;&nbsp;${t}</p>`;
    else body += `<p style="font-size:9.8pt;margin:0 0 3pt;color:#2d2d3c">${t}</p>`;
  }
  const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial,sans-serif;line-height:1.38;margin:.7in .75in}</style></head><body>${body}</body></html>`;
  dlBlob(new Blob(["﻿" + html], { type: "application/msword" }), fname + ".doc");
}

/* ── TAILOR ── */
let lastTailored = null;
function prefillTailor(title, company, jd) { $("tJobTitle").value = title || ""; $("tCompany").value = company || ""; $("tJd").value = jd || ""; go("tailor"); }
function tailorBase() { return ("Resume_" + ($("tJobTitle").value || "Tailored").replace(/[^\w]+/g, "_")).slice(0, 60); }
async function runTailor() {
  if (requireLogin() || needResume()) return;
  const jd = $("tJd").value.trim();
  if (jd.length < 50) return toast("⚠️ Paste the Job Description first");
  if (!(await checkCredit("tailor"))) return;
  store.set("used_tailor", true);
  recordResumeHistory("tailored", $("tJobTitle").value || "");
  busyBtn("tailorBtn", true);
  $("tailorOut").innerHTML = loadBox([
    "✂️ Reading the JD like a hiring manager…",
    "🔑 Re-prioritizing your real wins for this role…",
    "☕ Have a coffee while we craft a portal ready resume…",
    "📄 Formatting clean sections recruiters love…",
  ]);
  try {
    const { data } = await aiCall("tailor", { resume: resumeText, jd, jobTitle: $("tJobTitle").value, company: $("tCompany").value });
    lastTailored = data;
    $("tailorOut").innerHTML = `
    <div class="card" style="margin-bottom:16px"><h3>✅ Tailored Resume <span class="badge g" style="margin-left:6px">~${data.matchEstimate || "?"}% match</span> <span class="badge c">portal ready format</span></h3>
      <div style="margin:12px 0;display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn sm good" onclick="downloadDoc(lastTailored.tailoredResume,tailorBase(),'pdf')">⬇️ Download PDF</button>
        <button class="btn sm good" onclick="downloadDoc(lastTailored.tailoredResume,tailorBase(),'word')">⬇️ Download Word</button>
        <button class="btn sm ghost" onclick="downloadDoc(lastTailored.tailoredResume,tailorBase(),'txt')">⬇️ TXT</button>
        <button class="btn sm ghost" onclick="navigator.clipboard.writeText(lastTailored.tailoredResume);toast('📋 Copied!')">📋 Copy</button>
      </div>
      <pre class="resume-out">${esc(data.tailoredResume)}</pre></div>
    <div class="grid g2">
      <div class="card"><h3>📝 What changed</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(data.changes || []).map((c) => `<li style="margin-bottom:6px">${esc(c)}</li>`).join("")}</ul></div>
      <div class="card"><h3>🔑 Keywords woven in</h3><div style="margin-top:10px">${(data.keywordsAdded || []).map((k) => `<span class="chip hit">${esc(k)}</span>`).join("")}</div></div>
    </div>`;
  } catch (e) { $("tailorOut").innerHTML = errBox(e, "runTailor()"); }
  busyBtn("tailorBtn", false, "✂️ Tailor My Resume");
}
async function runCoverLetter() {
  if (requireLogin() || needResume()) return;
  const jd = $("tJd").value.trim();
  if (jd.length < 50) return toast("⚠️ Paste the Job Description first");
  if (!(await checkCredit("tailor"))) return;
  busyBtn("clBtn", true);
  try {
    const { data } = await aiCall("coverletter", { resume: resumeText, jd, jobTitle: $("tJobTitle").value, company: $("tCompany").value });
    $("tailorOut").insertAdjacentHTML("afterbegin",
      `<div class="card" style="margin-bottom:16px"><h3>✉️ Cover Letter</h3>
      <div style="margin:10px 0"><button class="btn sm ghost" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.textContent);toast('Copied!')">📋 Copy</button></div>
      <pre class="resume-out">${esc(data.coverLetter)}</pre></div>`);
  } catch (e) { toast("❌ " + e.message); }
  busyBtn("clBtn", false, "✉️ Generate Cover Letter");
}

/* ── JOBS ── */
async function searchJobs(page) {
  if (requireLogin()) return;
  const q = $("jQ").value.trim();
  if (!q) return toast("⚠️ Enter a role or keywords");
  // Only a brand-new search costs a credit; "Load more" pagination is free.
  if (page === 1) {
    if (!(await checkCredit("jobs"))) return;
    track("feature", { feature: "jobs" });
  }
  busyBtn("jobsBtn", true);
  if (page === 1) {
    $("jobsOut").innerHTML = loadBox([
      "🛰️ Scanning LinkedIn, Naukri, Indeed, Glassdoor…",
      "☕ Sip your chai, fresh openings incoming…",
      "📍 Filtering for your city and timeline…",
    ], "usually 5 to 15 seconds");
    jobsCache = [];
  }
  $("jobsMore").innerHTML = "";
  try {
    const p = new URLSearchParams({ q, location: $("jLoc").value.trim() || "India", datePosted: $("jDate").value, page: String(page) });
    if ($("jRemote").checked) p.set("remote", "true");
    if ($("jType").value) p.set("employmentType", $("jType").value);
    const j = await api("/api/jobs?" + p, { headers: { "X-JR-Credit": creditTokens.jobs || "" } }, 1);
    jobsCache = page === 1 ? j.jobs : jobsCache.concat(j.jobs);
    renderJobs();
    if (j.jobs.length >= 8) $("jobsMore").innerHTML = `<button class="btn ghost" onclick="searchJobs(${page + 1})">Load more ↓</button>`;
    if (!j.jobs.length && page === 1) $("jobsOut").innerHTML = `<div class="card" style="text-align:center;color:var(--mut)">No fresh listings found. Try "Last 3 days", a broader keyword, or leave city blank for all India.</div>`;
  } catch (e) { $("jobsOut").innerHTML = errBox(e, "searchJobs(1)"); }
  busyBtn("jobsBtn", false, "💼 Search Fresh Openings");
}
function fmtSalary(j) {
  if (!j.salaryMin && !j.salaryMax) return "";
  const f = (n) => (n >= 100000 ? (n / 100000).toFixed(1) + "L" : Math.round(n / 1000) + "k");
  return `₹${f(j.salaryMin || j.salaryMax)}${j.salaryMax && j.salaryMin ? "–" + f(j.salaryMax) : ""}/${(j.salaryPeriod || "yr").toLowerCase()}`;
}
function renderJobs() {
  $("jobsOut").innerHTML = jobsCache.map((j, i) => `
  <div class="card" style="margin-bottom:13px"><div class="job">
    <div class="jlogo">${j.logo ? `<img src="${esc(j.logo)}" onerror="this.outerHTML=this.alt" alt="${esc((j.company || "?")[0])}">` : esc((j.company || "?")[0])}</div>
    <div style="flex:1;min-width:0">
      <h4>${esc(j.title)}</h4>
      <div class="meta">
        <span>🏢 ${esc(j.company || "?")}</span><span>📍 ${esc(j.location || "?")}${j.remote ? " · 🏠 Remote" : ""}</span>
        ${j.postedText ? `<span>🕐 ${esc(j.postedText)}</span>` : ""}${j.employmentType ? `<span>💼 ${esc(j.employmentType.toLowerCase())}</span>` : ""}
        ${fmtSalary(j) ? `<span style="color:var(--good)">💰 ${fmtSalary(j)}</span>` : ""}
        ${j.publisher ? `<span class="badge c" style="font-size:10px">${esc(j.publisher)}</span>` : ""}
      </div>
      <div class="actions">
        <a class="btn sm" href="${esc(j.applyLink)}" target="_blank" rel="noopener" onclick="autoTrack(${i})">🚀 View & Apply on ${esc(j.publisher || "site")}</a>
        <button class="btn sm ghost" onclick="tailorForJob(${i})">✂️ Tailor resume for this</button>
        <button class="btn sm ghost" onclick="markApplied(${i})">✅ I applied</button>
        <button class="btn sm ghost" onclick="saveJob(${i})">🔖 Save</button>
        <button class="btn sm ghost" onclick="toggleJD(${i})">📃 View JD</button>
      </div>
      <pre class="resume-out" id="jd-${i}" style="display:none;margin-top:10px;max-height:260px">${esc(j.description)}</pre>
    </div></div></div>`).join("");
}
function toggleJD(i) { const el = $("jd-" + i); el.style.display = el.style.display === "none" ? "block" : "none"; }
function tailorForJob(i) { const j = jobsCache[i]; prefillTailor(j.title, j.company, j.description); }
function safeUrl(u) { try { const x = new URL(u); return (x.protocol === "https:" || x.protocol === "http:") ? x.href : ""; } catch { return ""; } }
function upsertTrack(j, status) {
  const ex = tracker.find((t) => t.id === j.id);
  if (ex) { ex.status = status; }
  else tracker.unshift({ id: j.id, title: j.title, company: j.company, link: safeUrl(j.applyLink), status, date: new Date().toISOString().slice(0, 10) });
  store.set("tracker", tracker);
}
function saveJob(i) { upsertTrack(jobsCache[i], "Saved"); toast("🔖 Saved to tracker"); }
function autoTrack(i) {
  const j = jobsCache[i];
  const ex = tracker.find((t) => t.id === j.id);
  if (!ex || ex.status === "Saved") { upsertTrack(j, "Viewed"); toast("👀 Marked as Viewed. Hit '✅ I applied' once you actually apply."); }
}
function markApplied(i) { upsertTrack(jobsCache[i], "Applied"); toast("📨 Marked as Applied. All the best! 🍀"); renderDashboard(); }

/* ── TRACKER ── */
const STATUSES = ["Saved", "Viewed", "Applied", "Interview", "Offer", "Rejected"];
function addManual() {
  const t = $("mTitle").value.trim(), c = $("mCompany").value.trim();
  if (!t || !c) return toast("⚠️ Enter title and company");
  tracker.unshift({ id: "m" + Date.now(), title: t, company: c, link: safeUrl($("mLink").value.trim()), status: "Applied", date: new Date().toISOString().slice(0, 10) });
  store.set("tracker", tracker);
  $("mTitle").value = $("mCompany").value = $("mLink").value = "";
  renderTracker(); toast("✅ Added");
}
function setStatus(id, s) { const t = tracker.find((x) => x.id === id); if (t) { t.status = s; store.set("tracker", tracker); renderTracker(); } }
function delTrack(id) { tracker = tracker.filter((x) => x.id !== id); store.set("tracker", tracker); renderTracker(); }
function renderTracker() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, tracker.filter((t) => t.status === s).length]));
  $("trackStats").innerHTML = STATUSES.map((s) => `<div class="ts"><b class="st-${s}">${counts[s]}</b><span>${s}</span></div>`).join("");
  $("trackList").innerHTML = tracker.length ? tracker.map((t) => `
    <div class="trow">
      <div class="ti"><b>${esc(t.title)}</b><span>${esc(t.company)} · added ${esc(t.date)}${safeUrl(t.link) ? ` · <a href="${esc(safeUrl(t.link))}" target="_blank" rel="noopener" style="color:var(--cyan)">link ↗</a>` : ""}</span></div>
      <select onchange="setStatus('${esc(t.id)}',this.value)">${STATUSES.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select>
      <button class="btn sm ghost" onclick="delTrack('${esc(t.id)}')">🗑️</button>
    </div>`).join("")
    : `<div class="card" style="text-align:center;color:var(--mut)">No applications tracked yet. Search jobs and hit <b>Apply</b> or <b>Save</b>, they'll appear here automatically.</div>`;
  renderDashboard();
}

/* ── INTERVIEW MENTOR ── */
function pushMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "me" : "ai");
  div.textContent = text;
  $("ivMsgs").appendChild(div);
  $("ivMsgs").scrollTop = $("ivMsgs").scrollHeight;
  return div;
}
function mentorStatus(text) {
  const div = document.createElement("div");
  div.className = "msg status";
  div.innerHTML = esc(text) + '<span class="tdots"><i></i><i></i><i></i></span>';
  $("ivMsgs").appendChild(div);
  $("ivMsgs").scrollTop = $("ivMsgs").scrollHeight;
  return div;
}
async function startInterview() {
  if (requireLogin()) return;
  store.set("used_interview", true);
  ivHistory = []; ivActive = true;
  $("ivMsgs").innerHTML = "";
  $("ivEndBtn").style.display = "inline-flex";
  $("ivStartBtn").style.display = "none";
  await coachTurn("start");
}
async function sendInterview() {
  const txt = $("ivInp").value.trim();
  if (!txt) return;
  if (!ivActive) return toast("⚠️ Click Start New Session first");
  // Stop any active voice capture and fully reset the transcript buffer, so the
  // previous answer's dictated text never carries over into the next message.
  if (typeof micWanted !== "undefined" && micWanted) {
    micWanted = false;
    try { recog && recog.stop(); } catch (_) {}
    if (typeof micUI === "function") micUI(false);
  }
  micFinal = "";
  micBase = "";
  micFinalParts = [];
  $("ivInp").value = "";
  pushMsg("user", txt);
  ivHistory.push({ role: "user", text: txt });
  await coachTurn("reply");
}
async function endInterview() {
  if (!ivActive) return;
  ivActive = false;
  $("ivEndBtn").style.display = "none";
  $("ivStartBtn").style.display = "inline-flex";
  await coachTurn("end");
}
async function coachTurn(kind) {
  $("ivSend").disabled = true;
  const status = mentorStatus(
    kind === "start" ? "🎙️ Your mentor is starting the interview"
      : kind === "end" ? "🏁 Your mentor is preparing your final report"
        : "💬 Your mentor is reviewing your answer"
  );
  try {
    const { data } = await aiCall("interview", {
      resume: resumeText || undefined,
      role: $("ivRole").value || undefined,
      mode: $("ivMode").value,
      history: ivHistory,
      end: kind === "end" || undefined,
    });
    status.remove();
    pushMsg("ai", data.reply);
    ivHistory.push({ role: "ai", text: data.reply });
    if (kind === "end") pushMsg("ai", "🙌 Session complete. Start a new session anytime, I'll make it a little harder next round!");
  } catch (e) {
    status.remove();
    const m = String(e.message || "");
    if (/free AI credits|pause between/i.test(m)) pushMsg("ai", m);
    else if (/Forbidden|403/i.test(m)) pushMsg("ai", "🔄 Your app version looks outdated. Press Ctrl + Shift + R to refresh the page, then continue your session.");
    else pushMsg("ai", "☕ High demand right now. Give it about 30 seconds and try again, your session is safe.");
    if (kind === "end") { ivActive = true; $("ivEndBtn").style.display = "inline-flex"; $("ivStartBtn").style.display = "none"; }
  }
  $("ivSend").disabled = false;
}

/* ── SALARY (locked results) ── */
async function runSalary(force) {
  if (requireLogin()) return;
  const role = $("sRole").value.trim();
  if (!role) return toast("⚠️ Enter a role");
  store.set("used_salary", true);
  const key = "sal_" + hashStr([role, $("sCity").value, $("sYears").value, $("sSkills").value].join("|").toLowerCase().replace(/\s+/g, " "));
  const cached = store.get(key, null);
  if (cached && !force) { renderSalary(role, cached, key); toast("🔒 Same inputs, so here are your locked figures."); return; }
  if (!(await checkCredit("salary"))) return;
  busyBtn("salaryBtn", true);
  $("salaryOut").innerHTML = loadBox([
    "💰 Crunching Indian market compensation data…",
    "🏙️ Comparing Bengaluru vs Hyderabad vs Mumbai…",
    "☕ One chai later, your numbers will be ready…",
  ]);
  try {
    const { data: d } = await aiCall("salary", { role, city: $("sCity").value, years: $("sYears").value, skills: $("sSkills").value });
    store.set(key, d);
    renderSalary(role, d, key);
  } catch (e) { $("salaryOut").innerHTML = errBox(e, "runSalary()"); }
  busyBtn("salaryBtn", false, "💰 Get Salary Intelligence");
}
function clearSalCache(key) { store.del(key); runSalary(true); }
function renderSalary(role, d, key) {
  const maxC = Math.max(...(d.byCity || []).map((c) => c.median), 1);
  $("salaryOut").innerHTML = `
  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>💰 ${esc(role)}: Expected CTC <span class="badge g" style="margin-left:6px">🔒 locked for these inputs</span></h3>
      <div style="display:flex;gap:18px;margin-top:16px;text-align:center">
        <div style="flex:1"><b style="font-size:22px;font-family:'Sora';color:var(--mut)">₹${d.low}L</b><div style="font-size:11.5px;color:var(--dim)">LOW</div></div>
        <div style="flex:1.2;background:rgba(124,92,255,.12);border:1px solid rgba(124,92,255,.4);border-radius:14px;padding:8px"><b style="font-size:28px;font-family:'Sora';background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent">₹${d.median}L</b><div style="font-size:11.5px;color:var(--mut)">MEDIAN</div></div>
        <div style="flex:1"><b style="font-size:22px;font-family:'Sora';color:var(--good)">₹${d.high}L</b><div style="font-size:11.5px;color:var(--dim)">HIGH</div></div>
      </div>
      <p style="margin-top:14px;font-size:13px;color:var(--mut)">${esc(d.notes || "")}</p>
      ${key ? `<button class="btn sm ghost" style="margin-top:8px" onclick="clearSalCache('${key}')">🔄 Refresh estimate</button>` : ""}</div>
    <div class="card"><h3>🏙️ Median by city</h3><div style="margin-top:12px">
      ${(d.byCity || []).map((c) => `<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(c.city)}</span><b>₹${c.median}L</b></div><div class="bar"><i style="width:${Math.round((c.median / maxC) * 100)}%"></i></div></div>`).join("")}</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>📈 Skills that boost pay</h3><div style="margin-top:10px">${(d.skillsThatBoostPay || []).map((s) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13.5px"><span>${esc(s.skill)}</span><b style="color:var(--good)">${esc(s.impact)}</b></div>`).join("")}
      <div style="margin-top:12px;font-size:12.5px;color:var(--dim)">Top paying: ${(d.topPayingCompanies || []).map(esc).join(" · ")}</div></div>
    <div class="card"><h3>🤝 Negotiation tips (India)</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(d.negotiationTips || []).map((t) => `<li style="margin-bottom:7px">${esc(t)}</li>`).join("")}</ul></div>
  </div>
  <p style="margin-top:12px;font-size:12px;color:var(--dim)">AI generated estimates based on Indian market patterns. Verify on AmbitionBox or Glassdoor before negotiating.</p>`;
}

/* ── ROADMAP (locked, resume based) ── */
async function runRoadmap(force) {
  if (requireLogin()) return;
  const target = $("rTarget").value.trim();
  if (!target) return toast("⚠️ Enter your target role");
  store.set("used_roadmap", true);
  const key = "rm_" + hashStr([target, $("rCurrent").value, $("rTimeline").value, resumeText.slice(0, 4000)].join("|").toLowerCase().replace(/\s+/g, " "));
  const cached = store.get(key, null);
  if (cached && !force) { renderRoadmap(cached, key); toast("🔒 Same inputs, so here is your locked roadmap."); return; }
  if (!(await checkCredit("roadmap"))) return;
  busyBtn("roadmapBtn", true);
  $("roadmapOut").innerHTML = loadBox([
    "🗺️ Reading your resume gap by gap…",
    "🎯 Plotting milestones you can actually hit…",
    "☕ Brewing your personalised plan…",
  ]);
  try {
    const { data: d } = await aiCall("roadmap", { resume: resumeText || undefined, currentRole: $("rCurrent").value, targetRole: target, timeline: $("rTimeline").value });
    store.set(key, d);
    renderRoadmap(d, key);
  } catch (e) { $("roadmapOut").innerHTML = errBox(e, "runRoadmap()"); }
  busyBtn("roadmapBtn", false, "🗺️ Build My Roadmap");
}
function clearRmCache(key) { store.del(key); runRoadmap(true); }
function renderRoadmap(d, key) {
  $("roadmapOut").innerHTML = `
  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>🧩 Gap Analysis <span class="badge g" style="margin-left:6px">🔒 locked for these inputs</span></h3>
      <div style="margin-top:10px">${(d.gapAnalysis || []).map((g) => `<span class="chip miss">${esc(g)}</span>`).join("")}</div>
      <div style="margin-top:10px;font-size:13px;color:var(--mut)">⏱️ Recommended: <b>${esc(d.weeklyHours || "8-10 hrs/week")}</b></div>
      ${key ? `<button class="btn sm ghost" style="margin-top:10px" onclick="clearRmCache('${key}')">🔄 Rebuild roadmap</button>` : ""}</div>
    <div class="card"><h3>💪 Already strong (from your resume)</h3>
      <div style="margin-top:10px">${(d.alreadyStrong || []).map((g) => `<span class="chip hit">${esc(g)}</span>`).join("") || '<span style="color:var(--dim);font-size:13px">Upload your resume in the Analyzer tab for this.</span>'}</div></div>
  </div>
  <div class="card" style="margin-bottom:16px"><h3>🗓️ Your plan</h3><div style="margin-top:16px">
    ${(d.phases || []).map((p) => `<div class="phase"><h4>${esc(p.title)}</h4>
      <div style="font-size:13px;color:var(--acc2)">${(p.goals || []).map(esc).join(" · ")}</div>
      <ul>${(p.actions || []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
      ${(p.resources || []).length ? `<div style="margin-top:7px;font-size:12.5px">📚 ${(p.resources || []).map((r) => r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : esc(r.name)).join(" · ")}</div>` : ""}
    </div>`).join("")}</div></div>
  <div class="grid g2">
    <div class="card"><h3>🛠️ Portfolio projects to build</h3>${(d.projects || []).map((p) => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><b style="font-size:14px">${esc(p.name)}</b><div style="font-size:13px;color:var(--mut);margin-top:3px">${esc(p.description)}</div><div style="margin-top:5px">${(p.skills || []).map((s) => `<span class="chip hit">${esc(s)}</span>`).join("")}</div></div>`).join("")}</div>
    <div class="card"><h3>🏁 Milestones & certs</h3>
      <ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(d.milestones || []).map((m) => `<li style="margin-bottom:6px">${esc(m)}</li>`).join("")}</ul>
      <div style="margin-top:12px;font-size:13px"><b>Worth-it certifications:</b><div style="margin-top:6px">${(d.certifications || []).map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div></div></div>
  </div>`;
}

/* ── JUNO CHATBOT ── */
function toggleBot() { $("botPanel").classList.toggle("show"); }
function botMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "me" : "ai");
  div.textContent = text;
  $("botMsgs").appendChild(div);
  $("botMsgs").scrollTop = $("botMsgs").scrollHeight;
  return div;
}
function junoTyping() {
  const div = document.createElement("div");
  div.className = "msg status";
  div.innerHTML = 'Juno is typing<span class="tdots"><i></i><i></i><i></i></span>';
  $("botMsgs").appendChild(div);
  $("botMsgs").scrollTop = $("botMsgs").scrollHeight;
  return div;
}
function askBot(q) { $("botInp").value = q; sendBot(); }
async function sendBot() {
  const q = $("botInp").value.trim();
  if (!q) return;
  $("botInp").value = "";
  botMsg("user", q);
  botHistory.push({ role: "user", text: q });
  const typing = junoTyping();
  try {
    const { data } = await aiCall("support", { question: q, history: botHistory.slice(-8) }, 1);
    typing.remove();
    botMsg("ai", data.reply);
    botHistory.push({ role: "ai", text: data.reply });
  } catch (e) {
    typing.remove();
    const m = String(e.message || "");
    if (/free AI credits|pause between/i.test(m)) botMsg("ai", m);
    else if (/Forbidden|403/i.test(m)) botMsg("ai", "🔄 Your app version looks outdated. Press Ctrl + Shift + R to refresh the page and I'll be right here!");
    else botMsg("ai", "☕ I'm a bit busy right now, try again in a few seconds! Meanwhile: upload your resume in the Analyzer tab to get started, or email faizalkhan1111222@gmail.com for help.");
  }
  $("botMsgs").scrollTop = $("botMsgs").scrollHeight;
}

/* ── DASHBOARD / motivation / streak ── */
// Local calendar date (YYYY-MM-DD) in the user's own timezone, so a new day
// begins at 12:00 AM local time, not at UTC midnight.
function localDay(d = new Date()) {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
}
const MILESTONE_INFO = {
  7:  { icon: "⚡", title: "Day 7 — Momentum unlocked!", body: "One full week of showing up for your career. You're building real momentum, keep the chain alive!" },
  14: { icon: "🔥", title: "Day 14 — Halfway Hero!", body: "Two weeks strong! You're halfway to the finish line and a free course. Incredible consistency." },
  21: { icon: "💪", title: "Day 21 — Unstoppable!", body: "21 days straight! They say it takes 21 days to build a habit, you just did. Almost there!" },
  30: { icon: "🏆", title: "Day 30 — CHAMPION! 🎉", body: "You completed the 30-Day Job Streak Challenge! You've earned one paid course of your choice, free. Claim it from your dashboard." },
};
// Fire the one-time celebration for a milestone, if this user hasn't seen it yet.
function celebrateMilestone(streak) {
  const m = MILESTONE_INFO[streak];
  if (!m) return;
  const seenKey = "celebrated_" + streak;
  if (store.get(seenKey, false)) return;     // already celebrated this milestone for this account
  store.set(seenKey, true);
  setTimeout(() => showCelebrate(m.icon, m.title, m.body, true), 800);
}
// Calendar-day difference between two YYYY-MM-DD strings.
function dayGap(a, b) {
  const da = Date.parse(a + "T00:00:00"), db = Date.parse(b + "T00:00:00");
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 864e5);
}
// Advance the streak for "today" with a forgiving grace window that mirrors the
// server, so a daily user is never reset by timezone slop or one missed day.
function bumpStreak(streak, last, today) {
  if (!last) return Math.max(1, streak);
  if (last === today) return Math.max(1, streak);
  const diff = dayGap(last, today);
  if (diff === null || diff <= 0) return Math.max(1, streak); // skew/older date, keep
  if (diff === 1 || diff === 2) return Math.max(1, streak) + 1; // next day or 1 grace day
  return 1; // 3+ days genuinely missed
}
function calcStreak() {
  if (!user) return 0; // streaks belong to an account, anonymous visitors don't accrue
  const today = localDay();
  const last = store.get("lastVisit", "");
  const prev = store.get("streak", 0);
  let streak = prev;
  if (last !== today) {
    streak = bumpStreak(streak, last, today);
    // Detect a broken chain: had a streak >= 3, missed days, and it reset to 1.
    if (last && prev >= 3 && streak === 1) {
      const brokeKey = "broke_seen_" + today;
      if (!store.get(brokeKey, false)) {
        store.set(brokeKey, true);
        setTimeout(() => showCelebrate("💔", "Your streak reset", `Your ${prev}-day streak ended because a day was missed. No worries, every champion restarts. Today is Day 1 again, let's rebuild it stronger! 🔥`, false), 800);
      }
    }
    store.set("streak", streak); store.set("lastVisit", today);
    celebrateMilestone(streak);
  }
  // Reconcile with the cloud so the same account shows the same streak on every device.
  syncStreakCloud();
  return streak;
}

/* ── Info modal: Why we built this / Privacy / Terms ── */
const INFO_CONTENT = {
  why: {
    title: "💡 Why we built JobTopper",
    body: `<p>Job hunting in India is overwhelming. Great candidates get filtered out by ATS systems, generic resumes, and a lack of guidance.</p>
      <p style="margin-top:10px">JobTopper was built to level the field, giving every job seeker a free, AI-powered companion: an honest ATS score, a resume that's truly tailored to each job, fresh openings, realistic salary insight, interview practice, and a clear roadmap.</p>
      <p style="margin-top:10px">Our goal is simple, help you become the <b>topper</b> of your job hunt, and get hired faster.</p>`,
  },
  privacy: {
    title: "🔒 Privacy Policy",
    body: `<p>Your trust matters. Here's how we handle your data, in plain language:</p>
      <ul style="margin:10px 0 0 18px">
        <li style="margin-bottom:6px">Your resume is parsed in your browser and stored locally on your device. We do not sell your data.</li>
        <li style="margin-bottom:6px">When you use an AI tool, the relevant text is sent securely to our AI provider only to generate your result.</li>
        <li style="margin-bottom:6px">We keep basic account info (name, email) and anonymous usage counts to run and improve the service.</li>
        <li style="margin-bottom:6px">You can stop using the service anytime; signing out keeps your data on your device.</li>
      </ul>
      <p style="margin-top:10px">Questions? Reach us on WhatsApp or LinkedIn from the menu.</p>`,
  },
  terms: {
    title: "📄 Terms & Conditions",
    body: `<p>By using JobTopper you agree to the following:</p>
      <ul style="margin:10px 0 0 18px">
        <li style="margin-bottom:6px">JobTopper provides AI-generated guidance and estimates. Always review and verify before relying on them.</li>
        <li style="margin-bottom:6px">All resume content must be truthful, you are responsible for what you submit and send to employers.</li>
        <li style="margin-bottom:6px">Free usage may be limited per day to keep the service available for everyone.</li>
        <li style="margin-bottom:6px">The service is provided "as is" without warranty. We are not liable for hiring outcomes.</li>
      </ul>
      <p style="margin-top:10px">We may update these terms as the product grows.</p>`,
  },
};
function openInfo(key) {
  const c = INFO_CONTENT[key]; if (!c) return;
  $("infoTitle").textContent = c.title;
  $("infoBody").innerHTML = c.body;
  $("infoModal").classList.add("show");
  $("sidebar").classList.remove("open");
}
function closeInfo() { $("infoModal").classList.remove("show"); }

/* ── 'Coming soon' announcement bar ── */
function dismissAnnounce() {
  const el = $("announceBar");
  if (el) el.classList.add("hide");
  try { sessionStorage.setItem("jr_announce_hidden", "1"); } catch (_) {}
}
(function initAnnounce() {
  try { if (sessionStorage.getItem("jr_announce_hidden")) { const el = document.getElementById("announceBar"); if (el) el.classList.add("hide"); } } catch (_) {}
})();

/* ── Celebration modal + confetti ── */
function showCelebrate(icon, title, body, confetti) {
  $("celebrateIcon").textContent = icon;
  $("celebrateTitle").textContent = title;
  $("celebrateBody").textContent = body;
  $("celebrateModal").classList.add("show");
  if (confetti) burstConfetti();
}
function closeCelebrate() {
  $("celebrateModal").classList.remove("show");
  $("confetti").classList.remove("show");
  $("confetti").innerHTML = "";
  // restore the default single-button celebrate footer
  const extra = $("celebrateBtn2"); if (extra) extra.remove();
  const cb = $("celebrateBtn"); if (cb) { cb.textContent = "Let's keep going 🚀"; cb.onclick = closeCelebrate; cb.style.display = ""; }
}
// Two-button confirm built on the celebrate modal (Yes / No).
function showConfirm(icon, title, body, yesLabel, onYes, noLabel) {
  $("celebrateIcon").textContent = icon;
  $("celebrateTitle").textContent = title;
  $("celebrateBody").textContent = body;
  const cb = $("celebrateBtn");
  cb.textContent = yesLabel; cb.onclick = onYes; cb.style.display = "";
  let no = $("celebrateBtn2");
  if (!no) {
    no = document.createElement("button");
    no.id = "celebrateBtn2"; no.className = "btn ghost"; no.style.marginLeft = "8px";
    cb.parentNode.appendChild(no);
  }
  no.textContent = noLabel || "Close";
  no.onclick = closeCelebrate;
  $("celebrateModal").classList.add("show");
}
function burstConfetti() {
  const wrap = $("confetti");
  wrap.innerHTML = "";
  const colors = ["#7c5cff", "#f472b6", "#22d3ee", "#34d399", "#fbbf24", "#a855f7"];
  for (let i = 0; i < 90; i++) {
    const c = document.createElement("i");
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = (2.2 + Math.random() * 1.8) + "s";
    c.style.animationDelay = (Math.random() * 0.5) + "s";
    c.style.transform = `scale(${0.7 + Math.random()})`;
    wrap.appendChild(c);
  }
  wrap.classList.add("show");
  setTimeout(() => { wrap.classList.remove("show"); wrap.innerHTML = ""; }, 4500);
}

/* ── Cross-device streak sync (Upstash via /api/streak) ── */
let streakSyncing = false;
async function syncStreakCloud() {
  if (!user?.email || streakSyncing) return;
  streakSyncing = true;
  try {
    const today = localDay();
    const localStreak = store.get("streak", 1);
    const localLast = store.get("lastVisit", today);
    // Send our local view; the server merges it with whatever the account last
    // recorded on any device and returns the authoritative streak.
    const r = await api("/api/streak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, today, streak: localStreak, lastVisit: localLast }),
    }, 1, 12000);
    if (r && typeof r.streak === "number") {
      const before = store.get("streak", 1);
      // Safety guard: never let a sync silently DROP a healthy streak. Only accept
      // a lower value if the user genuinely hasn't visited for 3+ days (real reset).
      const lastV = store.get("lastVisit", today);
      const gap = dayGap(lastV, today);
      const genuineReset = gap !== null && gap >= 3;
      const next = (r.streak < before && !genuineReset) ? before : r.streak;
      store.set("streak", next);
      if (r.lastVisit) store.set("lastVisit", r.lastVisit);
      if (next !== before) { celebrateMilestone(next); renderDashboard(); }
    }
  } catch (_) {
    // Offline or backend not configured: local streak still works, just no cross-device sync.
  } finally {
    streakSyncing = false;
  }
}
// Time-of-day bucket so tips/greetings never feel wrong (no "before lunch" at night).
function partOfDay(h = new Date().getHours()) {
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}
// Fallback quotes grouped by time of day so the action always fits the moment.
const FALLBACK_BY_TIME = {
  morning: [
    { quote: "Win the morning, win the day.", tip: "Apply to 3 fresh roles before lunch.", author: "JobTopper" },
    { quote: "Small steps every morning build big careers.", tip: "Run your resume through the ATS Analyzer now.", author: "JobTopper" },
  ],
  afternoon: [
    { quote: "Keep the momentum going through the afternoon.", tip: "Tailor your resume to one job you like.", author: "JobTopper" },
    { quote: "Consistency beats intensity.", tip: "Reach out to one person on LinkedIn today.", author: "JobTopper" },
  ],
  evening: [
    { quote: "Finish strong, the day isn't over.", tip: "Practice one interview question with the Mentor.", author: "JobTopper" },
    { quote: "Every evening of effort compounds.", tip: "Save 2 roles to apply to tomorrow.", author: "JobTopper" },
  ],
  night: [
    { quote: "Rest well, tomorrow is another chance to shine.", tip: "Line up tomorrow's applications before bed.", author: "JobTopper" },
    { quote: "Plan tonight, win tomorrow.", tip: "Review one job description so you're ready in the morning.", author: "JobTopper" },
  ],
};
function pickFallback() {
  const pool = FALLBACK_BY_TIME[partOfDay()];
  return pool[new Date().getDate() % pool.length];
}
async function loadMotivation() {
  const today = localDay();
  const tod = partOfDay();
  const cached = store.get("motiv", null);
  // Cache per day AND per time-of-day so it refreshes as the day progresses and stays fresh daily.
  if (cached && cached.date === today && cached.tod === tod) return renderMotivation(cached.data);
  renderMotivation(pickFallback());
  try {
    const applied = tracker.filter((t) => !["Saved", "Viewed"].includes(t.status)).length;
    const { data } = await aiCall("motivation", { name: user?.name, applied, streak: store.get("streak", 1), timeOfDay: tod }, 0);
    store.set("motiv", { date: today, tod, data });
    renderMotivation(data);
  } catch (_) { /* fallback already shown */ }
}
function renderMotivation(d) {
  $("motivBox").innerHTML = `"${esc(d.quote)}"<div class="tip">💡 <b>Today's action:</b> ${esc(d.tip)}</div>`;
}
function renderDashboard() {
  $("dAts").textContent = lastAnalysis ? lastAnalysis.atsScore : "—";
  $("dApplied").textContent = tracker.filter((t) => ["Applied", "Interview", "Offer"].includes(t.status)).length;
  $("dInterviews").textContent = tracker.filter((t) => ["Interview", "Offer"].includes(t.status)).length;
  $("dStreak").textContent = user ? store.get("streak", 1) : "—";
  renderChallenge();
  // Build next steps from the user's ACTUAL progress, in a sensible priority order.
  const hasResume = resumeText.trim().length > 100;
  const usedTailor = store.get("used_tailor", false);
  const usedRoadmap = store.get("used_roadmap", false);
  const usedInterview = store.get("used_interview", false);
  const usedSalary = store.get("used_salary", false);
  const applied = tracker.filter((t) => ["Applied", "Interview", "Offer"].includes(t.status)).length;
  const steps = [];
  if (!hasResume) steps.push(["📄 Upload your resume to get started", "analyzer"]);
  else if (!lastAnalysis) steps.push(["🔍 Run your first ATS analysis", "analyzer"]);
  else if (lastAnalysis.atsScore < 90) steps.push([`🚀 Boost your ATS score (now ${lastAnalysis.atsScore}, aim for 90+)`, "analyzer"]);
  if (hasResume && !usedTailor) steps.push(["✂️ Tailor your resume to a specific job", "tailor"]);
  if (!tracker.length) steps.push(["💼 Find jobs posted in the last 24 hours", "jobs"]);
  else if (!applied) steps.push(["📨 Apply to a saved job and mark it Applied", "tracker"]);
  if (hasResume && !usedInterview) steps.push(["🎙️ Practice a mock interview", "interview"]);
  if (!usedSalary) steps.push(["💰 Check your market salary range", "salary"]);
  if (hasResume && !usedRoadmap) steps.push(["🗺️ Build your personalized career roadmap", "roadmap"]);
  if (!steps.length) steps.push(["🎯 You're on track! Find fresh jobs to apply to", "jobs"]);
  $("nextSteps").innerHTML = steps.slice(0, 4).map(([s, v]) => `<div style="padding:9px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="go('${v}')">${s} <span style="float:right;color:var(--acc2)">→</span></div>`).join("");
  const h = new Date().getHours();
  const who = user ? ", " + user.name.split(" ")[0] : "";
  const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 21 ? "Good evening" : "Burning the midnight oil";
  $("greet").textContent = greet + who + "! 👋";
}

/* ── 30-Day Job Streak Challenge ── */
const MILESTONES = [
  { day: 7, icon: "⚡", label: "Momentum" },
  { day: 14, icon: "🔥", label: "Halfway Hero" },
  { day: 21, icon: "💪", label: "Unstoppable" },
  { day: 30, icon: "🏆", label: "Champion" },
];
function renderChallenge() {
  const el = $("challengeCard");
  if (!el) return;
  if (!user) {
    el.innerHTML = `<h3>🏆 The 30-Day Job Streak Challenge</h3>
      <p style="font-size:14px;color:var(--mut);margin-top:6px">Show up for your career 30 days in a row and win big: complete the streak and get <b style="color:var(--warn)">one paid course of your choice, absolutely free</b>. Sign in to start day 1 of your journey.</p>
      <button class="btn gold sm" style="margin-top:12px" onclick="openLogin()">🚀 Sign in & start my streak</button>`;
    return;
  }
  const streak = store.get("streak", 1);
  const pct = Math.min(100, Math.round((streak / 30) * 100));
  const done = streak >= 30;
  const next = MILESTONES.find((m) => m.day > streak);
  const claimMail = "mailto:faizalkhan1111222@gmail.com?subject=" + encodeURIComponent("🏆 30-Day Streak Completed! Free Course Claim") +
    "&body=" + encodeURIComponent(`Hi JobTopper team,\n\nI completed the 30-day streak challenge!\n\nMy name: ${user.name}\nMy email: ${user.email}\nCourse I would like: (tell us which paid course you want)\n\nAttaching my streak screenshot.\n\nThank you!`);
  el.innerHTML = `
    <span class="ch-flame">${done ? "🏆" : "🔥"}</span>
    <h3>🏆 The 30-Day Job Streak Challenge <span class="badge y">Day ${Math.min(streak, 30)} of 30</span></h3>
    <p style="font-size:13.5px;color:var(--mut);margin-top:4px">Visit every single day and work on your job hunt. Complete 30 days without breaking the chain and get <b style="color:var(--warn)">one paid course of your choice, free</b>. Miss a day and the streak resets, so guard it like your dream job depends on it!</p>
    <div class="ch-track"><div class="fill" style="width:${pct}%"></div>
      ${MILESTONES.map((m) => { const pos = (m.day / 30) * 100; const edge = pos >= 99 ? " edge-end" : pos <= 1 ? " edge-start" : ""; return `<div class="ch-ms${streak >= m.day ? " hit" : ""}${edge}" style="left:${pos}%">${m.icon}<span><b class="ms-word">${m.label}</b><b class="ms-day">Day ${m.day}</b></span></div>`; }).join("")}
    </div>
    ${done
      ? `<a class="btn gold" href="${claimMail}">🎁 Claim my free course now</a> <span style="font-size:12px;color:var(--dim);margin-left:8px">We'll reply with access to the course you pick.</span>`
      : `<div style="font-size:13px;color:var(--acc2)">${next ? `${next.icon} Next milestone: <b>${next.label}</b> in ${next.day - streak} day${next.day - streak > 1 ? "s" : ""}` : ""} · ${30 - streak} day${30 - streak > 1 ? "s" : ""} to the free course 🎁</div>`}
  `;
}

/* ── Init ── */
(function init() {
  document.body.dataset.view = "dashboard";
  if (resumeText) { $("resumeText").value = resumeText; }
  updateResumeBadge();
  renderResumeHistory();
  renderAuth();
  calcStreak();
  renderDashboard();
  loadMotivation();
  // Capture a referral code from the URL (?ref=CODE) and remember it until signup.
  try {
    const ref = new URLSearchParams(location.search).get("ref");
    if (ref) store.set("pendingRef", ref.trim().toUpperCase().slice(0, 12));
  } catch (_) {}
  // If already signed in, load the credit balance now.
  if (user?.email) refreshPoints();
  initCookieNotice();
  // Analytics: count one page visit per session (avoids double-counting reloads).
  if (!sessionStorage.getItem("jr_visited")) { sessionStorage.setItem("jr_visited", "1"); track("visit"); }
})();

/* ── First-time spotlight walkthrough ── */
// Each step highlights one element (by CSS selector) and explains it. Mandatory
// on a new user's first visit, with a one-time skip. Stored per account in the
// vault (jr_ prefix) so it shows once and never nags a returning user.
const TOUR_STEPS = [
  { sel: '.nav a[data-v="dashboard"]', title: "🏠 Your Dashboard", body: "Your home base. See your ATS score, applications, interviews and your day streak at a glance, plus your next best step." },
  { sel: '.nav a[data-v="analyzer"]', title: "🔍 Analyzer & ATS Score", body: "Upload your resume here. Get an honest ATS score, fixes, and a one-click Boost that rewrites it to score 90+ truthfully." },
  { sel: '.nav a[data-v="tailor"]', title: "✂️ Tailor for a JD", body: "Paste any job description and we re-prioritize your real experience into a portal-ready resume, plus a cover letter." },
  { sel: '.nav a[data-v="jobs"]', title: "💼 Job Openings", body: "Find fresh roles posted in the last 24 hours, aggregated from LinkedIn, Naukri, Indeed, Glassdoor and more." },
  { sel: '.nav a[data-v="tracker"]', title: "📊 Application Tracker", body: "Every job you save or apply to lands here, from Saved all the way to Offer. Never lose track again." },
  { sel: '.nav a[data-v="interview"]', title: "🎙️ Interview Mentor", body: "Practice real HR and technical rounds tailored to your resume. You can even speak your answers with the mic." },
  { sel: '.nav a[data-v="salary"]', title: "💰 Salary Intel", body: "Realistic INR salary ranges by city and experience, plus skills that boost pay and negotiation tips for India." },
  { sel: '.nav a[data-v="roadmap"]', title: "🗺️ Career Roadmap", body: "A step-by-step plan from where you are to your target role, built from your own resume." },
  { sel: '#editResumeBtn', title: "✏️ Edit your resume anytime", body: "This button (and the badge beside it) jumps you straight to upload or edit your resume whenever you need." },
  { sel: '#botFab', title: "💬 Meet Juno", body: "Stuck on anything? Juno, your helper, is always one tap away to explain how every feature works. That's the tour, you're all set!" },
];
let tourIdx = 0, tourActive = false;
const tourSeen = () => store.get("tourDone", false);

function startTour(force) {
  if (tourActive) return;
  if (!force && tourSeen()) return;
  tourActive = true; tourIdx = 0;
  // make sure the sidebar is visible so nav targets exist on screen
  if (window.innerWidth <= 920) $("sidebar").classList.add("open");
  else document.body.classList.remove("scollapsed");
  $("tourBg").classList.add("show");
  // dots
  $("tourDots").innerHTML = TOUR_STEPS.map(() => "<i></i>").join("");
  renderTour();
  window.addEventListener("resize", renderTour);
}
function tourStep(dir) {
  tourIdx += dir;
  if (tourIdx < 0) tourIdx = 0;
  if (tourIdx >= TOUR_STEPS.length) return endTour(false);
  renderTour();
}
function renderTour() {
  if (!tourActive) return;
  const step = TOUR_STEPS[tourIdx];
  const el = document.querySelector(step.sel);
  if (!el) { return tourStep(1); } // skip any target not on screen
  const r = el.getBoundingClientRect();
  const pad = 6;
  const top = r.top - pad, left = r.left - pad, w = r.width + pad * 2, h = r.height + pad * 2;
  const W = window.innerWidth, H = window.innerHeight;
  const ring = $("tourRing");
  ring.style.top = top + "px"; ring.style.left = left + "px";
  ring.style.width = w + "px"; ring.style.height = h + "px";
  $("tourDimTop").style.cssText = `top:0;left:0;width:100%;height:${Math.max(0, top)}px`;
  $("tourDimBottom").style.cssText = `top:${top + h}px;left:0;width:100%;height:${Math.max(0, H - top - h)}px`;
  $("tourDimLeft").style.cssText = `top:${top}px;left:0;width:${Math.max(0, left)}px;height:${h}px`;
  $("tourDimRight").style.cssText = `top:${top}px;left:${left + w}px;width:${Math.max(0, W - left - w)}px;height:${h}px`;
  $("tourTitle").textContent = step.title;
  $("tourBody").textContent = step.body;
  $("tourBack").style.visibility = tourIdx === 0 ? "hidden" : "visible";
  $("tourNext").textContent = tourIdx === TOUR_STEPS.length - 1 ? "Finish ✓" : "Next →";
  Array.from($("tourDots").children).forEach((d, i) => d.classList.toggle("on", i === tourIdx));
  const pop = $("tourPop");
  pop.style.visibility = "hidden";
  requestAnimationFrame(() => {
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let pTop, pLeft;
    const arrow = $("tourPopArrow");
    arrow.style.cssText = "";
    if (left + w + 18 + pw < W) {
      pLeft = left + w + 16;
      pTop = Math.min(Math.max(8, top), H - ph - 8);
      arrow.style.cssText = `left:-8px;top:18px;border-right:none;border-top:none`;
    } else if (top + h + 16 + ph < H) {
      pTop = top + h + 14;
      pLeft = Math.min(Math.max(8, left), W - pw - 8);
      arrow.style.cssText = `top:-8px;left:24px;border-bottom:none;border-right:none`;
    } else {
      pTop = top - ph - 14;
      pLeft = Math.min(Math.max(8, left + w - pw), W - pw - 8);
      arrow.style.cssText = `bottom:-8px;left:24px;border-top:none;border-left:none`;
    }
    pop.style.top = pTop + "px"; pop.style.left = pLeft + "px";
    pop.style.visibility = "visible";
  });
}
function endTour(skipped) {
  tourActive = false;
  $("tourBg").classList.remove("show");
  window.removeEventListener("resize", renderTour);
  store.set("tourDone", true);
  toast(skipped ? "Tour skipped, you can replay it from Juno anytime 👋" : "🎉 You're all set, welcome to JobTopper!");
}

/* ── Speech to text for Interview Mentor (robust live dictation) ── */
let recog = null;
let micWanted = false;
let micFinal = "";
let micBase = "";
let micFinalParts = [];
let micHeard = false;
let micWatchdog = null;
let micStartedAt = 0;
let micDeadRestarts = 0;

function micUI(on) {
  const b = $("ivMic");
  if (on) { b.classList.add("rec"); b.textContent = "⏹"; }
  else { b.classList.remove("rec"); b.textContent = "🎤"; }
}

function tidyDictation(s) {
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return s;
  s = s.replace(/\s+([,.!?;:])/g, "$1");
  s = s.replace(/([.!?])\s*([a-z])/g, (m, p, c) => p + " " + c.toUpperCase());
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}
function buildRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SR();
  const lang = (navigator.language && /^en/i.test(navigator.language)) ? navigator.language : "en-IN";
  r.lang = lang;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 3;

  r.onresult = (e) => {
    micHeard = true;
    micDeadRestarts = 0;
    clearTimeout(micWatchdog);
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      let best = res[0];
      for (let a = 1; a < res.length; a++) {
        if ((res[a].confidence || 0) > (best.confidence || 0)) best = res[a];
      }
      const t = best.transcript.trim();
      if (res.isFinal) {
        if (t) micFinalParts[i] = t;
      } else {
        interim += (interim ? " " : "") + t;
      }
    }
    const box = $("ivInp");
    micFinal = micFinalParts.filter(Boolean).join(" ");
    box.value = tidyDictation([micBase, micFinal, interim].filter(Boolean).join(" "));
    box.scrollTop = box.scrollHeight;
  };

  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      micWanted = false; micUI(false);
      toast("🎤 Microphone is blocked. Click the lock icon in the address bar, allow Microphone, then try again.");
    } else if (e.error === "no-speech") {
      // harmless silence timeout; onend will auto-restart while micWanted
    } else if (e.error === "network") {
      micWanted = false; micUI(false);
      toast("🎤 Speech service unreachable. Voice typing needs Google Chrome with internet. Please type instead.");
    } else if (e.error !== "aborted") {
      toast("🎤 Mic issue: " + e.error + ". Try again.");
    }
  };

  r.onend = () => {
    if (micWanted) {
      const lived = Date.now() - micStartedAt;
      if (lived < 2500 && !micHeard) {
        micDeadRestarts++;
        if (micDeadRestarts >= 3) {
          micWanted = false; micUI(false); clearTimeout(micWatchdog);
          toast("🎤 Your browser is blocking Google's speech service, so no words can come through. Open this site in Google Chrome (with shields/adblock off for this site), or press Win + H to use Windows voice typing into the box.");
          return;
        }
      }
      try { micStartedAt = Date.now(); recog = buildRecognizer(); recog.start(); return; } catch (_) {}
    }
    micUI(false);
    micWanted = false;
  };
  return r;
}

async function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("🎤 Voice typing works on Google Chrome and Microsoft Edge. Please type your answer here.");

  if (micWanted) {
    micWanted = false;
    try { recog && recog.stop(); } catch (_) {}
    micUI(false);
    toast("🎤 Stopped. Review your answer and hit Send.");
    return;
  }

  try {
    if (navigator.mediaDevices?.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch (err) {
    return toast("🎤 Please allow microphone access (click the lock icon near the address bar → Microphone → Allow), then tap the mic again.");
  }

  micBase = $("ivInp").value ? $("ivInp").value.trim() : "";
  micFinal = "";
  micFinalParts = [];
  micHeard = false;
  micDeadRestarts = 0;
  micWanted = true;
  micStartedAt = Date.now();
  recog = buildRecognizer();
  try { recog.start(); } catch (_) { micWanted = false; micUI(false); return toast("🎤 Couldn't start the mic, tap again."); }
  micUI(true);
  toast("🎤 Listening… speak naturally, your words appear live. Tap ⏹ when done.");

  clearTimeout(micWatchdog);
  micWatchdog = setTimeout(() => {
    if (micWanted && !micHeard) toast("🎤 I can't hear anything yet. Speak louder and closer, check the correct microphone is selected (browser lock icon → Site settings → Microphone). On Windows you can also press Win + H to dictate.");
  }, 7000);
}

/* ── End chat with Juno ── */
function endBotChat() {
  botHistory = [];
  $("botMsgs").innerHTML = "";
  const div = document.createElement("div");
  div.className = "msg ai";
  div.textContent = "That was a great chat! 👋 I've wrapped up this session. Whenever you need me again, just type below. All the best with your job hunt, you've got this! 🚀";
  $("botMsgs").appendChild(div);
  toast("✅ Chat with Juno ended");
}
/* end of app.js */
