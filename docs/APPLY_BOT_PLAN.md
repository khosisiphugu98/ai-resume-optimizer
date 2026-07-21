# Autonomous LinkedIn Application Pipeline — Plan

Fully autonomous job application system. Discovers roles, scores fit, tailors the
resume through the existing optimiser, applies on LinkedIn and on off-LinkedIn ATS
platforms, and submits — with no human in the loop. A live visual dashboard is the
observability layer, not an approval gate.

Candidate profile: Khosi Siphugu — Marketing Data Analyst / Technical Marketing
Specialist, South Africa, 3+ years.

---

## 1. Autonomy model — "skip, don't guess"

Full autonomy has exactly one hard constraint, and it isn't a review queue.

ATS forms ask things like *"Years of experience with SQL?"*, *"Are you legally
authorised to work in the United States?"*, *"Do you require visa sponsorship?"*.
An autonomous system that guesses at these is falsifying an employment
application — grounds for rescinded offers and post-hire termination, and on
authorisation questions it edges into fraud.

The resolution preserves full autonomy without ever fabricating:

> **If a question cannot be answered truthfully from the master profile, the bot
> parks the application and moves to the next one.** It never guesses, never
> estimates, never rounds up.

Parked ≠ lost. The job goes to `awaiting_answers` with the exact question that
stopped it, and sits in a dashboard queue. Whenever you open the dashboard you
answer a batch — and because answers are stored globally by normalised question
text, **every parked application waiting on that question is released at once**,
and every future application that hits it is answered automatically. Answer *"How
many years of SQL?"* once and it never stops you again.

Mechanically, a released application re-runs from the start rather than resuming a
half-filled form — browser sessions expire and postings change. That's cheap: the
tailored PDF and every other resolved answer are already cached, so a retry is
seconds of work.

The queue self-drains. Two guards on staleness:

- Re-check the posting is still live before re-running; if it closed while parked,
  mark it `expired` rather than silently retrying forever.
- Parked jobs older than 14 days age out — job postings go cold.

Expect ~30–40% parked in week one, under 5% by week three. That curve, and the
"top blocking questions" list, are the main things to watch early on — they tell
you exactly which five profile fields to fill in to unlock the most volume.

Two other autonomous-mode consequences:

- **Challenge detection is now safety-critical.** With nobody watching, a captcha
  or checkpoint that the bot blunders through repeatedly is how accounts get
  banned. Any challenge → immediate global halt + push notification. No retry.
- **EEO / voluntary disclosure** defaults to "decline to self-identify"
  everywhere. Never scored, always permitted, and it keeps sensitive personal data
  out of the automation entirely.

---

## 2. Role targeting — derived from your resume

Read from `Khosi_Siphugu_Resume (Marketing Analyst) (1).pdf`: SQL, Python, GA4,
GTM, Looker Studio, Power BI, Tableau, Grafana, R, DV360, Google/Meta/TikTok Ads,
SMADEX, programmatic, churn modelling, CLV, segmentation, ETL, n8n, API
integration. UCT BBusSc (Analytics) + Marketing/Stats/Quant Methods. Currently
AdOps Operations Assistant at Hyve Mobile.

### 2.1 Search tiers

**Tier A — core analytics (highest volume, highest fit)**
`Marketing Analyst` · `Marketing Data Analyst` · `Digital Marketing Analyst` ·
`Campaign Analyst` · `Performance Marketing Analyst` · `Growth Analyst` ·
`Marketing Analytics`

**Tier B — adtech / adops (your differentiator, far less competition)**
`Ad Operations Specialist` · `AdOps Analyst` · `Programmatic Trader` ·
`Media Analyst` · `Ad Trafficker` · `Campaign Manager`

> Disambiguate `Campaign Manager`: it's both a job title and a Google product on
> your skills list. Scoring must reject marketing-comms "Campaign Manager" roles
> with no analytics component.

**Tier C — GTM / martech (strongest strategic fit, hot titles)**
`GTM Engineer` · `Marketing Technologist` · `MarTech Analyst` ·
`Marketing Operations Analyst` · `Revenue Operations Analyst` ·
`Lifecycle Marketing Analyst` · `CRM Analyst` · `Growth Engineer`

> `GTM Engineer` deserves specific attention. It's a young, fast-growing title and
> the requirements — API integrations, n8n/automation, SQL, marketing systems —
> map almost exactly onto what you already do at Hyve. Lower applicant volume than
> "Marketing Analyst" and better paid. Weight this tier up.

**Tier D — analytics implementation**
`Analytics Implementation Specialist` · `Web Analyst` · `GA4 Specialist` ·
`Product Analyst`

### 2.2 Seniority band

3+ years, current title "Operations Assistant". Target Analyst / Associate /
Specialist / Mid. **Hard-reject** titles containing Senior, Lead, Principal, Head,
Director, VP, and any JD stating 5+ years required. Applying above band at volume
wastes the budget and trains the ATS aggregators to down-rank you.

### 2.3 Location & work authorisation — the highest-leverage filter

You are in South Africa. Most LinkedIn "Remote" postings are US-only and will
auto-reject on work authorisation. Left unfiltered, an autonomous system burns
70–80% of its daily budget on applications that were never possible.

Accept:
- South Africa — Johannesburg, Cape Town, Durban, Pretoria (onsite / hybrid / remote)
- Remote roles explicitly scoped EMEA / Africa / "anywhere" / "worldwide"
- Companies known to hire via EOR (Deel, Remote.com, Oyster, Papaya)

**Hard blocker** (reject regardless of fit score) when the JD contains
authorisation-restrictive language — *"must be authorized to work in the US"*,
*"no visa sponsorship"*, *"US-based only"*, *"must reside in the UK"* — and the
location is not South Africa.

This single rule is worth more than any other tuning in the system. Track its hit
rate on the dashboard.

---

## 3. Architecture

**Local Node service + Playwright on a persistent Chrome profile, SQLite state,
live dashboard on `localhost:5175`.**

```
resume_builder/
├── index.html, resume.js          # existing optimiser — deployed at
│                                  # khosisiphugu98.github.io/ai-resume-optimizer/
├── cf-worker/                     # existing OpenAI proxy (browser app only)
└── apply-bot/
    ├── src/
    │   ├── orchestrator.js        # stage scheduler, rate limiter, kill switch
    │   ├── browser.js             # persistent-context Playwright singleton
    │   ├── discover/linkedin.js
    │   ├── score/                 # heuristic gate + LLM fit scoring
    │   ├── tailor/optimiser.js    # drives the hosted optimiser (§4)
    │   ├── apply/
    │   │   ├── linkedin-easy.js
    │   │   └── adapters/          # off-LinkedIn ATS adapters (§5)
    │   ├── answer/resolver.js     # profile → answer bank → LLM → skip (§6)
    │   ├── stream.js              # SSE event bus + CDP screencast
    │   └── db.js
    ├── dashboard/                 # vanilla JS + SSE, zero build (§7)
    ├── profile/master-profile.json
    ├── seed/Khosi_Siphugu_Resume (Marketing Analyst) (1).pdf
    ├── data/pipeline.sqlite
    └── artifacts/                 # tailored PDFs, screenshots, form dumps
```

**Why local + persistent profile:** you log into LinkedIn once by hand in that
profile. The bot never sees your password, never touches 2FA, and runs on your real
residential IP with a stable fingerprint. Cloud/headless gets flagged on the first
run and would require storing your credentials. A Chrome extension can't drive
multi-tab off-site ATS wizards or run on a schedule.

**Why not the LinkedIn API:** there is no public job-application API. Talent
Solutions is partner-gated and is the employer side.

**Zero build step**, matching the rest of this repo — plain ES modules in Node,
vanilla JS in the dashboard.

---

## 4. Resume tailoring via the hosted optimiser

Every application gets its own resume, generated by driving
`https://khosisiphugu98.github.io/ai-resume-optimizer/` in the same Playwright
browser. All selectors below are verified against `index.html`.

### 4.1 One-time seed

On first run, upload the seed resume and persist it:

```js
await page.goto('https://khosisiphugu98.github.io/ai-resume-optimizer/');
await page.setInputFiles('#resume-upload', SEED_RESUME);
await page.click('#upload-resume-btn');
await page.waitForFunction(() =>
  !/Extracting|Parsing|Vision/i.test(document.querySelector('#upload-status').textContent));
await page.click('#save-default-btn');     // → localStorage SAVED_DEFAULT_KEY
```

`resume.js:1082 saveCurrentAsDefault()` writes the parsed resume to localStorage,
and the persistent browser profile keeps it across runs on the github.io origin.
**Every subsequent application skips upload and AI-parsing entirely** — saving a
parse call and ~20 seconds per application. Re-seed only when you update the base
resume.

Your seed PDF does have a real text layer, so `pdf.js` handles it directly and the
GPT-4o Vision fallback at `resume.js:1198` never fires. Good.

### 4.2 Per-application tailoring

```js
await page.goto(OPTIMISER_URL);            // loads saved default from localStorage
await page.fill('#job-description', job.jd_text);
await page.click('#optimize-btn');
await page.waitForSelector('#diff-view-panel', { state: 'visible', timeout: 120_000 });
await page.click('#diff-accept-all');
await page.waitForSelector('#diff-view-panel', { state: 'hidden' });

const score = await page.textContent('#match-score-value');   // log it
await page.evaluate(() => hideHighlights());
await page.pdf({ path: out, format: 'A4', printBackground: true });
```

### 4.3 One deliberate deviation from your instructions

You asked for the pipeline to "download a pdf and use that". I'm using Chromium's
`page.pdf()` instead of clicking `#download-pdf-btn`, for a specific reason.

`resume.js:551` builds the downloaded PDF with `html2canvas` → JPEG →
`jsPDF.addImage()`. **That PDF is a flat image with no text layer.** Greenhouse,
Lever, Ashby and most Taleo/iCIMS tenants extract text directly and will parse it
as an empty document. At your current manual volume this is invisible — a human
recruiter opens it and it looks great. Running autonomously at 15–25/day with
nobody checking, it would silently destroy the entire funnel and you'd have no
signal about why.

`page.pdf()` renders the same DOM with the same CSS and produces a real text
layer. Visually identical, actually parseable. Same optimiser, same output, one
better export path.

Two supporting fixes:

1. **`index.html:186` print CSS** — the hide list omits `#diff-view-panel` and
   `#match-score-panel`, so the match-score widget would print onto the PDF. Add
   both to the `display: none` rule.
2. Ship a text-PDF export button on the deployed site too, so your manual
   downloads stop being images. Worth doing regardless of this project.

Validation gate before any submission: run the generated PDF through text
extraction and assert it contains your name, email, and ≥ 5 known skill tokens. A
PDF that fails this is never uploaded.

---

## 5. Off-LinkedIn ATS platforms

### 5.1 Routing

Resolve the LinkedIn Apply redirect to its final URL, fingerprint the vendor, and
dispatch:

| Vendor | URL signature | Tier |
|---|---|---|
| Greenhouse | `boards.greenhouse.io`, `job-boards.greenhouse.io` | Build first |
| Lever | `jobs.lever.co` | Build first |
| Ashby | `jobs.ashbyhq.com` | Build first |
| Workable | `apply.workable.com` | Build first |
| SmartRecruiters | `jobs.smartrecruiters.com` | Build first |
| Recruitee / Teamtailor / JazzHR / BambooHR | various | Phase 2 |
| iCIMS | `*.icims.com` | Phase 2 — iframes |
| Workday | `*.myworkdayjobs.com` | Deferred (§5.3) |
| Taleo | `*.taleo.net` | Deferred |
| Custom / in-house | anything | Generic adapter (§5.4) |

The five "build first" platforms are structurally identical — single-page form,
labelled inputs, direct file upload, no account required — and cover a large share
of tech and startup postings. They'll carry the system.

Guard: these boards are often embedded in an iframe on the company's own careers
domain. Resolve frames before querying.

### 5.2 Adapter contract

```js
export default {
  vendor: 'greenhouse',
  matches(url, page),                  // → boolean
  async collectFields(page),           // → FieldSpec[]
  async fill(page, resolved),          // → FillReport
  async submit(page),                  // → { ok, evidence }
  async detectConfirmation(page),      // → boolean
}
```

`FieldSpec[]` is the seam. Field *collection* is vendor-specific; field
*resolution* (§6) is shared by every adapter. Write the resolver once and well.

### 5.3 Workday — deferred deliberately

Workday requires **creating an account per company tenant** — unique email,
password, email verification — then a 5–7 page wizard. Solvable with
plus-addressing (`mksiphugu+<tenant>@gmail.com`), a credential store, and IMAP
polling for verification links, but that's a week of work on its own.

The mercy is that Workday exposes stable `data-automation-id` attributes on
essentially every control, so once written the adapter is unusually durable across
tenants.

Autonomous mode makes deferral easy: Workday and Taleo jobs go to a
`manual_required` column on the dashboard with the tailored PDF attached and a
prefilled answer checklist. You do those yourself in ~4 minutes each, whenever you
want. Automate it later only if the column grows faster than you can clear it.

Its resume autofill also parses your uploaded PDF to prefill Experience — another
reason §4.3 matters.

### 5.4 Generic adapter — the long tail

For unknown platforms:

1. Serialise the form via `page.accessibility.snapshot()` — accessible name, type,
   options, required flag, fieldset context. An order of magnitude smaller than raw
   HTML and it already resolves labels.
2. Send that schema + master profile to `gpt-4o-mini` in JSON mode. Return a strict
   `{selector → value}` map plus an explicit `unanswerable[]` array.
3. Fill deterministically from the returned map. **The model produces data; it
   never drives the browser.** Small blast radius, fully auditable.
4. Any non-empty `unanswerable[]` → abandon per §1.

Each resolved generic fill teaches the answer bank, so the long tail gets cheaper
without a dedicated adapter ever being written.

---

## 5.5 Email applications — the third channel

A large share of postings, and a *very* large share of South African ones, don't
have an apply button at all: *"Send your CV to careers@company.co.za"*, often with
*"quote reference MKT/2026/04 in the subject line"*. LinkedIn shows these as plain
text in the description. Treated as a first-class channel, not an edge case.

**Detection.** Trigger when the JD contains an email address alongside apply
language (`send your CV`, `email your application`, `applications to`,
`forward your resume`), or when the posting has no apply button at all.

**Extraction.** One `gpt-4o-mini` JSON call over the JD returns:

```jsonc
{
  "to": "careers@company.co.za",
  "cc": [],
  "subjectTemplate": "Application: Marketing Data Analyst — Ref MKT/2026/04",
  "referenceNumber": "MKT/2026/04",
  "requiredAttachments": ["cv", "cover_letter", "id_document", "transcripts"],
  "requiredBodyItems": ["notice period", "current location"],
  "deadline": "2026-08-15"
}
```

`referenceNumber` and `requiredAttachments` matter more than they look. ZA
postings routinely bin applications that omit a reference number, and a request
for certified ID copies or transcripts is a hard park (§1) — never fabricate a
document you don't have.

**Compose.** Cover letter generated from JD + profile, tailored resume attached as
`Khosi_Siphugu_CV_<Company>_<Role>.pdf` (recruiters sort by filename — never send
`resume(11).pdf`). Body follows any `requiredBodyItems`.

**Send via the Gmail API, not SMTP.** OAuth, no app passwords, sends from your real
`mksiphugu@gmail.com`, threads correctly, and the sent mail is in your Sent folder
where you'd expect it. SMTP would land you in spam folders and leave no trace in
your own mailbox.

**A 15-minute outbox hold.** This is the one place I'd keep a delay even in full
autonomy. Email is irreversible in a way a form submission isn't — there's no
unsend, the recipient is a named human, and a malformed send is a first impression
you can't retract. So drafted emails sit visible in a dashboard `Outbox` column for
15 minutes and **auto-send unless you cancel**. Zero action required from you; it
just means a glance at the dashboard can catch something before it's permanent.
Configurable to 0 once you trust it.

**Reply monitoring — the hidden bonus.** Because you're already on the Gmail API,
watch for responses and auto-update application status: replied / interview
request / rejection. Email is the *only* channel that gives you automatic outcome
data, which is exactly what §7 needs to calibrate the fit filter. The ATS channels
tell you nothing back.

Daily email cap: 15. The constraint isn't Gmail's 500/day limit, it's not looking
like a bulk sender.

---

## 6. Profile, answers, and grounding

### 6.1 Master profile

One JSON file, single source of truth, seeded from your resume:

```jsonc
{
  "identity":      { "firstName": "Khosi", "lastName": "Siphugu",
                     "email": "mksiphugu@gmail.com", "phone": "+27 82 820 4538",
                     "location": "South Africa" },
  "links":         { "linkedin": "linkedin.com/in/khosi-siphugu",
                     "portfolio": "...", "github": "..." },
  "authorization": {
    "countries": { "ZA": { "authorized": true, "requiresSponsorship": false } },
    "requiresSponsorshipElsewhere": true,
    "willingToRelocate": false,
    "noticePeriodDays": 30
  },
  "experience":    [ /* Hyve Mobile, Zaio, Clarence AI, AfroStory, Markham, ... */ ],
  "education":     [ /* UCT BBusSc Analytics 2017-2020; UCT Mktg/Stats 2021-2023 */ ],
  "skills":        { "SQL": { "years": 3 }, "Python": { "years": 3 },
                     "GA4": { "years": 3 }, "Google Tag Manager": { "years": 2 },
                     "Looker Studio": { "years": 3 }, "Power BI": { "years": 2 },
                     "Tableau": { "years": 2 }, "programmatic": { "years": 2 } },
  "compensation":  { "disclose": false, "fallback": "negotiable" },
  "eeo":           { "gender": "decline", "race": "decline",
                     "veteran": "decline", "disability": "decline" }
}
```

`skills[].years` is what answers *"How many years of X?"* — deterministically, from
numbers you wrote down once. **Fill this in carefully; it's the difference between
an autonomous system and a lying one.** Any skill not listed is unanswerable, and
an unanswerable question abandons the application rather than guessing.

Compensation is unimportant to you, so: leave blank where optional, `"negotiable"`
where a text field is required, and abandon only if a hard numeric minimum is
mandatory.

### 6.2 Resolution order — first hit wins

1. **Direct profile map** — adapter-declared (email → `identity.email`)
2. **Answer bank exact match** on normalised question, scoped
   `company` → `ats` → `global`
3. **Answer bank fuzzy match** — embedding similarity ≥ 0.92
4. **LLM draft**, hard-constrained: profile is the only fact source, must return
   `UNANSWERABLE` rather than guess
5. **Abandon** the application, log the question to the dashboard

Every field logs which tier answered it. That log is your audit trail and your
debugging surface.

### 6.3 Anti-fabrication enforcement

System prompt states plainly: use only facts present in the profile; return
`UNANSWERABLE` for anything else; never estimate years of experience, never assert
work authorisation, never claim a credential.

Plus a deterministic post-check, because prompts alone aren't a control: any
numeric answer to a years-of-experience question must trace to a `skills[].years`
entry or it's rejected as unanswerable. Any answer to an authorisation question
must come from `authorization`, never from the model.

---

## 7. The visual pipeline

Local dashboard at `localhost:5175`. Vanilla JS + SSE, zero build, styled to match
the optimiser.

### 7.1 Live board

Kanban columns, cards moving in real time as the orchestrator emits events:

```
Discovered → Scored → Tailored → Applying → Submitted
                 ↓         ↓         ↓
             Rejected   Blocked   Manual
```

Each card: title, company, location, fit score, ATS vendor badge, elapsed time.
`Rejected` cards show the reason (below threshold / seniority / **authorisation
blocker**), which is how you catch a miscalibrated filter early.

### 7.2 Live browser view — the centrepiece

Chrome DevTools Protocol `Page.startScreencast` streams JPEG frames from the
Playwright page over a WebSocket to a `<canvas>` in the dashboard. You watch the
bot work in real time — reading a job, filling a Greenhouse form, clicking submit.

This is what "see everything that's happening" actually needs to mean in an
autonomous system: not a log file you'd have to read, but a window you can glance
at. Playwright traces are written per application for post-hoc stepping.

### 7.3 Application detail drawer

- Full event timeline with a screenshot at every stage
- **Every field filled, its value, and its source tier** (profile / bank / LLM)
- Tailored resume PDF inline, with its text-extraction validation result
- Fit score with the model's rationale
- If blocked: the exact question, and an inline box to answer it — which writes to
  the global answer bank and unblocks every future application hitting that
  question

### 7.4 Metrics strip

Applications today vs cap · stage funnel · fit-score distribution · **abandonment
rate and top blocking questions** (the number that should trend to zero) · ATS
vendor breakdown · rejection reason breakdown.

### 7.5 Run modes — a toggle, not a phase

A dashboard switch, flippable at any time:

| Mode | Behaviour |
|---|---|
| **Observe** | Discovers, scores, tailors. Stops before touching any form. |
| **Review** | Fills everything, screenshots it, then **waits for your click to submit.** |
| **Auto** | Fills and submits. Email still gets the 15-min outbox hold (§5.5). |

This answers your question directly: yes — in Review mode you see every field the
bot filled with its value and its source, the tailored PDF, and a screenshot of
the completed form, and nothing is sent until you press Submit. It's not a
throwaway phase-1 scaffold; it's a permanent mode you can drop back into whenever
you want to sanity-check a new ATS adapter.

Per-channel too: you can run Auto on Greenhouse and Lever once you trust them
while keeping Review on the generic adapter, which is where surprises live.

### 7.6 Alerts

Push notification on: challenge/captcha detected (global halt), daily cap reached,
adapter failure rate spike, zero jobs discovered (usually a selector break after a
LinkedIn UI change).

---

## 8. Safety and rate limiting

### 8.1 One cap was the wrong model

You're right that 8/day is pointless — you already beat that by hand. My mistake
was treating "applications" as one bucket. **Only LinkedIn-native actions carry
LinkedIn ban risk.** A Greenhouse form or an emailed CV is invisible to LinkedIn;
throttling those buys you nothing and costs you volume.

Split the budget by where the risk actually is:

| Channel | Daily cap | LinkedIn risk |
|---|---|---|
| LinkedIn Easy Apply | **15** | Yes — the exposed bucket |
| External ATS (Greenhouse, Lever, Ashby, …) | **35** | None |
| Email applications | **15** | None |
| **Total** | **~50–65/day** | |

The shared constraint is LinkedIn *page views* — discovery plus reading each JD
still hits LinkedIn even for jobs you apply to elsewhere. Budget < 250/day and
prefer harvesting descriptions once at discovery time.

So the ramp is only on the Easy Apply bucket (start 10 → 15 over two weeks); the
external and email channels can run at full rate from day one. That gets you to
roughly 50/day in week one — well past your manual rate — with less LinkedIn
exposure than a naive 25/day single-bucket design.

Realistically the mix will be dominated by external ATS anyway, since most quality
postings route off-platform.

### 8.2 Controls

| Control | Setting |
|---|---|
| LinkedIn page loads/day | < 250 |
| Delay between actions | Randomised 3–12s, log-normal |
| Delay between applications | Randomised 2–8 min |
| Operating hours | 08:00–19:00 SAST, weekdays weighted |
| Concurrency | **1.** Never two sessions on one account |
| Session | Single persistent profile, residential IP, no proxies |
| Challenge / captcha / checkpoint | **Global halt** + notify. Never retry |
| Kill switch | `apply-bot/STOP` file, checked before every action |
| Dead-man switch | Halt if submissions succeed but confirmations stop appearing |

Ramp the Easy Apply bucket specifically — a brand-new account pattern hitting
LinkedIn's native flow 25 times on day one is the most detectable thing you could
do. The other two channels have no such constraint.

**LLM cost:** use your own `OPENAI_API_KEY` locally, not the CF Worker. That
proxy has a 64 KB body cap and a shared key (`cf-worker/worker.js:8,34`), and the
bot makes 10–20 calls per application. At `gpt-4o-mini` that's a few cents each.

**Ban resilience:** export your LinkedIn data archive before starting, and keep
`jobs.source` genuinely source-agnostic so the pipeline survives a switch to
Indeed, Otta, Wellfound or direct company boards.

---

## 9. Build order

| Phase | Scope | Est. |
|---|---|---|
| **0** | ✅ **Done** — text-PDF export, print-CSS fix, validation gate, hash tooling | ½ day |
| **1** | SQLite schema, persistent Playwright context, manual login, Tier A/B/C discovery, dashboard board + live browser view. Ships in **Observe** mode. | 3 days |
| **2** | Master profile, resolver, answer bank + parked queue, scoring incl. authorisation blocker | 2.5 days |
| **3** | Tailoring via hosted optimiser, seed + save-as-default, per-app PDFs | 1.5 days |
| **4** | LinkedIn Easy Apply adapter, **Review mode**, rate limiter, kill switch, challenge halt | 3 days |
| **5** | Greenhouse, Lever, Ashby, Workable, SmartRecruiters adapters | 4 days |
| **6** | Email channel — detection, extraction, Gmail API, outbox hold, reply monitoring | 2.5 days |
| **7** | Generic accessibility-tree adapter | 2.5 days |
| **8** | Flip to **Auto** per channel; calibrate scoring against real outcomes | ongoing |
| **9** | *Optional* — Workday tenant accounts + wizard | 1 week |

Roughly two and a half weeks to a fully autonomous system across all three
channels.

The mode toggle (§7.5) means you're never locked into a phase. Phase 1 ships in
Observe so you can watch targeting for a day before anything is touched; phase 4
gives you Review so you confirm each submission by hand; you flip individual
channels to Auto as you come to trust them. Nothing is submitted in your name
until you decide it is.
