# 🚀 JobReady AI — From Resume to Offer Letter

All-in-one job search app for India. Upload a resume once, then:

| Feature | What it does |
|---|---|
| 🔍 **Resume Analyzer** | AI rubric (impact/clarity/keywords/formatting/relevance) + 8 deterministic structural checks + keyword match vs JD → a **stable, genuine ATS score** |
| ✂️ **JD Tailoring** | Truthfully rewrites your resume for any JD; download as **PDF / Word / TXT**; cover letter generator |
| 💼 **Live Jobs (24h)** | Fresh openings aggregated from LinkedIn, Naukri, Indeed, Glassdoor, Shine — apply links redirect to the original portal; one-click "Tailor for this JD" |
| 📊 **Tracker** | Saved → Applied → Interview → Offer pipeline, auto-tracks when you click Apply |
| 🎙️ **Interview Coach** | Chat with "Coach Arjun" — HR/technical/mixed mock rounds, calibrated to YOUR resume |
| 💰 **Salary Intel** | India-specific INR LPA ranges, city comparison, negotiation tips |
| 🗺️ **Career Roadmap** | Gap analysis + phased plan + portfolio projects + certifications |
| 🔥 **Daily Motivation** | Fresh quote + actionable tip every day, streak counter |

**Zero build step.** Static frontend + 2 Vercel serverless functions. No node_modules, nothing to compile, nothing to break.

---

## Deploy in 10 minutes (all free)

### Step 1 — Get your 2 free API keys
1. **Gemini** (AI): https://aistudio.google.com/apikey → *Create API key* → copy it.
2. **JSearch** (jobs): https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch → sign up → *Subscribe* to the free **Basic** plan → copy your **X-RapidAPI-Key**.

### Step 2 — Deploy to Vercel
**Option A (no terminal, recommended):**
1. Create a free account at https://vercel.com and https://github.com.
2. Create a new GitHub repository and upload this folder's contents (drag & drop on github.com works).
3. In Vercel: **Add New → Project → Import** your repo → **Deploy**.

**Option B (terminal):**
```bash
npm i -g vercel
cd JobReadyAI-web
vercel --prod
```

### Step 3 — Add environment variables
In Vercel: **Project → Settings → Environment Variables**, add:
- `GEMINI_API_KEY` = your Gemini key
- `RAPIDAPI_KEY` = your RapidAPI key

Then **Deployments → ⋯ → Redeploy**. Done — your app is live at `https://your-project.vercel.app` 🎉

---

## Run locally
```bash
npm i -g vercel
cd JobReadyAI-web
vercel dev        # it will ask to link/create a project, then serve at localhost:3000
```
Put your keys in a `.env` file (copy `.env.example`) or add them via `vercel env add`.

## Notes
- Resume parsing (PDF/DOCX) happens **in the browser** — your resume is only sent to the AI for analysis, never stored on a server.
- All user data (resume, tracker, streak) lives in the browser's localStorage.
- Free-tier limits: Gemini free tier is generous; JSearch free plan ≈ 200 requests/month — each job search = 1 request. Upgrade the JSearch plan if you get heavy traffic.
- API timeouts are handled with automatic retries + model fallback (2.5-flash → 2.0-flash → 1.5-flash).

## Project structure
```
JobReadyAI-web/
├── index.html      # UI (single page, dark glassmorphism design)
├── app.js          # all client logic
├── api/
│   ├── ai.js       # Gemini: analyze | tailor | coverletter | interview | salary | roadmap | motivation
│   └── jobs.js     # JSearch proxy (LinkedIn/Naukri/Indeed/Glassdoor aggregation)
├── vercel.json     # 60s function timeout config
├── package.json
└── .env.example
```
