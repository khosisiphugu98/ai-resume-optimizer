# Apply-bot end-to-end assessment — 27 July 2026

Supervised live run + code audit. Mode `auto`, agent enabled, both API keys set,
Gmail connected, profile reporting 0 unconfirmed fields.

---

## 1. Headline

**The system discovers, scores and tailors well, and fills fields *accurately*. It
almost never *completes* an application.**

Lifetime record before this run, from `applications` (66 rows):

| channel | attempts | submitted |
|---|---|---|
| `linkedin_easy` | 13 | **0** |
| `external_ats` | 52 | **0** |
| `email` | 1 | 1 |

One application has ever been sent, by email, on 23 July.

The failure is not one bug. It is **four independent blockers, each individually
sufficient to prevent a submission**, stacked on the same path. Fixing any one of
them alone changes nothing — which is why the system has looked "almost working"
for weeks.

---

## 2. The four blockers

### B1 — Generic external forms are structurally forbidden from submitting
`adapters/index.js:81` sets `GENERIC.requiresReview = true`; `external.js:243`
computes `submit && !vendor.requiresReview`. For any unrecognised ATS, submit is
forced `false` before the wizard starts, so `wizard.js:110` returns `ready` and the
submit block at `external.js:295` is dead code.

**69 of 86 resolved external jobs (80%) are `generic`.** In `auto` mode they log
`Ready for review — 6 fields filled` and stop. Worse, `external.js:291` builds an
explanatory string `heldForReview: 'generic adapter never auto-submits'` that
`run.js:190` **never reads or emits** — so the operator is never told why.

Approving the job does not help: `run.js:126` sets `shouldSubmit=true`, `external.js:243`
discards it, `run.js:187` records `blocked` and flips the job back to
`awaiting_review`. **The human escape valve is an infinite loop** that re-fills the
live vendor form on every cycle.

### B2 — A single unresolvable field aborts the whole form before anything is typed
`wizard.js:62`: `if (parked.length) return { outcome: 'parked', ... }` — this runs
**before the fill loop**. One unanswerable required field discards the entire
application without typing a character.

This is why `linkedin-easy` shows **13 applications at an average of 0.0 fields
filled**. It is not that LinkedIn fills badly; it never fills at all.

### B3 — Operator corrections are silently ignored (tier-ordering bug)
`resolver.js:67-75` runs the profile tier and **returns a park immediately** on an
option mismatch. `resolver.js:78` — the human-verified answer bank — is only
reached if the profile tier returned *nothing*. A park is not nothing, so the bank
is never consulted.

Proof, from the live DB. The `answers` table has exactly one row:

```
question_norm: "email address"  ->  "ksiphugu@icloud.com"
source: human   human_verified: 1   created: 2026-07-23   times_used: 0
```

The operator taught it the correct answer on 23 July. **`times_used` is 0.** In this
run it parked on that same question three more times:

```
06:44:17 job1950 Parked — Email address ("mksiphugu@gmail.com" is not one of:
                 ksiphugu@icloud.com | hpmnwp4zwn@privaterelay.appleid.com)
```

"Email address" is the **#1 parked question (×10)** and, via B2, it alone aborts
most LinkedIn applications. One four-line fix — fall through to tiers 2/3 when tier
1 parks — makes every past and future operator correction take effect.

### B4 — The adaptive agent's auto-submit gate is mathematically unreachable
- `agent/index.js:77` executes a fresh plan with `makeGate(submit, 0)`; `gate.js:27`
  requires `planSuccessCount >= 3`.
- `db.js:894` `savePlan` upserts `success_count = 0`, and `agent/index.js:84` never
  bumps it on save. So **five separate visits to a byte-identical page shape** are
  required before the gate can pass.
- The reuse key (`capture.js:31-37`) is a sha256 of host + every control's
  `role:name`. In production: **17 captures, 17 distinct fingerprints, every
  `seen_count` = 1.** `accounts.google.com` alone produced three different
  fingerprints. The shape never repeats, so the counter never climbs.
- `page_plans` is empty anyway, because the one planner call ever made returned
  `kind: 'unsupported'`, and `plan.js:76` treats that as **success** — which also
  skips the gpt-4o fallback at `plan.js:135`. It logged as
  `Agent plan from Claude (unsupported, 0 field(s))`, which reads like a win.
- `llm-anthropic.js:26` sets `max_tokens: 2000` with adaptive thinking at
  `effort: 'high'`, and never checks `stop_reason === 'max_tokens'`. A truncated
  response falls into `JSON.parse` and is swallowed as a syntax error.

Separately, `gate.js:15` requires every field to be tier
`profile|bank-exact|operator|resume|prefilled`. Across all applications the tier
histogram is `profile 77, resume 46, llm 27` — **13 applications contain at least
one `llm` field**, so ~31% would fail this check even if everything else were
fixed. Any form with a free-text question can never auto-submit by design.

---

## 3. Field identification and filling — the mechanics

This is the area flagged as suspect. The verdict is split.

### What is genuinely good
- **Values that get filled are correct.** Every inspected `filled_json` had the right
  name, email, phone, LinkedIn URL and the right tailored CV. No wrong-person data,
  no scrambled fields.
- **The collector is well built.** `a11y.js` resolves implicit/explicit ARIA roles,
  collapses radio groups, names fieldsets by their legend (the comment at `:90`
  shows this was a real fix), handles custom comboboxes with detached listboxes,
  and treats file inputs as visible-by-exception. It correctly reads German labels
  (`E-Mail Adresse` matched).
- **Option fitting works** where it is reached: `30 days → "1 month"` (rule=duration),
  `3 → "2-3"` (rule=range) both resolve correctly and confidently.
- **The anti-fabrication posture is real** — park rather than guess is the default,
  and it is enforced deterministically rather than by prompt.

### Empirical test of the answer layer
A representative 30-field ATS form (real profile, real key, scratch DB):

**22 filled / 8 parked — but 7 of the parks are on *required* fields, so the form
cannot be submitted.** A single required park is fatal (B2).

Causes of the 7:

| # | field | cause | class |
|---|---|---|---|
| 1 | Email address (select) | profile email not in offered list; bank never consulted | **code (B3)** |
| 2 | Phone country code | raw phone `+27 82 820 4538` sent into a country-code list | **code** |
| 3 | "years of *relevant full-time* experience" | `extractSkill` returns the junk noun `"relevant full-time"` | **code** |
| 4 | "4–5 years of experience in digital marketing" | a **Yes/No** question hijacked by the years matcher | **code** |
| 5 | Expected salary | no numeric salary anywhere in the profile | **data** |
| 6 | Driver's licence | `misc.hasDriversLicense: null` | **data** |
| 7 | Start availability | `misc.startAvailability: ""` — though `noticePeriodDays: 30` is right there | **data + logic** |

So roughly **half the fill failures are missing profile data, not code.** Those are
free to fix.

### Specific defects found

**D1 — `matchOption` cannot handle the two commonest select shapes.**
Verified directly:
```
"+27 82 820 4538" -> country-code list ....... NO MATCH  (both modes)
"South Africa"    -> country-code list ....... "South Africa (+27)"  ✅
```
The value is right, the *wording* is wrong. A country-code select should be fed
`identity.country`, not `identity.phone`. Likewise an email select should be
matched on local-part/domain rather than string equality.

**D2 — `extractSkill` produces garbage nouns.**
```
"How many years of relevant full-time experience do you have?" -> "relevant full-time"
```
It then fails a strict "is this in the profile" test and parks. Generic qualifiers
(`relevant`, `full-time`, `professional`, `total`, `work`) should map to
`current.totalYearsExperience` (= 3), which is confirmed and available.

**D3 — the years matcher hijacks Yes/No questions.** "Do you have 4–5 years of
experience in digital marketing?" has options `Yes|No` and is answerable, but the
`/years of experience/` pattern routes it to the years path, which parks.

**D4 — readonly inputs are treated as fillable.** `a11y.js:157` `disabledOf` checks
`el.disabled` and `aria-disabled` but **not `el.readOnly`**. Production shows the
consequence: a 30-second `locator.fill` timeout on
`<input readonly ... value="https://treasuryone.bamboohr.com/careers/189">`, which
then parks the whole application.

**D5 — the LLM fabricates unguarded facts and they are accepted.** With
`identity.city` empty, the model answered **City → "Johannesburg"** and it was
filled at tier `llm`. `guardAnswer` covers years, work authorisation and
credentials — **nothing guards location, salary or availability**.

**D6 — `guardAnswer` is simultaneously too strict and too loose.**
- Too strict: `resolver.js:188-192` — *both* branches return `ok:false`, so **any**
  work-authorisation question reaching the model is an automatic park, even when the
  profile knows the answer.
- Too strict: `:176` compares `String(total) !== v.trim()`, so `"3 years"` fails
  against `"3"`.
- Too loose: `:198` only fires when the answer is exactly `yes`/`true`. "Yes, I hold
  a valid licence" bypasses the credential check entirely.
- Too loose: `:202` accepts a credential if **any** word >4 chars from the question
  appears anywhere in the résumé text. On a full CV this is nearly always true, so
  the credential guard is close to a no-op for résumé-grounded answers.

**D7 — profile matching is too literal.** `First name` resolves at tier `profile`,
but `Enter your first name` falls through to the **LLM**. Real applications show
`llm` tier being burned on first/last name. Cost and fragility for no reason.

**D8 — open-text answers are vacuous.** The model answered
*"What excites you about working at Acme Analytics?"* with
**"I am excited about the opportunity to work at Acme Analytics"** — a tautology
that would be submitted verbatim to an employer. The resolver runs on
`gpt-4o-mini` (`llm.js:5`).

---

## 3a. Upstream: the board is being killed before anything is judged

This turned out to be the largest single leak in the system, and it is upstream of
everything in §2.

**Only 613 of 2305 jobs have ever been judged by the LLM. 1188 were killed by a
12-word substring regex matched against the job *title* only.**

```
1188  TITLE GATE  (score hard-set to 0, no LLM call)
 613  LLM-scored
 577  (never scored — rejected at enrich, or still upstream)
```

`score/index.js:114` returns `{score: 0, rationale: 'Title is outside the targeted
role families'}` before any spend. `runScoring` then writes
`reject_reason = 'fit 0 < 65'` — **so the board reports these as "scored 0 and below
threshold" when they were never scored at all.** That is why I initially read this
as LLM output; it is not.

The gate (`reject-criteria.js:84`) is a bare alternation with **no word boundaries**,
over 12 terms, against the title only — even though `heuristicScore` already has the
full JD in hand. It therefore both over-rejects and over-admits (`data` matches
`Metadata`, `Data Entry Clerk`).

Live examples from **this run**, all scored 0 with no LLM call:

```
Creative Strategist — DTC Ads & E-commerce   @ Kelson
Advertising Specialist                       @ Simera
Social media manager / content creator       @ Odixcity
Business Operations Associate (Remote)       @ Hired
```

Across the board this pattern has killed jobs including `Google Ads Manager`,
`Amazon PPC Manager`, `Business Intelligence Engineer`, `Junior Media Buyer`,
`CRM Manager`, `SEO Manager`, `User Acquisition Specialist`, `ASO Specialist`.
**~120 have overtly on-target titles; 64 have JDs literally containing GA4 / Google
Ads / Looker Studio / Power BI.**

Two more upstream gates leak badly:

- **`\blead\b` is in `SENIORITY_TERMS`** (`config.js:91`), so `Lead Generation
  Analyst`, `Growth Lead`, `CRO Lead` and `Lead Analyst` are rejected as
  "above band". **473 seniority rejections, ~73 with no real seniority word.**
  Compounding it, `linkedin.js:31` sends `f_E: '2,3,4'` — the search *asks* LinkedIn
  for mid-senior roles, then throws them away locally.
- **`blocker:` is raw, unvalidated LLM free text used as an unappealable hard
  reject** (`score/index.js:175`). It is *not* the `AUTH_BLOCKERS` regex list. Of 143
  blocker rejections: 75 foreign-language (correct), but **27 location — 9 of them
  ZA cities the candidate lives near**, 17 degree, 7 "experience gap", 6 driver's
  licence, and **3 where the model literally returned the string `"None"`**. One
  live example from this run:
  `Rejected (blocker: Minimum BSc Computer Science...) — Business Analyst @ HENSOLDT`.
  The scoring prompt never tells the model where the candidate lives — because
  `identity.city` is empty (§3, D5).

**Roughly 294 recoverable applications are sitting in `rejected` right now**
(≈120 title-gate + 73 `lead` + 42 junk-blocker + 55 in the 60–64 band), against a
system that has produced one submission. **About 60% of all lost volume is one
regex on one field.**

The threshold of 65 is also unvalidated and badly placed: of 613 real scores the
50–59 bucket holds 8 and the 60–69 bucket holds 88 — **the cut runs straight through
the densest live band**, rejecting 55 jobs that scored 60–64. It cannot be validated
either: calibration needs 40 labelled outcomes and there is exactly 1, and the audit
sampler requires `score >= 40`, so it is structurally blind to the 1188 jobs scored 0.

## 4. Channel-by-channel

### LinkedIn Easy Apply — 0 fields filled, ever
13 attempts, avg 0.0 fields. Cause chain: B3 (bank ignored) → B2 (whole form
aborts) → park. Secondary: `linkedin-easy.js:123-126` waits up to 8s for a footer
button but, despite its comment, **never polls for inputs**, so a modal that mounts
fields before its footer yields `step 1 has no next, review or submit control`
(11 occurrences).

**The single highest-yield fix in the whole system is to verify
`mksiphugu@gmail.com` on the LinkedIn account, or set the profile email to
`ksiphugu@icloud.com`.** That is zero code and clears the #1 park.

### External ATS — fills well, cannot submit
Best case 6–7 fields across 2 steps with correct values. Blocked by B1.
Adapter coverage is thin:

| adapter | apps | avg fields |
|---|---|---|
| `ats:generic` | 35 | 3.8 |
| `ats:greenhouse` | 8 | **1.0** |
| `ats:workday` | 6 | 0.0 (deferred) |
| `ats:ashby` | 2 | 4.5 |
| `ats:lever` | 1 | 1.0 |

**Greenhouse fills only the CV attachment** — no name, no email. That adapter is
broken, not merely limited.

Unregistered but automatable vendors seen in captures: `oraclecloud.com`,
`app.recruitis.io` (11 controls), `recruitcrm.io`, `uttr.catsone.com`,
`meltwatercareers.ttcportals.com`, `belong.advania.co.uk` (20 controls seen,
reported as "no fillable fields").

**The bot repeatedly tries to fill `accounts.google.com` sign-in pages** — 3 of 17
captures, the most common single "form" it finds. There is no login-wall guard.

### Email — the machinery works; the channel has almost no supply
`apply_type='email'`: 45 jobs, **44 rejected, 0 available to apply to**.

I reviewed all 45 titles. **The scorer is largely right.** The email-apply route on
LinkedIn in South Africa skews overwhelmingly to trades, admin and finance:
Millwright, Legal Secretary, Nursing Home Manager, Equipment Operators,
Biostatistician, Construction Supervisor, Proposal Engineer (DCS/PLC),
"Tumbling Tigerz Coaches Wanted". These are correctly rejected.

Genuinely mis-rejected — **3 jobs**, all on false "blockers":

| id | title | reject reason |
|---|---|---|
| 1835 | Business Analyst, Tuhf Capital (fit 45) | `blocker: BCom IT or similar qualification` |
| 441 | Marketing Executive, Prins & Prins | `blocker: Valid driver's license and own transport` |
| 426 | Receptionist & Marketing Assistant | `blocker: Valid driver's license` |

A degree preference and a driver's licence are **not work-authorisation blockers**,
but they are treated as hard, unrecoverable rejections rather than parks. Note the
licence case is aggravated by `misc.hasDriversLicense: null` — an *unknown* is being
resolved as a blocker.

So: this is **a supply problem first (≈93% correctly rejected) and a false-blocker
bug second (≈7%)**. Widening the role-family gate would not fix it; it would just
apply to Millwright jobs. Real email volume needs different sourcing, not a looser
filter.

The machinery itself is sound — 1 email sent successfully, Gmail connected as
`mksiphugu@gmail.com`, 15-minute hold, drafts mirrored to disk. The sent body is
**good**: specific, grounded in the JD, no hallucinated claims. One quality risk
observed — for a recruiter posting on behalf of a client it addresses
"Resource Complete" in the greeting but then discusses "GEAR's marketing
activities" in the body, mixing agency and end-client.

---

## 5a. The tailored CV is not always tailored — and the one email ever sent proves it

I hashed the extracted text layer of all 164 PDFs in `artifacts/resumes/`:

```
164 files  ->  147 distinct documents
2 duplicate groups (14 files and 5 files) = 19 of 164 (11.6%) are
text-identical to another job's "tailored" CV
```

The 14-way group spans completely unrelated roles:

```
Amaris Consulting — Data & AI Engineer
Kurtosys — Technical Business Analyst
Meltwater — Account Manager, Customer Growth
BruntWork — Digital Marketing Manager
Resource Complete — Marketing Coordinator      <-- the ONE email ever sent
```

**The single application this system has successfully submitted attached an
untailored, generic CV**, while its covering letter claimed a *"proven track record
in content development and digital presence management."*

Every guard that should catch this is decorative:
- `optimiser.js:153` treats `diffCount === 0` as a legitimate success and nothing
  compares the export against the seed document.
- The page-count check (`:222`) cannot fail: `page.pdf()` is called with
  `height: ${box.h}px`, so a 15 000px-tall page is still "one page".
- `validateResumePdf` (`:229`) is passed **all 188 profile "skills"** and needs only
  5 to appear. Those "skills" include `Remote`, `collaborate`, `KPI`, `charts`,
  `attention to detail` — so any A4 page with the candidate's name and five English
  words passes.
- `tailored_at` is declared in `db.js:107` and **written by nothing**. All tailored
  rows have it NULL, so a CV tailored three weeks ago is indistinguishable from
  today's and can never be expired.

**The anti-fabrication allowlist has also been auto-confirmed into uselessness.**
This run logged it live:

```
tailor  Auto-confirm allowlist seeded — 188 confirmed skill(s)
```

`optimiser.js:317` confirms whatever the evidence gate returns, and that loop has run
to completion: **188 of 188 profile skills are now `confirmed: true`**, 172 with no
`source` at all. The list the optimiser may weave into the CV now includes `AWS`,
`machine learning`, `Data Scientist`, `WordPress`, `CI/CD pipelines`. The guard
against fabricating skills into the CV now *authorises* them.

Minor but real: `outputName` (`optimiser.js:35`) truncates the title to 40 chars, so
190 job rows map to 159 distinct paths — one job's PDF silently overwrites another's.

## 5b. Email safety defects

The composer and Gmail integration work, but:

- **`EMAIL_RE` (`extract.js:23`) swallows a sentence-ending full stop.** 5 of 45
  stored addresses (11%) end in a dot — `stefan@prinsandprins.com.`,
  `contact@o-ring.tech.` — and will hard-bounce.
- **First address in the JD wins, with no role filter** (`extract.js:57`). One
  posting contained both a recruiter address and `dpo@aubay.pt` — only document
  order stopped the CV going to the Data Protection Officer. Nothing excludes
  `dpo@`, `privacy@`, `legal@`, `noreply@`.
- **The hallucinated-recipient correction leaks unvalidated CC** (`extract.js:88-92`):
  the `{...out}` spread carries the model's CC array on exactly the path where the
  model has already proven it invents addresses, bypassing the CC filter that exists
  on the happy path.
- **No dedupe of any kind.** `queueEmail` is a bare INSERT. Two job pairs already
  share an inbox — 4 queued sends to 2 recipients. Across channels: 7 applications
  to Agoda, 5 to Quik Hire Staffing.
- **The MIME boundary is `----=_bot_<timestamp>_<random>`** (`mime.js:32`). The word
  **`bot`** is embedded in every message's structure, visible in "Show original".
  Fix this today.
- **`buildSubject` is dead code** whenever the LLM key is set — the model always
  supplies a `subjectTemplate`, so the careful `Application: {title} — Ref — {Name}`
  format never runs. The real send went out as *"Application for Marketing
  Coordinator Position"*: no name, no reference, unsearchable in a recruiter's inbox.
- The covering letter has **no post-hoc fabrication check at all** — the prompt
  forbids invention, nothing validates the output. The CV pipeline at least has a
  guard; the document a human reads first has none.

## 5. Safety, rate limits and hygiene

- **The anti-ban budget is spent by the channel with no ban risk.** `external.js:130`
  debits `linkedin_pageviews` for every external URL resolution, but `rate.js:49`
  only *enforces* the budget for channels named `linkedin*`. Yesterday: external
  consumed **247 of 250** pageviews while `linkedin_easy` used 0 — starving the
  channel the budget exists to protect, exactly the starvation `run.js:72-76`
  claims to prevent.
- **A LinkedIn challenge halts email.** `rate.js:31` applies `challenges_hit > 0` to
  every channel; `browser.js:190` uses `page.$()`, which matches hidden elements, so
  a `display:none` challenge template would freeze everything with no auto-recovery.
- **`today()` is UTC** (`db.js:137`) but `withinHours()` is SAST (`rate.js:20`). The
  operator's daily caps reset at **02:00 SAST**, not midnight.
- **Easy Apply is invisible to the pageview budget** — `linkedin-easy.js` never calls
  `bumpRate('linkedin_pageviews')`, so actual LinkedIn browsing is undercounted.
- **Duplicate-submission risk.** `external.js:302` treats any URL change as
  confirmation (false positive), and reads confirmation text from the **main frame
  only** — so an iframe-hosted form that succeeds is recorded as `apply_failed` and
  **re-submitted on the next cycle**. `run.js:206` → `run.js:93` closes that loop.
- **The résumé broadcasts four named referees** — full names, personal mobile numbers
  and emails of real third parties — to every employer automatically. Worth a
  deliberate decision rather than a default.
- **Secrets never reach CLI runs.** `applySecretsToEnv()` is called only from
  `server.js:29`. `npm run apply|score|tailor|email` run with **no API keys**, so the
  resolver silently degrades to *"no profile fact, no stored answer, and no LLM
  key"* and scoring falls back to heuristics. Production data is unaffected (all
  1780 scored rows went through the server), but any direct CLI run is quietly
  crippled.
- `browser.js:150` starts a screencast that **never stops** and runs whether or not a
  dashboard client is connected; `reclaimProfile` will SIGKILL the operator's own
  Chrome on that profile — which is what `run.js:201` tells them to open.

---

## 6. What is strong

Worth stating plainly, because the failures above are concentrated in one layer:

- Discovery and JD fetch work well — 379 cards seen, 73 new kept in one pass.
- A *correctly* tailored PDF is genuinely good: one page, right contact details,
  well-written prose, real referees. (Caveats in §3a and §5a.)
- The tier ladder with a deterministic guard after the model is the right
  architecture. Park-don't-guess is enforced in code, not by prompt.
- The a11y collector is better than most commercial form-fillers.
- Capture/replay, plan pinning, the review queue and the correction UI are all real
  and wired up — the feedback loop exists, it is just short-circuited by B3.
- Caps, pacing, the kill switch and challenge detection are all present and layered.

The system is roughly **90% complete and 0% converting.** Everything upstream of
submission works; a handful of gates at the end stop all of it.

---

## 7. Fix order

Two separate problems, so two tracks. **Volume** (jobs reaching the apply stage) and
**conversion** (applications actually completing). Conversion is worth more — there
is already a 43-job tailored backlog that cannot be submitted — but two volume bugs
are so cheap and so large they belong at the top.

**Do first — correctness/reputation, today:**

0a. **Stop shipping untailored CVs.** Hash the seed résumé's text once; refuse to mark
    a job `tailored` if the export's text hash equals it. Assert `chars > 3000`.
    11.6% of CVs on disk are duplicates, including the only one ever sent.
0b. **Rename the MIME boundary** — the word `bot` is in every email you send.
0c. **Strip trailing dots from extracted email addresses** — 11% currently bounce.
0d. **Cap the auto-confirm loop.** 188/188 skills are "confirmed"; the fabrication
    guard now authorises `AWS` and `machine learning` into the CV.

**Then — conversion:**

1. **Verify the LinkedIn email address** — zero code. Clears the #1 park (×10).
2. **`resolver.js:67-82` — fall through to the answer bank when tier 1 parks.**
   ~4 lines. Makes every operator correction work, retroactively.
3. **Fill profile data gaps** — `identity.city`, `misc.hasDriversLicense`,
   `misc.startAvailability`, a numeric `compensation.expectedAnnual`, and add `city`
   to `unconfirmed()` so it can never silently pass again. Removes 3 of 7 required
   parks.
4. **B1 — make `requiresReview` overridable**, and stop demoting approved jobs back
   to `awaiting_review`. Unlocks 80% of the external channel and repairs the human
   escape valve.
5. **B2 — fill what resolved before parking**, and park the *form* only at the
   terminal. Partial fills are worth keeping; all-or-nothing is why LinkedIn is at
   0.0 fields.
6. **D1/D2/D3 — country-code selects, `extractSkill` qualifiers, Yes/No hijack.**
   Small, targeted, high frequency.
7. **D4 — treat `readOnly` as unfillable** in `a11y.js:157`.
8. **Add a login-wall guard** (`accounts.google.com`, password fields → `manual`).
9. **Never `throw` after clicking submit**; search all frames for confirmation.
   Prevents duplicate applications before volume rises.
10. **Scope the challenge halt to LinkedIn**; stop external debiting the pageview
    budget.
11. **Fix the planner** — soft-fail `unsupported`, raise `max_tokens`, handle
    `stop_reason`. Then loosen the fingerprint to host-scoped confidence.
12. **Stop treating non-auth requirements as hard blockers** — a degree preference
    or a driver's licence should *park* (or simply lower the score), not reject.
    Set `misc.hasDriversLicense` so an unknown stops resolving as a blocker.
    Note this recovers ~3 email jobs, not a channel: **email volume is a sourcing
    problem, not a filter problem.** If email throughput matters, the fix is new
    supply (job boards / company career pages / recruiter lists), not a looser gate.
13. **`applySecretsToEnv()` in `cli.js`** so CLI runs aren't silently keyless.

**And — volume (biggest single win in the system):**

V1. **Make the title gate consult `jd_text`, not just the title**, add `\b`
    boundaries, and add the missing families (`media buyer|ppc|seo|sem|crm|
    lifecycle|acquisition|demand gen|performance|business intelligence|insights|
    reporting|google ads|social`). And when it does fire, write
    `reject_reason = 'title gate: outside role families'` — **never `fit 0 < 65`**,
    which currently makes 1188 unjudged jobs look like considered rejections.
V2. **Anchor `lead`** — `^lead\b|\blead$|\bteam lead\b|\btech lead\b`, with a
    negative lookahead for `lead generation`. Recovers ~73 jobs.
V3. **Validate `blockers[]`**: drop `"None"`, require an enum
    (`auth|language|location|credential|experience`), hard-reject only on
    `auth`/`language`, and **pass the candidate's city into the scoring prompt** so
    an on-site role in their own city stops being a disqualifier.
V4. **Drop the threshold to 55** and instrument it — 65 cuts through the densest
    band (88 jobs in 60–69) on a number backed by one labelled outcome.
V5. **Route `apply_type='unknown'` to `resolveExternalUrl`** — 4 jobs at avg fit 76,
    already tailored, currently unreachable by any code path.

Together V1–V5 are worth roughly **294 recoverable applications** already sitting in
`rejected`.

---

## 8. Live run record — 27 July 2026

Supervised, `auto` mode, agent enabled, permission to submit.

| batch | attempts | submitted | queued | parked | failed |
|---|---|---|---|---|---|
| 1 (5 easy) | 5 | 0 | 0 | 2 | 3 |
| 2 (2 easy, 3 ext) | 5 | 0 | 0 | 3 | 2 |
| 3-6 (rest) | 15 | 0 | 6 | 5 | 9 |
| **total** | **25** (8 easy, 17 external) | **0** | **6** | **10** | **14** |

Discovery pass in the same run: 379 cards seen, 73 new kept, 21 enriched,
**6 passed scoring / 15 rejected**, 6 tailored — and **zero new email-route jobs**.
The email stage was then run and returned *"No email applications ready"*. So the
requested 10 email applications were not merely blocked by a bug: after a full fresh
sourcing pass the channel had **nothing legitimate to send**. Sending the rejected
backlog (Millwright, Legal Secretary, Nursing Home Manager) would have been spam, so
I did not.

Park causes were exactly the ones predicted by the static analysis — `Email address`
(×3), `Phone country code`, and `"relevant full-time"` years extraction (×2, both
Agoda/Greenhouse). The agent escalated once and logged
`Agent plan from Claude (unsupported, 0 field(s))` at info level, then discarded the
plan without trying the gpt-4o fallback.

**No application was submitted, on any channel, at any point in this run.**
`page_plans` is still 0. `answers.times_used` is still 0.

### The single most revealing artefact: an 18-field fill that could not be sent

`Junior Business Analyst @ Braun Management` (app 73) filled **18 fields in one
step** — the best result the system has ever produced — and was recorded
`outcome: blocked` because the vendor was `generic` (B1). It is worth reading in
full, because it shows both the ceiling and the quality problem at once:

```
resume   Upload PDF, DOC, or DOCX            => Khosi_Siphugu_CV_Braun_...
resume   Upload PDF or Word document         => Khosi_Siphugu_CV_Braun_...   <- same CV twice
profile  First name                          => "Khosi"                       ✅
profile  Last name                           => "Siphugu"                     ✅
profile  Email address                       => "mksiphugu@gmail.com"         ✅
profile  Phone number                        => "+27 82 820 4538"             ✅
profile  Salary expectation                  => "Negotiable"                  ✅
profile  Notice period                       => "1 month"                     ✅
profile  Availability / earliest start date  => "30 days"          ⚠ not a date
llm      Current city                        => "South Africa"     ❌ a COUNTRY in a city field
llm      Preferred work arrangement          => "Remote"                      ✅
llm      Remote work experience              => "3-5 years"                   ✅
llm      Yes                                 => "Yes"              ❌ question unknown
llm      Home office setup                   => "Dedicated home office"       ✅
llm      Yes                                 => "Yes"              ❌ question unknown
llm      Preferred employment type           => "Open to any arrangement"     ✅
llm      Yes                                 => "Yes"              ❌ question unknown
llm      Portfolio / work samples            => "I have experience in build…" ⚠ prose in a URL field
```

Three findings, all new and all serious:

1. **Three fields have the literal question text `"Yes"`.** Label resolution failed
   and captured the *option* as the *question*, so the system answered "Yes" to
   three questions **it could not read**. This is a direct hole in the
   anti-fabrication model: the whole design is "never answer what you don't know",
   and here it answers blind. Whatever those three questions were — willingness to
   relocate, a background check, a certification claim — they were agreed to. This
   should park unconditionally when the resolved question equals one of the field's
   own options.
2. **`Current city => "South Africa"`** — a country in a city field, caused directly
   by `identity.city` being empty while `unconfirmed()` reports the profile complete.
   Confirms D5 with a concrete wrong value that would have been submitted.
3. **`Availability / earliest start date => "30 days"`** — the notice period passed
   verbatim into a date control. Correct fact, wrong format.

So the ceiling is high — 18 fields, mostly right — but **3 of 18 values are wrong and
2 more are badly formatted**, and none of it can be submitted anyway.

### Duplicate applications are already happening

`Data Scientist – AI/ML (Remote) @ Jobs Ai` (job 2462) and the same title
`@ Hire Feed` (job 2463) both resolved to the **identical** URL
`jobs.micro1.ai/post/84782580-…` and both filled 6 fields. Two separate applications
to one posting, in one batch. There is no dedupe on resolved apply URL.

### The Google login-wall bug, live

`Email Marketing Assistant @ TalentPop App` resolved its apply URL to
`accounts.google.com/v3/signin/identifier?continue=…docs.google.com…` and the bot
attempted to fill **Google's sign-in page**, escalated to the agent, and burned a
retry. This is the most-captured "form" shape in the whole database.
