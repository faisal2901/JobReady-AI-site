/* ═══════════════ JobReady AI — app.js ═══════════════ */
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── State (localStorage) ── */
const store = {
  get: (k, d) => { try { const v = localStorage.getItem("jr_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem("jr_" + k, JSON.stringify(v)),
};
let resumeText = store.get("resume", "");
let resumeName = store.get("resumeName", "");
let lastAnalysis = store.get("analysis", null);
let tracker = store.get("tracker", []);
let ivHistory = [];
let jobsCache = [];

/* ── Toast ── */
let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200);
}

/* ── API helper with retry (no-timeout resilience) ── */
async function api(path, opts = {}, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(path, opts);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `Request failed (${r.status})`);
      return j;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise((s) => setTimeout(s, 1500));
    }
  }
}
const aiCall = (action, payload, retries = 1) =>
  api("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) }, retries);

function loadBox(msg) { return `<div class="card"><div class="loadbox"><div class="spin"></div><div>${esc(msg)}</div></div></div>`; }
function busy(btn, on, label) { const b = $(btn); if (!b) return; b.disabled = on; b.innerHTML = on ? `<span class="spin"></span> Working…` : label; }

/* ── Navigation ── */
const TITLES = {
  dashboard: ["Dashboard", "Your job search, supercharged."],
  analyzer: ["Resume Analyzer & ATS Score", "Genuine, stable ATS scoring — AI rubric + deterministic checks."],
  tailor: ["Tailor Resume for a JD", "Truthfully rewritten & keyword-optimized for any job description."],
  jobs: ["Job Openings", "Fresh listings from LinkedIn, Naukri, Indeed, Glassdoor & more."],
  tracker: ["Application Tracker", "Every application, from Saved to Offer."],
  interview: ["Interview Coach", "Practice with Coach Arjun — HR & technical rounds."],
  salary: ["Salary Intelligence", "Realistic INR figures for the Indian market."],
  roadmap: ["Career Roadmap", "A step-by-step plan from where you are to where you want to be."],
};
function go(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.v === view));
  $("v-" + view).classList.add("active");
  $("viewTitle").textContent = TITLES[view][0];
  $("viewSub").textContent = TITLES[view][1];
  $("sidebar").classList.remove("open");
  window.scrollTo({ top: 0 });
  if (view === "tracker") renderTracker();
  if (view === "dashboard") renderDashboard();
}
document.querySelectorAll(".nav a").forEach((a) => a.addEventListener("click", () => go(a.dataset.v)));
$("hamb").addEventListener("click", () => $("sidebar").classList.toggle("open"));

/* ── Resume upload & parsing (fully client-side) ── */
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
    if (text.length < 100) return toast("⚠️ Couldn't extract enough text — try pasting it instead.");
    resumeText = text; resumeName = file.name;
    store.set("resume", text); store.set("resumeName", file.name);
    $("resumeText").value = text;
    updateResumeBadge();
    toast("✅ Resume loaded: " + file.name);
  } catch (e) { toast("❌ Parse error: " + e.message); }
}
function updateResumeBadge() {
  const has = resumeText.trim().length > 100;
  $("resumeBadge").textContent = has ? "📄 " + (resumeName || "Resume loaded") : "📄 No resume yet";
  $("resumeBadge").className = has ? "badge g" : "badge v";
  if (has && resumeName) { $("resumeInfo").style.display = "block"; $("resumeFileBadge").textContent = "✅ " + resumeName + " · " + resumeText.split(/\s+/).length + " words"; }
}
function toggleResumeEdit() { const t = $("resumeText"); t.style.display = t.style.display === "none" ? "block" : "none"; }
function needResume() { if (resumeText.trim().length < 100) { toast("⚠️ Upload or paste your resume first (Analyzer tab)"); go("analyzer"); return true; } return false; }

/* ── ANALYZER ── */
function hashStr(s) { // FNV-1a — stable fingerprint of resume+JD text
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
async function runAnalyze(force) {
  if (needResume()) return;
  const jd = $("analyzeJd").value.trim();
  const cacheKey = "score_" + hashStr(resumeText.replace(/\s+/g, " ").trim() + "||" + jd.replace(/\s+/g, " ").trim());
  const cached = store.get(cacheKey, null);
  if (cached && !force) {
    lastAnalysis = cached; store.set("analysis", cached);
    renderAnalysis(cached, cacheKey);
    toast("🔒 Same resume & JD — showing your locked score. Edit the text to re-score.");
    return;
  }
  busy("analyzeBtn", true);
  $("analyzeOut").innerHTML = loadBox("Running deep analysis… AI rubric + 8 structural checks + keyword match");
  try {
    const { data } = await aiCall("analyze", { resume: resumeText, jd: jd || undefined });
    lastAnalysis = data; store.set("analysis", data); store.set(cacheKey, data);
    renderAnalysis(data, cacheKey);
  } catch (e) { $("analyzeOut").innerHTML = `<div class="card" style="color:var(--bad)">❌ ${esc(e.message)}</div>`; }
  busy("analyzeBtn", false, "🔍 Analyze Resume & Get ATS Score");
}
function clearScoreCache(key) { localStorage.removeItem("jr_" + key); runAnalyze(true); }

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
  $("analyzeOut").innerHTML = `
  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>Your ATS Score</h3>
      <div class="gauge-wrap" style="margin-top:12px">${gaugeSVG(d.atsScore)}
        <div style="flex:1;min-width:200px">${rubricRows}</div></div>
      <p style="margin-top:12px;font-size:13.5px;color:var(--mut)">${esc(d.summary || "")}</p>
      <div style="margin-top:8px"><span class="badge c">🎯 ${esc(d.roleGuess || "")}</span> <span class="badge v">${esc(d.experienceLevel || "")}</span> <span class="badge g">🔒 score locked for this version</span></div>
      ${cacheKey ? `<button class="btn sm ghost" style="margin-top:10px" onclick="clearScoreCache('${cacheKey}')">🔄 Force fresh re-analysis</button>` : ""}
    </div>
    <div class="card"><h3>🧱 ATS Structural Checks <span class="badge v" style="margin-left:6px">${d.structural?.score ?? 0}/100</span></h3>
      <div style="margin-top:8px">${checks}</div></div>
  </div>
  ${kw ? `<div class="card" style="margin-bottom:16px"><h3>🔑 Keyword Match vs JD <span class="badge ${kw.pct >= 60 ? "g" : kw.pct >= 35 ? "y" : "r"}" style="margin-left:6px">${kw.pct}%</span></h3>
    <div style="margin-top:10px;font-size:12.5px;color:var(--mut)">MISSING (add these if true for you):</div>
    <div>${kw.missing.slice(0, 25).map((w) => `<span class="chip miss">${esc(w)}</span>`).join("")}</div></div>` : ""}
  <div class="grid g2" style="margin-bottom:16px">
    <div class="card"><h3>💪 Strengths</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(d.strengths || []).map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join("")}</ul></div>
    <div class="card"><h3>⚡ Quick Wins (10-min fixes)</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(d.quickWins || []).map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join("")}</ul></div>
  </div>
  <div class="card"><h3>🛠️ Issues & Fixes</h3><div style="margin-top:12px">
    ${(d.issues || []).map((i) => `<div class="issue"><span class="sev">${sev[i.severity] || "🔵"}</span><div><div>${esc(i.issue)}</div><div class="fix">→ ${esc(i.fix)}</div></div></div>`).join("")}
  </div>
  <button class="btn" style="margin-top:10px" onclick="go('tailor')">✂️ Now tailor it to a JD</button></div>`;
  renderDashboard();
}

/* ── TAILOR ── */
let lastTailored = null;
function prefillTailor(title, company, jd) { $("tJobTitle").value = title || ""; $("tCompany").value = company || ""; $("tJd").value = jd || ""; go("tailor"); }
async function runTailor() {
  if (needResume()) return;
  const jd = $("tJd").value.trim();
  if (jd.length < 50) return toast("⚠️ Paste the Job Description first");
  busy("tailorBtn", true);
  $("tailorOut").innerHTML = loadBox("Tailoring your resume to this JD — truthfully optimizing keywords, summary & bullets…");
  try {
    const { data } = await aiCall("tailor", { resume: resumeText, jd, jobTitle: $("tJobTitle").value, company: $("tCompany").value });
    lastTailored = data;
    $("tailorOut").innerHTML = `
    <div class="card" style="margin-bottom:16px"><h3>✅ Tailored Resume <span class="badge g" style="margin-left:6px">~${data.matchEstimate || "?"}% match</span></h3>
      <div style="margin:12px 0;display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn sm good" onclick="downloadPDF()">⬇️ Download PDF</button>
        <button class="btn sm good" onclick="downloadWord()">⬇️ Download Word</button>
        <button class="btn sm ghost" onclick="downloadTxt()">⬇️ Download TXT</button>
        <button class="btn sm ghost" onclick="copyTailored()">📋 Copy</button>
      </div>
      <pre class="resume-out" id="tailoredPre">${esc(data.tailoredResume)}</pre></div>
    <div class="grid g2">
      <div class="card"><h3>📝 What changed</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(data.changes || []).map((c) => `<li style="margin-bottom:6px">${esc(c)}</li>`).join("")}</ul></div>
      <div class="card"><h3>🔑 Keywords woven in</h3><div style="margin-top:10px">${(data.keywordsAdded || []).map((k) => `<span class="chip hit">${esc(k)}</span>`).join("")}</div></div>
    </div>`;
  } catch (e) { $("tailorOut").innerHTML = `<div class="card" style="color:var(--bad)">❌ ${esc(e.message)}</div>`; }
  busy("tailorBtn", false, "✂️ Tailor My Resume");
}
async function runCoverLetter() {
  if (needResume()) return;
  const jd = $("tJd").value.trim();
  if (jd.length < 50) return toast("⚠️ Paste the Job Description first");
  busy("clBtn", true);
  try {
    const { data } = await aiCall("coverletter", { resume: resumeText, jd, jobTitle: $("tJobTitle").value, company: $("tCompany").value });
    $("tailorOut").insertAdjacentHTML("afterbegin",
      `<div class="card" style="margin-bottom:16px"><h3>✉️ Cover Letter</h3>
      <div style="margin:10px 0"><button class="btn sm ghost" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.textContent);toast('Copied!')">📋 Copy</button></div>
      <pre class="resume-out">${esc(data.coverLetter)}</pre></div>`);
  } catch (e) { toast("❌ " + e.message); }
  busy("clBtn", false, "✉️ Generate Cover Letter");
}
function copyTailored() { navigator.clipboard.writeText(lastTailored?.tailoredResume || ""); toast("📋 Copied to clipboard"); }
function dlBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
function baseName() { return ("Resume_" + ($("tJobTitle").value || "Tailored").replace(/[^\w]+/g, "_")).slice(0, 60); }
function downloadTxt() { if (!lastTailored) return; dlBlob(new Blob([lastTailored.tailoredResume], { type: "text/plain" }), baseName() + ".txt"); }
function downloadWord() {
  if (!lastTailored) return;
  const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial;font-size:11pt;line-height:1.45;margin:1in .8in}</style></head><body>${lastTailored.tailoredResume.split("\n").map((l) => {
    const t = esc(l);
    if (/^[A-Z][A-Z &/]{3,}$/.test(l.trim())) return `<p style="font-size:13pt;font-weight:bold;border-bottom:1px solid #999;margin:14pt 0 4pt">${t}</p>`;
    return `<p style="margin:2pt 0">${t || "&nbsp;"}</p>`;
  }).join("")}</body></html>`;
  dlBlob(new Blob(["﻿" + html], { type: "application/msword" }), baseName() + ".doc");
}
function downloadPDF() {
  if (!lastTailored) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = 595, M = 50, LH = 13.5;
  let y = M;
  lastTailored.tailoredResume.split("\n").forEach((line) => {
    const isHead = /^[A-Z][A-Z &/]{3,}$/.test(line.trim());
    doc.setFont("helvetica", isHead ? "bold" : "normal");
    doc.setFontSize(isHead ? 12.5 : 10);
    const wrapped = doc.splitTextToSize(line || " ", W - 2 * M);
    wrapped.forEach((w) => {
      if (y > 800) { doc.addPage(); y = M; }
      if (isHead) y += 6;
      doc.text(w, M, y);
      y += LH;
    });
    if (isHead) { doc.setDrawColor(150); doc.line(M, y - 9, W - M, y - 9); }
  });
  doc.save(baseName() + ".pdf");
}

/* ── JOBS ── */
let jobsPage = 1;
async function searchJobs(page) {
  const q = $("jQ").value.trim();
  if (!q) return toast("⚠️ Enter a role or keywords");
  jobsPage = page;
  busy("jobsBtn", true);
  if (page === 1) { $("jobsOut").innerHTML = loadBox("Scanning LinkedIn, Naukri, Indeed, Glassdoor & more…"); jobsCache = []; }
  $("jobsMore").innerHTML = "";
  try {
    const p = new URLSearchParams({ q, location: $("jLoc").value || "India", datePosted: $("jDate").value, page: String(page) });
    if ($("jRemote").checked) p.set("remote", "true");
    if ($("jType").value) p.set("employmentType", $("jType").value);
    const j = await api("/api/jobs?" + p, {}, 1);
    jobsCache = page === 1 ? j.jobs : jobsCache.concat(j.jobs);
    renderJobs();
    if (j.jobs.length >= 8) $("jobsMore").innerHTML = `<button class="btn ghost" onclick="searchJobs(${page + 1})">Load more ↓</button>`;
    if (!j.jobs.length && page === 1) $("jobsOut").innerHTML = `<div class="card" style="text-align:center;color:var(--mut)">No fresh listings found — try "Last 3 days", a broader keyword, or city "India".</div>`;
  } catch (e) { $("jobsOut").innerHTML = `<div class="card" style="color:var(--bad)">❌ ${esc(e.message)}</div>`; }
  busy("jobsBtn", false, "💼 Search Fresh Openings");
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
        <span>🏢 ${esc(j.company || "—")}</span><span>📍 ${esc(j.location || "—")}${j.remote ? " · 🏠 Remote" : ""}</span>
        ${j.postedText ? `<span>🕐 ${esc(j.postedText)}</span>` : ""}${j.employmentType ? `<span>💼 ${esc(j.employmentType.toLowerCase())}</span>` : ""}
        ${fmtSalary(j) ? `<span style="color:var(--good)">💰 ${fmtSalary(j)}</span>` : ""}
        ${j.publisher ? `<span class="badge c" style="font-size:10px">${esc(j.publisher)}</span>` : ""}
      </div>
      <div class="actions">
        <a class="btn sm" href="${esc(j.applyLink)}" target="_blank" rel="noopener" onclick="autoTrack(${i})">🚀 Apply on ${esc(j.publisher || "site")}</a>
        <button class="btn sm ghost" onclick="tailorForJob(${i})">✂️ Tailor resume for this</button>
        <button class="btn sm ghost" onclick="saveJob(${i})">🔖 Save to tracker</button>
        <button class="btn sm ghost" onclick="toggleJD(${i})">📃 View JD</button>
      </div>
      <pre class="resume-out" id="jd-${i}" style="display:none;margin-top:10px;max-height:260px">${esc(j.description)}</pre>
    </div></div></div>`).join("");
}
function toggleJD(i) { const el = $("jd-" + i); el.style.display = el.style.display === "none" ? "block" : "none"; }
function tailorForJob(i) { const j = jobsCache[i]; prefillTailor(j.title, j.company, j.description); }
function saveJob(i, status = "Saved") {
  const j = jobsCache[i];
  if (tracker.some((t) => t.id === j.id)) return toast("Already in tracker");
  tracker.unshift({ id: j.id, title: j.title, company: j.company, link: j.applyLink, status, date: new Date().toISOString().slice(0, 10) });
  store.set("tracker", tracker);
  toast(status === "Applied" ? "📨 Marked as Applied in tracker" : "🔖 Saved to tracker");
}
function autoTrack(i) { const j = jobsCache[i]; const ex = tracker.find((t) => t.id === j.id); if (ex) { ex.status = "Applied"; store.set("tracker", tracker); } else saveJob(i, "Applied"); }

/* ── TRACKER ── */
const STATUSES = ["Saved", "Applied", "Interview", "Offer", "Rejected"];
function addManual() {
  const t = $("mTitle").value.trim(), c = $("mCompany").value.trim();
  if (!t || !c) return toast("⚠️ Enter title and company");
  tracker.unshift({ id: "m" + Date.now(), title: t, company: c, link: $("mLink").value.trim(), status: "Applied", date: new Date().toISOString().slice(0, 10) });
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
      <div class="ti"><b>${esc(t.title)}</b><span>${esc(t.company)} · added ${esc(t.date)}${t.link ? ` · <a href="${esc(t.link)}" target="_blank" rel="noopener" style="color:var(--cyan)">link ↗</a>` : ""}</span></div>
      <select onchange="setStatus('${esc(t.id)}',this.value)">${STATUSES.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select>
      <button class="btn sm ghost" onclick="delTrack('${esc(t.id)}')">🗑️</button>
    </div>`).join("")
    : `<div class="card" style="text-align:center;color:var(--mut)">No applications tracked yet. Search jobs and hit <b>Apply</b> or <b>Save</b> — they'll appear here automatically.</div>`;
  renderDashboard();
}

/* ── INTERVIEW COACH ── */
function pushMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "me" : "ai");
  div.textContent = text;
  $("ivMsgs").appendChild(div);
  $("ivMsgs").scrollTop = $("ivMsgs").scrollHeight;
}
async function startInterview() {
  ivHistory = [];
  $("ivMsgs").innerHTML = "";
  pushMsg("ai", "Starting your session… 🎙️");
  await coachTurn();
}
async function sendInterview() {
  const txt = $("ivInp").value.trim();
  if (!txt) return;
  if (!ivHistory.length) return toast("⚠️ Click Start New Session first");
  $("ivInp").value = "";
  pushMsg("user", txt);
  ivHistory.push({ role: "user", text: txt });
  await coachTurn();
}
async function coachTurn() {
  $("ivSend").disabled = true;
  const thinking = document.createElement("div");
  thinking.className = "msg ai"; thinking.innerHTML = '<span class="spin"></span> Coach is thinking…';
  $("ivMsgs").appendChild(thinking);
  try {
    const { data } = await aiCall("interview", { resume: resumeText || undefined, role: $("ivRole").value || undefined, mode: $("ivMode").value, history: ivHistory });
    thinking.remove();
    pushMsg("ai", data.reply);
    ivHistory.push({ role: "ai", text: data.reply });
  } catch (e) { thinking.remove(); pushMsg("ai", "❌ " + e.message + " — please try again."); }
  $("ivSend").disabled = false;
}

/* ── SALARY ── */
async function runSalary() {
  const role = $("sRole").value.trim();
  if (!role) return toast("⚠️ Enter a role");
  busy("salaryBtn", true);
  $("salaryOut").innerHTML = loadBox("Crunching Indian market compensation data…");
  try {
    const { data: d } = await aiCall("salary", { role, city: $("sCity").value, years: $("sYears").value, skills: $("sSkills").value });
    const maxC = Math.max(...(d.byCity || []).map((c) => c.median), 1);
    $("salaryOut").innerHTML = `
    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h3>💰 ${esc(role)} — Expected CTC</h3>
        <div style="display:flex;gap:18px;margin-top:16px;text-align:center">
          <div style="flex:1"><b style="font-size:22px;font-family:'Sora';color:var(--mut)">₹${d.low}L</b><div style="font-size:11.5px;color:var(--dim)">LOW</div></div>
          <div style="flex:1.2;background:rgba(124,92,255,.12);border:1px solid rgba(124,92,255,.4);border-radius:14px;padding:8px"><b style="font-size:28px;font-family:'Sora';background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent">₹${d.median}L</b><div style="font-size:11.5px;color:var(--mut)">MEDIAN</div></div>
          <div style="flex:1"><b style="font-size:22px;font-family:'Sora';color:var(--good)">₹${d.high}L</b><div style="font-size:11.5px;color:var(--dim)">HIGH</div></div>
        </div>
        <p style="margin-top:14px;font-size:13px;color:var(--mut)">${esc(d.notes || "")}</p></div>
      <div class="card"><h3>🏙️ Median by city</h3><div style="margin-top:12px">
        ${(d.byCity || []).map((c) => `<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(c.city)}</span><b>₹${c.median}L</b></div><div class="bar"><i style="width:${Math.round((c.median / maxC) * 100)}%"></i></div></div>`).join("")}</div></div>
    </div>
    <div class="grid g2">
      <div class="card"><h3>📈 Skills that boost pay</h3><div style="margin-top:10px">${(d.skillsThatBoostPay || []).map((s) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13.5px"><span>${esc(s.skill)}</span><b style="color:var(--good)">${esc(s.impact)}</b></div>`).join("")}
        <div style="margin-top:12px;font-size:12.5px;color:var(--dim)">Top paying: ${(d.topPayingCompanies || []).map(esc).join(" · ")}</div></div>
      <div class="card"><h3>🤝 Negotiation tips (India)</h3><ul style="margin:10px 0 0 18px;color:var(--mut);font-size:13.5px">${(d.negotiationTips || []).map((t) => `<li style="margin-bottom:7px">${esc(t)}</li>`).join("")}</ul></div>
    </div>
    <p style="margin-top:12px;font-size:12px;color:var(--dim)">AI-generated estimates based on Indian market patterns — verify on AmbitionBox/Glassdoor before negotiating.</p>`;
  } catch (e) { $("salaryOut").innerHTML = `<div class="card" style="color:var(--bad)">❌ ${esc(e.message)}</div>`; }
  busy("salaryBtn", false, "💰 Get Salary Intelligence");
}

/* ── ROADMAP ── */
async function runRoadmap() {
  const target = $("rTarget").value.trim();
  if (!target) return toast("⚠️ Enter your target role");
  busy("roadmapBtn", true);
  $("roadmapOut").innerHTML = loadBox("Designing your personalised roadmap…");
  try {
    const { data: d } = await aiCall("roadmap", { resume: resumeText || undefined, currentRole: $("rCurrent").value, targetRole: target, timeline: $("rTimeline").value });
    $("roadmapOut").innerHTML = `
    <div class="card" style="margin-bottom:16px"><h3>🧩 Gap Analysis</h3>
      <div style="margin-top:10px">${(d.gapAnalysis || []).map((g) => `<span class="chip miss">${esc(g)}</span>`).join("")}</div>
      <div style="margin-top:10px;font-size:13px;color:var(--mut)">⏱️ Recommended: <b>${esc(d.weeklyHours || "8-10 hrs/week")}</b></div></div>
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
  } catch (e) { $("roadmapOut").innerHTML = `<div class="card" style="color:var(--bad)">❌ ${esc(e.message)}</div>`; }
  busy("roadmapBtn", false, "🗺️ Build My Roadmap");
}

/* ── DASHBOARD / motivation / streak ── */
function calcStreak() {
  const today = new Date().toISOString().slice(0, 10);
  const last = store.get("lastVisit", "");
  let streak = store.get("streak", 0);
  if (last !== today) {
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    streak = last === y ? streak + 1 : 1;
    store.set("streak", streak); store.set("lastVisit", today);
  }
  return streak;
}
const FALLBACK_QUOTES = [
  { quote: "Don't watch the clock; do what it does — keep going.", tip: "Apply to 3 fresh roles today before lunch.", author: "JobReady AI" },
  { quote: "Rejection is redirection. Every 'no' is data, not defeat.", tip: "Re-read one rejected JD and update one resume bullet to match it.", author: "JobReady AI" },
  { quote: "Dream, dream, dream. Dreams transform into thoughts and thoughts result in action. — APJ Abdul Kalam", tip: "Practice one interview answer out loud today.", author: "JobReady AI" },
];
async function loadMotivation() {
  const today = new Date().toISOString().slice(0, 10);
  const cached = store.get("motiv", null);
  if (cached && cached.date === today) return renderMotivation(cached.data);
  renderMotivation(FALLBACK_QUOTES[new Date().getDate() % FALLBACK_QUOTES.length]);
  try {
    const applied = tracker.filter((t) => t.status !== "Saved").length;
    const { data } = await aiCall("motivation", { applied, streak: store.get("streak", 1) }, 0);
    store.set("motiv", { date: today, data });
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
  $("dStreak").textContent = store.get("streak", 1);
  const hasResume = resumeText.trim().length > 100;
  const steps = [];
  if (!hasResume) steps.push(["📄 Upload your resume", "analyzer"]);
  else if (!lastAnalysis) steps.push(["🔍 Run your first ATS analysis", "analyzer"]);
  else if (lastAnalysis.atsScore < 75) steps.push(["🛠️ Fix issues — ATS score is " + lastAnalysis.atsScore + ", aim for 75+", "analyzer"]);
  if (!tracker.length) steps.push(["💼 Find jobs posted in the last 24 hours", "jobs"]);
  if (tracker.length && !tracker.some((t) => t.status === "Interview")) steps.push(["🎙️ Practice with the Interview Coach", "interview"]);
  steps.push(["🗺️ Build your 6-month career roadmap", "roadmap"]);
  $("nextSteps").innerHTML = steps.slice(0, 4).map(([s, v]) => `<div style="padding:9px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="go('${v}')">${s} <span style="float:right;color:var(--acc2)">→</span></div>`).join("");
  const h = new Date().getHours();
  $("greet").textContent = (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + "! 👋";
}

/* ── Init ── */
(function init() {
  if (resumeText) { $("resumeText").value = resumeText; }
  updateResumeBadge();
  calcStreak();
  renderDashboard();
  loadMotivation();
})();
