// JobReady AI — unified AI endpoint (Gemini)
// POST /api/ai  body: { action, ...payload }
// Actions: analyze | boost | tailor | coverletter | interview | salary | roadmap | motivation | support

const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash,gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);

const STYLE = `Writing style rule: never use em dashes or hyphens to join sentence parts. Write natural flowing sentences with commas and periods instead.`;

async function callGemini({ system, user, json = false, temperature = 0.4, maxTokens = 8192 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set. Add it in Vercel, Settings, Environment Variables.");

  const body = {
    system_instruction: { parts: [{ text: system + "\n" + STYLE }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  };

  let lastErr = null, sawRateLimit = false;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 50000);
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (r.status === 429 || r.status === 503) {
          sawRateLimit = true;
          lastErr = new Error(`Model ${model} busy (${r.status})`);
          await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
          continue;
        }
        if (r.status === 404) { lastErr = new Error(`Model ${model} not available`); break; }
        if (!r.ok) {
          const t = await r.text();
          lastErr = new Error(`Gemini ${model} error ${r.status}: ${t.slice(0, 300)}`);
          break;
        }
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (!text) { lastErr = new Error("Empty response"); continue; }
        return text;
      } catch (e) { lastErr = e; }
    }
  }
  if (sawRateLimit) throw new Error("HIGH_DEMAND");
  throw lastErr || new Error("All Gemini models failed");
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  throw new Error("HIGH_DEMAND");
}
async function geminiJSON(opts) {
  try { return extractJSON(await callGemini({ ...opts, json: true })); }
  catch (e) {
    if (e.message === "HIGH_DEMAND") return extractJSON(await callGemini({ ...opts, json: true }));
    throw e;
  }
}

/* ---------- Deterministic ATS layer ---------- */
const STOPWORDS = new Set(("a an the and or of to in for with on at by from as is are was were be been being this that these those it its we you your our their have has had do does did will would can could should may might must not no nor so if then than too very just about into over under again further once here there when where why how all any both each few more most other some such only own same s t don now").split(" "));
function keywordSet(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []).filter((w) => !STOPWORDS.has(w) && !/^\d+$/.test(w)));
}
function keywordMatch(resume, jd) {
  const r = keywordSet(resume), j = keywordSet(jd);
  const matched = [], missing = [];
  for (const w of j) (r.has(w) ? matched : missing).push(w);
  const pct = j.size ? Math.round((matched.length / j.size) * 100) : 0;
  return { pct, matched: matched.slice(0, 60), missing: missing.slice(0, 40) };
}
function structuralChecks(resume) {
  const t = resume;
  const checks = [
    { id: "email", label: "Contact email present", pass: /[\w.+-]+@[\w-]+\.[\w.]+/.test(t) },
    { id: "phone", label: "Phone number present", pass: /(\+?\d[\d\s\-()]{8,})/.test(t) },
    { id: "sections", label: "Standard sections (Experience/Education/Skills)", pass: /experience/i.test(t) && /education/i.test(t) && /skill/i.test(t) },
    { id: "bullets", label: "Uses bullet points", pass: /(^|\n)\s*[•\-\*]/.test(t) },
    { id: "numbers", label: "Quantified achievements (numbers/%)", pass: /\d+\s*%|\d+\+|\b\d{2,}\b/.test(t) },
    { id: "length", label: "Reasonable length (350 to 1200 words)", pass: (() => { const w = (t.match(/\S+/g) || []).length; return w >= 350 && w <= 1200; })() },
    { id: "links", label: "LinkedIn/portfolio link", pass: /linkedin\.com|github\.com|portfolio|behance|dribbble/i.test(t) },
    { id: "verbs", label: "Action verbs (led, built, improved…)", pass: /\b(led|built|created|improved|managed|developed|designed|launched|increased|reduced|achieved|delivered|implemented|optimi[sz]ed)\b/i.test(t) },
  ];
  const passed = checks.filter((c) => c.pass).length;
  return { checks, score: Math.round((passed / checks.length) * 100) };
}
function blendScore(rubric, structScore, kwPct) {
  const aiAvg = ["impact", "clarity", "keywords", "formatting", "relevance"]
    .map((k) => Number(rubric?.[k]) || 0).reduce((a, b) => a + b, 0) / 5;
  let ats = Math.round(0.5 * aiAvg + 0.3 * structScore + 0.2 * (kwPct ?? aiAvg));
  return Math.max(5, Math.min(99, ats));
}

/* ---------- analyze ---------- */
async function analyze({ resume, jd }) {
  const struct = structuralChecks(resume);
  const kw = jd ? keywordMatch(resume, jd) : null;
  const sys = `You are an expert ATS auditor and senior technical recruiter for the Indian job market. Be strict, consistent, and deterministic. Identical input must always produce identical scores. Always return valid JSON only.`;
  const usr = `Evaluate this resume${jd ? " against the given job description" : ""}.

RESUME:
"""${resume.slice(0, 20000)}"""
${jd ? `\nJOB DESCRIPTION:\n"""${jd.slice(0, 8000)}"""` : ""}

Return JSON exactly in this schema:
{
  "rubric": {"impact": 0-100, "clarity": 0-100, "keywords": 0-100, "formatting": 0-100, "relevance": 0-100},
  "summary": "3-4 sentence professional assessment",
  "strengths": ["...", "..."],
  "issues": [{"severity": "high|medium|low", "issue": "...", "fix": "..."}],
  "missingKeywords": ["..."],
  "quickWins": ["3-6 specific edits the candidate can make in 10 minutes"],
  "roleGuess": "most likely target role",
  "experienceLevel": "fresher|junior|mid|senior|lead"
}`;
  const out = await geminiJSON({ system: sys, user: usr, temperature: 0 });
  const ats = blendScore(out.rubric, struct.score, kw ? kw.pct : null);
  return { atsScore: ats, rubric: out.rubric || {}, structural: struct, keywordMatch: kw, ...out };
}

/* ---------- boost (verified: rewrite, re-score, iterate) ---------- */
async function boostOnce(resume, jd, feedback) {
  const sys = `You are India's best ATS resume optimizer. Rewrite resumes to score 90+ on ATS systems while staying 100% TRUTHFUL. Never invent employers, dates, degrees, metrics, or experience not present in the original. You may rephrase weak bullets into strong action-verb plus quantified-outcome format (only using facts already present), reorganize into clean ATS sections, expand abbreviations, write a sharp professional summary, integrate keywords the candidate genuinely has, and standardize formatting. Return valid JSON only.`;
  const usr = `Rewrite this resume to maximize its ATS score (target 92+).

ORIGINAL RESUME:
"""${resume.slice(0, 20000)}"""
${jd ? `\nTARGET JD (optimize keywords for this):\n"""${jd.slice(0, 8000)}"""` : ""}
${feedback ? `\nA strict ATS audit of your previous attempt scored it ${feedback.score}/100. Fix ALL of these specific problems without inventing facts:\n${JSON.stringify(feedback.notes).slice(0, 3500)}` : ""}

Hard requirements for maximum ATS score:
- Line 1: Full Name. Line 2: Phone | Email | Location and LinkedIn URL if present in original.
- Sections in CAPS: PROFESSIONAL SUMMARY, SKILLS, EXPERIENCE, PROJECTS (if any), EDUCATION, CERTIFICATIONS (if any).
- Every EXPERIENCE bullet starts with a strong action verb and includes a number, %, or scale wherever the original supports one.
- SKILLS grouped by category. Consistent verb tenses. 400 to 900 words total. Use '•' for bullets.
- Clear, concise sentences. No filler words, no buzzword soup.

Return JSON:
{
  "boostedResume": "the full rewritten resume",
  "improvements": ["6-10 specific things you improved"],
  "keywordsAdded": ["..."],
  "honestyNote": "anything you could NOT fix because it would require inventing facts (like a missing LinkedIn URL or metrics the original never stated)"
}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0.2, maxTokens: 8192 });
}

async function boost({ resume, jd, originalScore }) {
  const orig = Number(originalScore) || 0;
  let best = null, current = resume, feedback = null;

  for (let pass = 0; pass < 2; pass++) {
    const b = await boostOnce(current, jd, feedback);
    if (!b.boostedResume || b.boostedResume.length < 300) break;
    const a = await analyze({ resume: b.boostedResume, jd });
    if (!best || a.atsScore > best.verifiedScore) {
      best = { boostedResume: b.boostedResume, improvements: b.improvements, keywordsAdded: b.keywordsAdded, honestyNote: b.honestyNote, verifiedScore: a.atsScore, verifiedAnalysis: a };
    }
    // good enough: clearly above 90 or solidly above the original
    if (a.atsScore >= 90 && a.atsScore > orig) break;
    feedback = {
      score: a.atsScore,
      notes: {
        issues: (a.issues || []).slice(0, 6),
        quickWins: (a.quickWins || []).slice(0, 6),
        failedChecks: (a.structural?.checks || []).filter((c) => !c.pass).map((c) => c.label),
        missingKeywords: (a.missingKeywords || []).slice(0, 15),
        lowRubric: Object.entries(a.rubric || {}).filter(([, v]) => v < 85).map(([k, v]) => `${k}: ${v}`),
      },
    };
    current = b.boostedResume;
  }

  if (!best) throw new Error("Boost failed to produce a valid resume. Please try again.");
  best.originalScore = orig || undefined;
  best.improved = orig ? best.verifiedScore > orig : true;
  return best;
}

/* ---------- tailor ---------- */
async function tailor({ resume, jd, jobTitle, company }) {
  const sys = `You are an elite resume writer who tailors resumes to job descriptions while staying 100% truthful. Never invent employers, dates, degrees, or experience that is not in the original resume. You may rephrase, reorder, emphasize, and naturally weave in JD keywords where genuinely supported by the candidate's background. Return valid JSON only.`;
  const usr = `Rewrite this resume tailored for the job below. ATS friendly and recruiter impressive.

ORIGINAL RESUME:
"""${resume.slice(0, 20000)}"""

TARGET JOB${jobTitle ? ` (${jobTitle}${company ? " @ " + company : ""})` : ""}:
"""${(jd || "").slice(0, 8000)}"""

Structure the output resume EXACTLY like this (plain text):
Line 1: Full Name
Line 2: Phone | Email | LinkedIn/Location
Then sections in CAPS: PROFESSIONAL SUMMARY, SKILLS, EXPERIENCE, PROJECTS (if any), EDUCATION, CERTIFICATIONS (if any).
For each job under EXPERIENCE put "Job Title at Company | Dates" on its own line, then '•' bullets.
SKILLS as grouped lines like "Languages: X, Y, Z". Quantified bullets, strong action verbs, JD keywords woven in naturally.

Return JSON:
{
  "tailoredResume": "full tailored resume as plain text",
  "changes": ["what was changed and why, 5-8 items"],
  "keywordsAdded": ["..."],
  "matchEstimate": 0-100
}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0.3, maxTokens: 8192 });
}

async function coverletter({ resume, jd, jobTitle, company }) {
  const sys = `You write concise, compelling cover letters for the Indian job market. Truthful to the resume. Return JSON only.`;
  const usr = `Write a cover letter (220-300 words) for ${jobTitle || "the role"}${company ? " at " + company : ""}.
RESUME: """${resume.slice(0, 12000)}"""
JD: """${(jd || "").slice(0, 6000)}"""
Return JSON: {"coverLetter": "..."}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0.5 });
}

/* ---------- interview ---------- */
async function interview({ resume, jd, history, mode, role, end }) {
  const sys = `You are the JobReady AI Interview Mentor, a world class interview coach who has sat on hiring panels at top tech companies and Indian unicorns. Mode: ${mode || "mixed"} (hr = behavioral/HR, tech = technical, mixed = both).
Rules:
- First message of a session: say exactly "Hi! Welcome to JobReady AI. I'm your personal mentor." then one line about what you'll cover, then ask the FIRST question.
- Ask ONE question at a time, calibrated precisely to the candidate's resume, target role, and seniority. Reference their actual projects, skills, and companies.
- After each answer give structured feedback: ✅ What worked · ⚠️ What to improve · 💡 Model answer outline (STAR for behavioral, structured approach for technical) · 📊 Score: X/10. Then ask the next question, slightly harder if they scored well.
- Mix question types realistically for the role.
- Be encouraging but honest. Under 280 words per turn. No roleplay names, no Namaste.
${end ? `- THE CANDIDATE HAS ENDED THE INTERVIEW. Do not ask another question. Instead give a final performance report: 🏁 overall score /10, top 3 strengths shown, top 3 areas to practice, one specific exercise for each weak area, and a short encouraging close. Under 320 words.` : ""}`;
  const convo = (history || []).map((m) => `${m.role === "user" ? "CANDIDATE" : "MENTOR"}: ${m.text}`).join("\n\n");
  const usr = `CANDIDATE RESUME:\n"""${(resume || "Not provided").slice(0, 10000)}"""
${jd ? `TARGET JD:\n"""${jd.slice(0, 4000)}"""` : role ? `TARGET ROLE: ${role}` : ""}

CONVERSATION SO FAR:
${convo || "(none, start the session now)"}
${end ? "\nTHE CANDIDATE CLICKED END INTERVIEW. Give the final report now." : ""}

Respond as MENTOR:`;
  const text = await callGemini({ system: sys, user: usr, temperature: 0.5, maxTokens: 2048 });
  return { reply: text.trim() };
}

/* ---------- salary ---------- */
async function salary({ role, city, years, skills }) {
  const sys = `You are a compensation analyst specialized in the INDIAN job market (2025-2026 data: Naukri, AmbitionBox, LinkedIn, Levels.fyi India). Give realistic INR figures. Be deterministic: identical input must always produce identical figures derived from market norms, never random variation. Return JSON only.`;
  const usr = `Estimate salary for:
Role: ${role}
City: ${city || "India (any)"}
Experience: ${years || "not specified"} years
Key skills: ${skills || "not specified"}

Return JSON:
{
  "currency": "INR LPA",
  "low": number, "median": number, "high": number,
  "byCity": [{"city": "Bengaluru|Mumbai|Delhi NCR|Hyderabad|Pune|Chennai", "median": number}],
  "topPayingCompanies": ["..."],
  "negotiationTips": ["4-6 India specific tips (notice period buyout, variable pay, ESOPs, counter offers)"],
  "skillsThatBoostPay": [{"skill": "...", "impact": "+X%"}],
  "notes": "1-2 sentences on market trend for this role in India"
}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0 });
}

/* ---------- roadmap ---------- */
async function roadmap({ resume, currentRole, targetRole, timeline }) {
  const sys = `You are a career strategist for Indian professionals. Practical, specific, free resource first. Base the gap analysis strictly on the candidate's ACTUAL resume vs the target role, referencing their real skills and experience. Be deterministic: identical input must always produce the identical roadmap. Return JSON only.`;
  const usr = `Create a career roadmap.
Current: ${currentRole || "infer from resume"}
Target: ${targetRole}
Timeline: ${timeline || "6 months"}
${resume ? `RESUME (base everything on this):\n"""${resume.slice(0, 12000)}"""` : "(no resume provided, give a general plan and mention it would be more precise with a resume)"}

Return JSON:
{
  "gapAnalysis": ["specific gaps between THIS candidate's resume and the target role"],
  "alreadyStrong": ["skills from their resume that already fit the target role"],
  "phases": [{"title": "Month 1-2: ...", "goals": ["..."], "actions": ["specific actions"], "resources": [{"name": "...", "type": "free course|book|project|cert", "url": "real URL only if certain, else empty string"}]}],
  "projects": [{"name": "...", "description": "portfolio project that proves the skill", "skills": ["..."]}],
  "certifications": ["worth-it certs only"],
  "milestones": ["measurable checkpoints"],
  "weeklyHours": "recommended study hours/week"
}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0 });
}

/* ---------- motivation ---------- */
async function motivation({ name, applied, streak }) {
  const sys = `You write one short, powerful daily motivation for an Indian job seeker. Mix grit and warmth. Occasionally reference Indian achievers (Kalam, Dhoni, Sudha Murty, etc.) naturally. Return JSON only.`;
  const usr = `Today's date: ${new Date().toISOString().slice(0, 10)}. ${name ? "Name: " + name + "." : ""} Applications so far: ${applied || 0}. Day streak: ${streak || 1}.
Return JSON: {"quote": "1-2 sentence original motivational message", "tip": "one actionable job search tip for today", "author": "JobReady AI"}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0.9, maxTokens: 512 });
}

/* ---------- support (Juno) ---------- */
async function support({ history, question }) {
  const sys = `You are Juno, the friendly JobReady AI helper bot. Answer questions about using the JobReady AI app, briefly and warmly (under 120 words). Use simple language. Introduce yourself as Juno if greeted.
APP KNOWLEDGE:
- Features: Resume Analyzer with ATS score (upload PDF/DOCX/TXT on Analyzer tab), Boost Score button (rewrites resume truthfully and verifies the new score is higher before showing it), Tailor for a JD (paste JD, get tailored resume, download PDF/Word/TXT, cover letter), Job Openings (live jobs from LinkedIn/Naukri/Indeed/Glassdoor, filter by city and time, Apply redirects to the portal), Application Tracker (Saved/Viewed/Applied/Interview/Offer/Rejected), Interview Mentor (mock interviews based on your resume, End Interview gives a final report), Salary Intelligence (India INR figures), Career Roadmap, daily motivation and streak.
- ATS score is stable: same resume and JD always gives the same score.
- Data privacy: resume and tracker live in the user's own browser. Signing out locks your data locally and signing back in with the same email restores it.
- Sign in is needed to use AI tools. Browsing is free without login.
- Issues? Email faizalkhan1111222@gmail.com. Built by Mohammed Faisal.
- If asked about general job search advice, give 1-2 quick India relevant tips.
- If asked something unrelated to the app or job seeking, politely redirect.`;
  const convo = (history || []).map((m) => `${m.role === "user" ? "USER" : "JUNO"}: ${m.text}`).join("\n");
  const text = await callGemini({ system: sys, user: `${convo}\nUSER: ${question}\nJUNO:`, temperature: 0.4, maxTokens: 512 });
  return { reply: text.trim() };
}

const ACTIONS = { analyze, boost, tailor, coverletter, interview, salary, roadmap, motivation, support };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const fn = ACTIONS[body.action];
    if (!fn) return res.status(400).json({ error: `Unknown action: ${body.action}` });
    if (["analyze", "tailor", "boost"].includes(body.action) && !body.resume) {
      return res.status(400).json({ error: "Resume text is required" });
    }
    const result = await fn(body);
    return res.status(200).json({ ok: true, data: result });
  } catch (e) {
    console.error(e);
    const friendly = e.message === "HIGH_DEMAND";
    return res.status(friendly ? 503 : 500).json({
      ok: false,
      error: friendly
        ? "☕ Hang tight! We're experiencing high demand right now. Grab a sip of chai and try again in about 30 seconds. Your data is safe."
        : e.message || "Server error",
    });
  }
};
