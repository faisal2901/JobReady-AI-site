// JobReady AI — unified AI endpoint (Gemini, free tier)
// POST /api/ai  body: { action, ...payload }
// Actions: analyze | tailor | interview | salary | roadmap | motivation | coverletter

const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

async function callGemini({ system, user, json = false, temperature = 0.4, maxTokens = 8192 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set. Add it in Vercel → Settings → Environment Variables.");

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  };

  let lastErr = null;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 55000);
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          }
        );
        clearTimeout(timer);
        if (r.status === 429 || r.status === 503) {
          lastErr = new Error(`Model ${model} busy (${r.status})`);
          await new Promise((s) => setTimeout(s, 1200));
          continue;
        }
        if (!r.ok) {
          const t = await r.text();
          lastErr = new Error(`Gemini ${model} error ${r.status}: ${t.slice(0, 300)}`);
          break; // try next model
        }
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (!text) { lastErr = new Error("Empty response"); continue; }
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error("All Gemini models failed");
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  throw new Error("AI returned invalid JSON. Please retry.");
}

// ---------- Deterministic ATS keyword layer (stable, repeatable) ----------
const STOPWORDS = new Set(("a an the and or of to in for with on at by from as is are was were be been being this that these those it its we you your our their have has had do does did will would can could should may might must not no nor so if then than too very just about into over under again further once here there when where why how all any both each few more most other some such only own same s t don now").split(" "));

function keywordSet(text) {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []).filter((w) => !STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
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
    { id: "bullets", label: "Uses bullet points", pass: /(^|\n)\s*[•\-\*•]/.test(t) },
    { id: "numbers", label: "Quantified achievements (numbers/%)", pass: /\d+\s*%|\d+\+|\b\d{2,}\b/.test(t) },
    { id: "length", label: "Reasonable length (350–1200 words)", pass: (() => { const w = (t.match(/\S+/g) || []).length; return w >= 350 && w <= 1200; })() },
    { id: "links", label: "LinkedIn/portfolio link", pass: /linkedin\.com|github\.com|portfolio|behance|dribbble/i.test(t) },
    { id: "verbs", label: "Action verbs (led, built, improved…)", pass: /\b(led|built|created|improved|managed|developed|designed|launched|increased|reduced|achieved|delivered|implemented|optimi[sz]ed)\b/i.test(t) },
  ];
  const passed = checks.filter((c) => c.pass).length;
  return { checks, score: Math.round((passed / checks.length) * 100) };
}

// ---------- Action handlers ----------
async function analyze({ resume, jd }) {
  const struct = structuralChecks(resume);
  const kw = jd ? keywordMatch(resume, jd) : null;

  const sys = `You are an expert ATS (Applicant Tracking System) auditor and senior technical recruiter for the Indian job market. Be strict, consistent, and deterministic. Always return valid JSON only.`;
  const usr = `Evaluate this resume${jd ? " against the given job description" : ""}.

RESUME:
"""${resume.slice(0, 20000)}"""
${jd ? `\nJOB DESCRIPTION:\n"""${jd.slice(0, 8000)}"""` : ""}

Return JSON exactly in this schema:
{
  "rubric": {
    "impact": 0-100,            // quantified achievements, outcomes
    "clarity": 0-100,           // writing quality, brevity, structure
    "keywords": 0-100,          // relevant skills/keywords${jd ? " vs the JD" : " for the candidate's field"}
    "formatting": 0-100,        // ATS-parse friendliness (no tables/graphics implied issues, clean headers)
    "relevance": 0-100          // experience fit${jd ? " for this JD" : " and career coherence"}
  },
  "summary": "3-4 sentence professional assessment",
  "strengths": ["...", "..."],
  "issues": [{"severity": "high|medium|low", "issue": "...", "fix": "..."}],
  "missingKeywords": ["..."],
  "quickWins": ["3-6 specific edits the candidate can make in 10 minutes"],
  "roleGuess": "most likely target role",
  "experienceLevel": "fresher|junior|mid|senior|lead"
}`;
  const out = extractJSON(await callGemini({ system: sys, user: usr, json: true, temperature: 0 }));

  // Blend stable deterministic signals with AI rubric → final ATS score
  const r = out.rubric || {};
  const aiAvg = ["impact", "clarity", "keywords", "formatting", "relevance"]
    .map((k) => Number(r[k]) || 0).reduce((a, b) => a + b, 0) / 5;
  let ats = Math.round(0.5 * aiAvg + 0.3 * struct.score + 0.2 * (kw ? kw.pct : aiAvg));
  ats = Math.max(5, Math.min(99, ats));

  return { atsScore: ats, rubric: r, structural: struct, keywordMatch: kw, ...out };
}

async function tailor({ resume, jd, jobTitle, company }) {
  const sys = `You are an elite resume writer who tailors resumes to job descriptions while staying 100% truthful — never invent employers, dates, degrees, or experience that is not in the original resume. You may rephrase, reorder, emphasize, and naturally weave in JD keywords where genuinely supported by the candidate's background. Return valid JSON only.`;
  const usr = `Rewrite this resume tailored for the job below. Keep it ATS-friendly: plain text structure, standard section headers, strong action verbs, quantified bullets.

ORIGINAL RESUME:
"""${resume.slice(0, 20000)}"""

TARGET JOB${jobTitle ? ` (${jobTitle}${company ? " @ " + company : ""})` : ""}:
"""${(jd || "").slice(0, 8000)}"""

Return JSON:
{
  "tailoredResume": "full tailored resume as plain text with sections: NAME & CONTACT, PROFESSIONAL SUMMARY, SKILLS, EXPERIENCE, PROJECTS (if any), EDUCATION, CERTIFICATIONS (if any). Use '•' bullets.",
  "changes": ["what was changed and why, 5-8 items"],
  "keywordsAdded": ["..."],
  "matchEstimate": 0-100
}`;
  return extractJSON(await callGemini({ system: sys, user: usr, json: true, temperature: 0.3, maxTokens: 8192 }));
}

async function coverletter({ resume, jd, jobTitle, company }) {
  const sys = `You write concise, compelling cover letters for the Indian job market. Truthful to the resume. Return JSON only.`;
  const usr = `Write a cover letter (220-300 words) for ${jobTitle || "the role"}${company ? " at " + company : ""}.
RESUME: """${resume.slice(0, 12000)}"""
JD: """${(jd || "").slice(0, 6000)}"""
Return JSON: {"coverLetter": "..."}`;
  return extractJSON(await callGemini({ system: sys, user: usr, json: true, temperature: 0.5 }));
}

async function interview({ resume, jd, history, mode, role }) {
  const sys = `You are "Coach Arjun", a warm but rigorous interview coach (ex-FAANG + Indian unicorn hiring panels). Mode: ${mode || "mixed"} (hr = behavioral/HR, tech = technical, mixed = both).
Rules:
- Ask ONE question at a time.
- After the candidate answers, give brief feedback: what was good, what to improve, a model answer outline (STAR for behavioral), THEN ask the next question.
- Calibrate difficulty to the resume. Reference their actual projects/skills.
- Keep responses under 250 words. Be encouraging but honest.`;
  const convo = (history || [])
    .map((m) => `${m.role === "user" ? "CANDIDATE" : "COACH"}: ${m.text}`)
    .join("\n\n");
  const usr = `CANDIDATE RESUME:\n"""${(resume || "Not provided").slice(0, 10000)}"""
${jd ? `TARGET JD:\n"""${jd.slice(0, 4000)}"""` : role ? `TARGET ROLE: ${role}` : ""}

CONVERSATION SO FAR:
${convo || "(none — start the session: greet in one line, then ask the first question)"}

Respond as COACH:`;
  const text = await callGemini({ system: sys, user: usr, temperature: 0.6, maxTokens: 2048 });
  return { reply: text.trim() };
}

async function salary({ role, city, years, skills }) {
  const sys = `You are a compensation analyst specialized in the INDIAN job market (2025-2026 data: Naukri, AmbitionBox, LinkedIn, Levels.fyi India). Give realistic INR figures. Return JSON only.`;
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
  "negotiationTips": ["4-6 India-specific tips (notice period buyout, variable pay, ESOPs, counter-offers)"],
  "skillsThatBoostPay": [{"skill": "...", "impact": "+X%"}],
  "notes": "1-2 sentences on market trend for this role in India"
}`;
  return extractJSON(await callGemini({ system: sys, user: usr, json: true, temperature: 0.2 }));
}

async function roadmap({ resume, currentRole, targetRole, timeline }) {
  const sys = `You are a career strategist for Indian professionals. Practical, specific, free-resource-first. Return JSON only.`;
  const usr = `Create a career roadmap.
Current: ${currentRole || "from resume"}
Target: ${targetRole}
Timeline: ${timeline || "6 months"}
${resume ? `RESUME:\n"""${resume.slice(0, 10000)}"""` : ""}

Return JSON:
{
  "gapAnalysis": ["skills/experience gaps"],
  "phases": [{"title": "Month 1-2: ...", "goals": ["..."], "actions": ["specific actions"], "resources": [{"name": "...", "type": "free course|book|project|cert", "url": "real URL if confident, else empty string"}]}],
  "projects": [{"name": "...", "description": "portfolio project that proves the skill", "skills": ["..."]}],
  "certifications": ["worth-it certs only"],
  "milestones": ["measurable checkpoints"],
  "weeklyHours": "recommended study hours/week"
}`;
  return extractJSON(await callGemini({ system: sys, user: usr, json: true, temperature: 0.4 }));
}

async function motivation({ name, applied, streak }) {
  const sys = `You write one short, powerful daily motivation for an Indian job seeker. Mix grit + warmth. Occasionally reference Indian achievers (Kalam, Dhoni, Sudha Murty, etc.) naturally. Return JSON only.`;
  const usr = `Today's date: ${new Date().toISOString().slice(0, 10)}. ${name ? "Name: " + name + "." : ""} Applications so far: ${applied || 0}. Day streak: ${streak || 1}.
Return JSON: {"quote": "1-2 sentence original motivational message", "tip": "one actionable job-search tip for today", "author": "JobReady AI"}`;
  return extractJSON(await callGemini({ system: sys, user: usr, json: true, temperature: 0.9, maxTokens: 512 }));
}

const ACTIONS = { analyze, tailor, coverletter, interview, salary, roadmap, motivation };

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
    if (["analyze", "tailor"].includes(body.action) && !body.resume) {
      return res.status(400).json({ error: "Resume text is required" });
    }
    const result = await fn(body);
    return res.status(200).json({ ok: true, data: result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
};
