// JobTopper — unified AI endpoint (Gemini)
// POST /api/ai  body: { action, ...payload }
// Actions: analyze | boost | tailor | coverletter | interview | salary | roadmap | motivation | support

// Order matters: lead with the fast, reliable model so we don't waste seconds on
// a model that's likely rate-limited. Override via GEMINI_MODELS env if needed.
const MODELS = (process.env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3.5-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);

const STYLE = `Writing style rule: never use em dashes or hyphens to join sentence parts. Write natural flowing sentences with commas and periods instead.`;

// Hard time budget per AI call: fail fast and friendly instead of hanging for 70+ seconds.
const CALL_BUDGET_MS = 38000;

function geminiKeys() {
  const list = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY2, process.env.GEMINI_API_KEY3]
    .concat((process.env.GEMINI_API_KEYS || "").split(","))
    .map((k) => (k || "").trim()).filter(Boolean);
  return [...new Set(list)];
}

async function callGeminiOnly({ system, user, json = false, temperature = 0.4, maxTokens = 8192 }) {
  const KEYS = geminiKeys();
  if (!KEYS.length) throw new Error("GEMINI_API_KEY is not set. Add it in Vercel, Settings, Environment Variables.");

  const body = {
    system_instruction: { parts: [{ text: system + "\n" + STYLE }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  };

  const deadline = Date.now() + CALL_BUDGET_MS;
  let lastErr = null, sawRateLimit = false;
  // Try every model x key combination: each model has its own rate bucket,
  // and each API key (from a separate Google Cloud project) has its own free quota.
  outer:
  for (const model of MODELS) {
    for (const key of KEYS) {
      if (Date.now() > deadline) { sawRateLimit = true; break outer; }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(30000, deadline - Date.now()));
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (r.status === 429 || r.status === 503) {
          sawRateLimit = true;
          lastErr = new Error(`Model ${model} busy (${r.status})`);
          continue; // next key for this model, then next model
        }
        if (r.status === 404) { lastErr = new Error(`Model ${model} not available`); continue; }
        if (!r.ok) {
          const t = await r.text();
          lastErr = new Error(`Gemini ${model} error ${r.status}: ${t.slice(0, 300)}`);
          continue;
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

/* ---------- Groq fallback (free, very fast OpenAI-compatible API) ---------- */
// Used automatically only when Gemini is rate-limited or fails. Set GROQ_API_KEY
// in Vercel to enable. Get a free key at https://console.groq.com/keys
const GROQ_MODELS = (process.env.GROQ_MODELS || "llama-3.3-70b-versatile,llama-3.1-8b-instant")
  .split(",").map((m) => m.trim()).filter(Boolean);
function groqKeys() {
  const list = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY2]
    .concat((process.env.GROQ_API_KEYS || "").split(","))
    .map((k) => (k || "").trim()).filter(Boolean);
  return [...new Set(list)];
}
async function callGroq({ system, user, json = false, temperature = 0.4, maxTokens = 8192 }) {
  const KEYS = groqKeys();
  if (!KEYS.length) throw new Error("NO_GROQ"); // not configured, so no fallback available
  const body = {
    messages: [
      { role: "system", content: system + "\n" + STYLE },
      { role: "user", content: user },
    ],
    temperature,
    max_tokens: Math.min(maxTokens, 8000),
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
  const deadline = Date.now() + CALL_BUDGET_MS;
  let lastErr = null;
  for (const model of GROQ_MODELS) {
    for (const key of KEYS) {
      if (Date.now() > deadline) break;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(30000, deadline - Date.now()));
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...body, model }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (r.status === 429 || r.status === 503) { lastErr = new Error(`Groq ${model} busy`); continue; }
        if (!r.ok) { const t = await r.text(); lastErr = new Error(`Groq ${model} ${r.status}: ${t.slice(0, 200)}`); continue; }
        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content || "";
        if (!text) { lastErr = new Error("Groq empty response"); continue; }
        return text;
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error("All Groq models failed");
}

// Primary entry point used by every feature: Gemini first, Groq as automatic
// fallback when Gemini is rate-limited or otherwise fails. If Groq isn't
// configured, the original Gemini error is surfaced.
async function callGemini(opts) {
  try {
    return await callGeminiOnly(opts);
  } catch (e) {
    try {
      return await callGroq(opts);
    } catch (e2) {
      if (e2 && e2.message === "NO_GROQ") throw e; // no fallback set up → original error
      // Both providers failed → keep the friendly high-demand message if either saw a limit.
      if (e.message === "HIGH_DEMAND" || /busy|429|503/i.test(e2.message)) throw new Error("HIGH_DEMAND");
      throw e2;
    }
  }
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

/* ---------- Deterministic ATS layer (normalized + synonym aware) ---------- */
const STOPWORDS = new Set(("a an the and or of to in for with on at by from as is are was were be been being this that these those it its we you your our their have has had do does did will would can could should may might must not no nor so if then than too very just about into over under again further once here there when where why how all any both each few more most other some such only own same s t don now " +
  // generic JD filler that should never count as a "missing keyword"
  "required requirement requirements experience experiences experienced year years skill skills strong good excellent ability abilities work working works team teams plus etc include includes including knowledge familiarity proficiency proficient understanding responsible responsibilities role roles job jobs candidate candidates must should preferred preferable qualification qualifications degree bachelor bachelors master masters btech mtech related field fields environment tool tools technology technologies using use used uses well will new day daily within across various multiple key core basic level levels equivalent minimum maximum description position company opportunity looking seeking join apply application salary location remote hybrid onsite full time part benefits per annum lpa ctc").split(/\s+/));

// Map common variants to one canonical token so "Node.js" matches "nodejs", "JS" matches "JavaScript", etc.
const SYNONYMS = {
  js: "javascript", ts: "typescript", reactjs: "react", "react.js": "react", nodejs: "node", "node.js": "node",
  nextjs: "next", "next.js": "next", vuejs: "vue", "vue.js": "vue", angularjs: "angular",
  k8s: "kubernetes", postgres: "postgresql", "postgre": "postgresql", mongo: "mongodb",
  ml: "machinelearning", "machine-learning": "machinelearning", ai: "artificialintelligence",
  powerbi: "powerbi", "power-bi": "powerbi", "ms-excel": "excel", msexcel: "excel",
  gcp: "googlecloud", aws: "aws", "ci/cd": "cicd", cicd: "cicd", "ci-cd": "cicd",
  "html5": "html", "css3": "css", "restful": "rest", "apis": "api",
};
function normToken(w) {
  w = w.toLowerCase().replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/g, ""); // strip edge punctuation like "collaboration."
  if (!w || !/[a-z]/.test(w)) return null;          // drop "2+", "10", pure symbols
  if (/^\d+\+?$/.test(w)) return null;
  w = w.replace(/'s$/, "");
  if (SYNONYMS[w]) w = SYNONYMS[w];
  else if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1); // light plural fold
  if (STOPWORDS.has(w) || w.length < 2) return null;
  return w;
}
function keywordSet(text) {
  const out = new Set();
  for (const raw of text.toLowerCase().match(/[a-z0-9+#./-]{2,}/g) || []) {
    const t = normToken(raw);
    if (t) out.add(t);
  }
  return out;
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
  const t0 = Date.now();
  let best = null, current = resume, feedback = null;

  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0 && Date.now() - t0 > 45000) break; // keep total under the function limit
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
  const sys = `You are an elite ATS resume writer. Your single goal: rewrite the candidate's resume so it scores as high as possible against the SPECIFIC job description provided, while staying 100% truthful. Hard rules: never invent employers, job titles, dates, degrees, certifications, or experience absent from the original. You MAY rephrase, reorder, re-emphasize, expand abbreviations, surface buried skills, and weave in the JD's exact terminology wherever the candidate genuinely has that skill or did that work. The output must read like it was written FOR this exact job. Return valid JSON only.`;
  const usr = `Tailor the resume below to the TARGET JOB so it would score 85+ on an ATS keyword match, truthfully.

WORK IN THIS ORDER (think silently, then output JSON):
1. Extract from the JD: the role's core responsibilities, the must-have hard skills/tools, the key soft skills, and the EXACT keyword phrases an ATS would scan for (job titles, tools, technologies, methodologies, qualifications).
2. Map each JD requirement to evidence already in the candidate's resume. For every requirement the candidate genuinely meets, make sure the tailored resume states it using the JD's own wording (e.g. if JD says "Power BI" and resume says "MS Power BI dashboards", use "Power BI").
3. Put the most JD-relevant experience, skills and projects FIRST. Lead the PROFESSIONAL SUMMARY with the target role title and the top 3-4 JD keywords the candidate truly matches.
4. In SKILLS, explicitly list every JD hard-skill the candidate actually has, spelled exactly as the JD spells it.
5. Rewrite EXPERIENCE bullets to mirror the JD's responsibilities and start with strong action verbs, keeping every number/metric from the original and adding none that weren't there.
6. Do NOT fabricate to cover a gap. If the candidate is missing a JD requirement, simply omit it (do not invent it) and note it in "gaps".

ORIGINAL RESUME:
"""${resume.slice(0, 20000)}"""

TARGET JOB${jobTitle ? ` (${jobTitle}${company ? " @ " + company : ""})` : ""}:
"""${(jd || "").slice(0, 8000)}"""

Output resume format (plain text):
Line 1: Full Name
Line 2: Phone | Email | LinkedIn/Location
Then CAPS sections in this order: PROFESSIONAL SUMMARY, SKILLS, EXPERIENCE, PROJECTS (if any), EDUCATION, CERTIFICATIONS (if any).
Under EXPERIENCE: "Job Title at Company | Dates" on its own line, then '•' bullets.
SKILLS grouped like "Tools: Power BI, Tableau, Excel". Quantified bullets, JD keywords woven in naturally (no keyword stuffing).

Return JSON:
{
  "tailoredResume": "full tailored resume as plain text",
  "changes": ["what was changed and why, 5-8 items, referencing specific JD requirements addressed"],
  "keywordsAdded": ["the exact JD keywords now reflected in the resume"],
  "gaps": ["JD requirements the candidate does not yet meet (honest, may be empty)"],
  "matchEstimate": 0-100
}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0.25, maxTokens: 8192 });
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
  const sys = `You are the JobTopper Interview Mentor, a world class interview coach who has sat on hiring panels at top tech companies and Indian unicorns. Mode: ${mode || "mixed"} (hr = behavioral/HR, tech = technical, mixed = both).
Rules:
- First message of a session: say exactly "Hi! Welcome to JobTopper. I'm your personal mentor." then one line about what you'll cover, then ask the FIRST question.
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
async function motivation({ name, applied, streak, timeOfDay }) {
  const tod = ["morning", "afternoon", "evening", "night"].includes(timeOfDay) ? timeOfDay : "day";
  const sys = `You write one short, powerful daily motivation for an Indian job seeker. Mix grit and warmth. Occasionally reference Indian achievers (Kalam, Dhoni, Sudha Murty, etc.) naturally. The "tip" MUST fit the current time of day: never say "before lunch" in the evening/night, never say "wind down" in the morning. Keep the tip realistic for right now. Return JSON only.`;
  const usr = `Current time of day: ${tod}. ${name ? "Name: " + name + "." : ""} Applications so far: ${applied || 0}. Day streak: ${streak || 1}.
Write a fresh, ${name ? "personalized" : ""} message and a tip appropriate for the ${tod}.
Return JSON: {"quote": "1-2 sentence original motivational message", "tip": "one actionable job search tip suitable for the ${tod}", "author": "JobTopper"}`;
  return geminiJSON({ system: sys, user: usr, temperature: 0.9, maxTokens: 512 });
}

/* ---------- support (Juno) ---------- */
async function support({ history, question }) {
  const sys = `You are Juno, the friendly JobTopper helper bot. Answer questions about using the JobTopper app, briefly and warmly (under 120 words). Use simple language. Introduce yourself as Juno if greeted.
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

/* ---------- Server-side response cache ----------
   Identical deterministic requests (same resume + same inputs) are answered from cache
   WITHOUT touching Gemini. Saves free-tier quota massively and makes repeats instant.
   Uses Upstash Redis when configured, plus an in-memory LRU per warm instance. */
// Identical inputs return the identical cached result (consistency) and skip a
// fresh AI call (avoids rate-limit errors on repeats). TTL in seconds.
const CACHEABLE = { analyze: 14 * 86400, salary: 7 * 86400, roadmap: 14 * 86400, tailor: 14 * 86400, boost: 14 * 86400, coverletter: 14 * 86400 };
function srvHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
function respCacheKey(action, body) {
  const sig = {
    analyze: [body.resume, body.jd],
    salary: [body.role, body.city, body.years, body.skills],
    roadmap: [body.resume, body.currentRole, body.targetRole, body.timeline],
    tailor: [body.resume, body.jd, body.jobTitle, body.company],
    boost: [body.resume, body.jd],
    coverletter: [body.resume, body.jd, body.jobTitle, body.company],
  }[action].map((x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim()).join("||");
  return `jrc:${action}:${srvHash(sig)}`;
}
const memCache = new Map(); // key -> { v, exp }
function memGet(k) { const e = memCache.get(k); if (e && e.exp > Date.now()) return e.v; memCache.delete(k); return null; }
function memSet(k, v, ttlS) { if (memCache.size > 200) memCache.delete(memCache.keys().next().value); memCache.set(k, { v, exp: Date.now() + ttlS * 1000 }); }
const hasUpstash = () => process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;
async function respCacheGet(k) {
  const m = memGet(k);
  if (m) return m;
  if (hasUpstash()) {
    try {
      const raw = await upstash(`get/${k}`);
      if (raw) { const v = JSON.parse(raw); memSet(k, v, 3600); return v; }
    } catch (_) {}
  }
  return null;
}
async function respCacheSet(k, v, ttlS) {
  memSet(k, v, ttlS);
  if (hasUpstash()) {
    try {
      await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/setex/${k}/${ttlS}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
        body: JSON.stringify(v),
      });
    } catch (_) {}
  }
}

/* ---------- CORS: same origin + explicitly allowed origins only ---------- */
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-JR-App");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (!origin) return true; // same-origin fetch or server-to-server
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let ok = allowed.includes(origin);
  try { if (new URL(origin).host === req.headers.host) ok = true; } catch (_) {}
  if (ok) res.setHeader("Access-Control-Allow-Origin", origin);
  return ok;
}

/* ---------- Rate limiting & free daily credits ----------
   Durable limits via Upstash Redis (free tier) when UPSTASH_REDIS_REST_URL/TOKEN are set.
   Falls back to per-instance in-memory limits otherwise (best effort on serverless). */
const COSTS = { boost: 4, tailor: 3, coverletter: 2, analyze: 2, roadmap: 2, salary: 1, interview: 1, motivation: 0, support: 1 };
const MINUTE_MAX = Number(process.env.AI_PER_MINUTE) || 8;
const DAILY_MAX = Number(process.env.AI_DAILY_CREDITS) || 80;
const memMinute = new Map(), memDay = new Map();

function ipOf(req) {
  return ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}
async function upstash(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/${cmd}`, { headers: { Authorization: `Bearer ${tok}` } });
  return (await r.json()).result;
}
async function checkQuota(ip, action) {
  const cost = COSTS[action] ?? 1;
  const day = new Date().toISOString().slice(0, 10);
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const mKey = `jrm:${ip}:${Math.floor(Date.now() / 60000)}`;
      const m = await upstash(`incr/${mKey}`);
      if (m === 1) await upstash(`expire/${mKey}/70`);
      if (m > MINUTE_MAX) return "minute";
      const dKey = `jrd:${ip}:${day}`;
      const d = await upstash(`incrby/${dKey}/${cost}`);
      if (d === cost) await upstash(`expire/${dKey}/90000`);
      if (d > DAILY_MAX) return "day";
      return null;
    } catch (_) { /* fall through to memory */ }
  }
  const now = Date.now();
  const recent = (memMinute.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now); memMinute.set(ip, recent);
  if (recent.length > MINUTE_MAX) return "minute";
  const dk = ip + day;
  const dn = (memDay.get(dk) || 0) + cost; memDay.set(dk, dn);
  if (memDay.size > 5000) memDay.clear();
  if (dn > DAILY_MAX) return "day";
  return null;
}

module.exports = async (req, res) => {
  const corsOk = applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(corsOk ? 200 : 403).end();
  if (!corsOk) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  // Lightweight app check: blocks naive scripted abuse of the endpoint
  if (req.headers["x-jr-app"] !== "1") return res.status(403).json({ ok: false, error: "Forbidden" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    // Reject oversized payloads early so a giant paste can't waste tokens or memory.
    const MAX_FIELD = 60000;   // ~60k chars per text field (a long resume/JD is well under this)
    const MAX_TOTAL = 200000;  // ~200k chars for the whole request body
    for (const k of ["resume", "jd", "question"]) {
      if (typeof body[k] === "string" && body[k].length > MAX_FIELD) {
        return res.status(413).json({ ok: false, error: `That ${k === "jd" ? "job description" : k} is too long. Please shorten it and try again.` });
      }
    }
    try { if (JSON.stringify(body).length > MAX_TOTAL) return res.status(413).json({ ok: false, error: "Request is too large. Please reduce the text and try again." }); } catch (_) {}
    const fn = ACTIONS[body.action];
    if (!fn) return res.status(400).json({ error: `Unknown action: ${body.action}` });
    if (["analyze", "tailor", "boost"].includes(body.action) && !body.resume) {
      return res.status(400).json({ error: "Resume text is required" });
    }
    // Served-from-cache responses are free: no quota, no Gemini call
    if (CACHEABLE[body.action]) {
      const ck = respCacheKey(body.action, body);
      const hit = await respCacheGet(ck);
      if (hit) return res.status(200).json({ ok: true, data: hit, cached: true });
    }
    const limited = await checkQuota(ipOf(req), body.action);
    if (limited === "minute") {
      return res.status(429).json({ ok: false, error: "⏳ Easy there, champion! A short pause between AI requests keeps things fast for everyone. Try again in a minute." });
    }
    if (limited === "day") {
      return res.status(429).json({ ok: false, error: "🌙 You've used today's free AI credits. They refresh tomorrow, perfect time to apply to the jobs you've shortlisted!" });
    }
    const result = await fn(body);
    if (CACHEABLE[body.action]) {
      respCacheSet(respCacheKey(body.action, body), result, CACHEABLE[body.action]).catch(() => {});
    }
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
