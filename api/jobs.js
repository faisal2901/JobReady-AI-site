// JobReady AI — live jobs endpoint (JSearch on RapidAPI: aggregates LinkedIn, Naukri, Indeed, Glassdoor, Shine…)
// GET /api/jobs?q=react+developer&location=Bengaluru&datePosted=today&page=1&remote=false&employmentType=FULLTIME

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-JR-App");
  res.setHeader("Vary", "Origin");
  if (!origin) return true;
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let ok = allowed.includes(origin);
  try { if (new URL(origin).host === req.headers.host) ok = true; } catch (_) {}
  if (ok) res.setHeader("Access-Control-Allow-Origin", origin);
  return ok;
}

module.exports = async (req, res) => {
  const corsOk = applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(corsOk ? 200 : 403).end();
  if (!corsOk) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  if (req.headers["x-jr-app"] !== "1") return res.status(403).json({ ok: false, error: "Forbidden" });
  // Cache identical searches at Vercel's edge for 10 minutes: saves JSearch quota and is much faster
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1800");

  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: "RAPIDAPI_KEY is not set. Get a free key at rapidapi.com (JSearch API) and add it in Vercel env vars." });
  }

  try {
    const { q = "software developer", location = "India", datePosted = "today", page = "1", remote, employmentType } = req.query || {};

    const params = new URLSearchParams({
      query: `${q} in ${location}`,
      page: String(page),
      num_pages: "1",
      date_posted: datePosted, // all | today | 3days | week | month
      country: "in",
    });
    if (remote === "true") params.set("work_from_home", "true");
    if (employmentType) params.set("employment_types", employmentType);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(`https://jsearch.p.rapidapi.com/search?${params}`, {
      headers: {
        "X-RapidAPI-Key": key,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (r.status === 429) return res.status(429).json({ ok: false, error: "Jobs API rate limit reached (free tier). Try again in a minute." });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ ok: false, error: `Jobs API error ${r.status}: ${t.slice(0, 200)}` });
    }

    const data = await r.json();
    const jobs = (data.data || []).map((j) => ({
      id: j.job_id,
      title: j.job_title,
      company: j.employer_name,
      logo: j.employer_logo || "",
      location: [j.job_city, j.job_state].filter(Boolean).join(", ") || (j.job_country === "IN" ? "India" : j.job_country),
      remote: !!j.job_is_remote,
      employmentType: j.job_employment_type || "",
      postedAt: j.job_posted_at_datetime_utc || "",
      postedText: j.job_posted_at || "",
      applyLink: j.job_apply_link,
      applyOptions: (j.apply_options || []).map((o) => ({ publisher: o.publisher, link: o.apply_link })),
      publisher: j.job_publisher || "",
      salaryMin: j.job_min_salary,
      salaryMax: j.job_max_salary,
      salaryPeriod: j.job_salary_period,
      description: (j.job_description || "").slice(0, 6000),
      highlights: j.job_highlights || {},
    }));

    return res.status(200).json({ ok: true, count: jobs.length, jobs });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.name === "AbortError" ? "Jobs API timed out, please retry." : e.message });
  }
};
