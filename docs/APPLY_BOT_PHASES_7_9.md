# apply-bot — Phases 7, 8, 9 Implementation Spec

Written to be implemented in a fresh thread with no prior context. Everything
needed to start is below: current architecture, conventions, invariants, then
each phase in detail.

Companion documents:
- [`APPLY_BOT_PLAN.md`](./APPLY_BOT_PLAN.md) — the original design and the
  reasoning behind the autonomy model
- [`../apply-bot/README.md`](../apply-bot/README.md) — operator-facing docs

---

## 0. Orientation — read this first

### 0.1 What the system already does

A local Node service drives a persistent Chrome profile via Playwright. It
discovers jobs on LinkedIn, scores them for fit, tailors a CV per job through a
hosted resume optimiser, and applies through three channels. A dashboard on
`localhost:5175` is the whole UI — the operator does not use a terminal.

Phases 0–6 are complete and pushed:

| Phase | What shipped |
|---|---|
| 0 | Text-layer PDF export, print-CSS fixes, hash tooling |
| 1 | SQLite schema, persistent browser, discovery, dashboard, live browser view |
| 2 | Master profile, answer resolver, answer bank, parked queue, fit scoring |
| 3 | Per-application CV tailoring via the hosted optimiser |
| 4 | LinkedIn Easy Apply, review queue, per-channel rate limiting, challenge halt |
| 5 | Greenhouse, Lever, Ashby, Workable, SmartRecruiters + generic fallback |
| 6 | Email channel — Gmail API, outbox hold, reply monitoring |

### 0.2 File layout

```
apply-bot/
├── src/
│   ├── config.js              # SELECTORS, CAPS, HOURS, SEARCHES, filters, PATHS
│   ├── db.js                  # schema, migrations, all query helpers
│   ├── bus.js                 # emit(), emitBoard(), emitFrame() — SSE event bus
│   ├── browser.js             # persistent Playwright context, challenge detection
│   ├── llm.js                 # callLLM(), hasKey() — OpenAI, gpt-4o-mini
│   ├── profile.js             # master profile load/query, confirmed-flag logic
│   ├── secrets.js             # OpenAI key storage (profile/secrets.json, 0600)
│   ├── server.js              # HTTP + SSE + WS, STAGES registry, all API routes
│   ├── cli.js                 # same stages, terminal flavour
│   ├── discover/
│   │   ├── linkedin.js        # runDiscovery, runEnrich, preFilter, classifyApply
│   │   └── jd-fetch.js        # guest-endpoint JD fetch (unauthenticated)
│   ├── score/index.js         # heuristicScore, scoreJob, runScoring, THRESHOLD
│   ├── tailor/optimiser.js    # drives the hosted optimiser, page.pdf() export
│   ├── answer/
│   │   ├── matchers.js        # tier 1 — deterministic profile lookups
│   │   ├── bank.js            # normaliseQuestion, lookupExact/Fuzzy, saveAnswer
│   │   └── resolver.js        # the ladder + guardAnswer()
│   ├── apply/
│   │   ├── fields.js          # collectFieldsInPage(), fillField()  ← phase 7 extends
│   │   ├── linkedin-easy.js   # Easy Apply modal state machine
│   │   ├── external.js        # generic single-page ATS flow  ← phase 7 extends
│   │   ├── adapters/index.js  # VENDORS, DEFERRED, GENERIC, detectVendor()
│   │   ├── rate.js            # canApply(), caps, operating hours
│   │   └── run.js             # runApplications() — dispatch + modes
│   └── email/                 # extract, compose, mime, gmail, outbox
├── dashboard/                 # index.html + app.js, vanilla, zero build
├── scripts/                   # *-tests.mjs, one file per area
├── profile/                   # gitignored — master-profile.json, secrets, tokens
├── data/                      # gitignored — pipeline.sqlite, chrome-profile/
└── artifacts/                 # gitignored — CVs, screenshots, email drafts
```

### 0.3 Conventions that must be followed

- **Zero build step.** Plain ES modules in Node 22, vanilla JS in the dashboard.
  No bundler, no TypeScript, no framework. Match this.
- **Tests are standalone `.mjs` scripts** in `scripts/`, each with a local
  `t(name, got, want)` assert helper, printing `✓`/`✗` and exiting non-zero on
  failure. Wire new files into the `test` script in `package.json`.
- **Tests must not touch real state.** `PATHS.db` and `PATHS.stop` honour
  `APPLY_BOT_DB` / `APPLY_BOT_STOP` env overrides. Use them. The rate ledger is
  the daily cap protecting the LinkedIn account; a test that clears it is a
  safety bug.
- **Browser fixtures via route interception**, not `file://`. See
  `scripts/ats-tests.mjs` — serve fixture HTML at the real vendor URL so vendor
  detection, navigation and frame resolution behave as they would live.
- **Every stage emits.** `emit({ jobId, stage, level, message })` writes to the
  `events` table and pushes over SSE. `emitBoard()` tells the dashboard to
  refetch. Levels: `info`, `warn`, `error`, `critical`.
- **New DB columns go through `addColumn()`** in `db.js` — `CREATE TABLE IF NOT
  EXISTS` will not alter an existing table.
- **Foreign keys are enforced.** Delete `events` and `parked_questions` before
  `jobs`.

### 0.4 Invariants — do not break these

1. **Park, never guess.** If a required question cannot be answered truthfully
   from the master profile, abandon the application and park it. This holds in
   `auto` mode. These answers go on real employment applications.
2. **`guardAnswer()` is the control, not the prompt.** Anything a model produces
   is re-checked deterministically: years-of-experience must trace to a
   `confirmed` `skills[].years` entry; work authorisation may never resolve from
   a model; credentials must appear in the profile.
3. **Unconfirmed profile values are invisible.** `confirmed: false` means the
   resolver behaves as if the field were absent.
4. **The generic adapter never auto-submits.** `GENERIC.requiresReview = true`.
5. **One browser stage at a time.** `server.js` holds a `running` flag. Two
   concurrent LinkedIn sessions on one account is the fastest way to get flagged.
6. **Any challenge halts everything** for the rest of the day and does not
   self-clear.
7. **Per-channel caps.** Only `linkedin_easy` carries LinkedIn ban risk.
8. **EEO / voluntary disclosure always declines.**

### 0.5 Hard-won gotchas

- LinkedIn's job pages use **server-driven UI with hashed class names**
  (`._7e3b9f11`) that change every deploy. Only ids of the form
  `JobDetails_AboutTheJob_<jobId>`, `data-sdui-component`, and `aria-label` are
  stable. Never write a class-based LinkedIn selector.
- Job cards are `data-occludable` — LinkedIn strips text from off-screen cards.
  Title and company are backfilled at enrich time from `document.title`.
- `resume.js`'s sha256 appears in **two** places in `index.html` (the `integrity`
  attribute and the CSP `script-src`). Run `node scripts/update-hashes.mjs`.
  Updating one silently blocks the script with no page error.
- Playwright is **1.61.1**. `getByRole`, `ariaSnapshot()`, `locator.all()` are
  available.
- `waitUntil: 'networkidle'` never fires on the dashboard — SSE holds a
  connection open. Use `domcontentloaded`.
- Headless Chromium downloads PDFs rather than rendering them. Use
  `scripts/render-pdf.mjs` to look at one.

### 0.6 Current schema

```
jobs(id, source, external_id, url, title, company, location, workplace_type,
     tier, search_keywords, posted_at, discovered_at, apply_type,
     external_apply_url, ats_vendor, apply_email, jd_text, fit_score,
     fit_rationale, reject_reason, parked_question, parked_at, status,
     resume_path, cover_letter_path, tailored_at, blocked_from)

applications(id, job_id, channel, resume_path, cover_letter_path, ats_vendor,
             adapter_used, submitted_at, confirmation_evidence, outcome,
             filled_json, screenshots_json, step_count)

answers(id, question_norm, question_raw, field_type, answer_value, scope,
        source, confidence, times_used, last_used_at, human_verified, created_at)

parked_questions(id, job_id, question_norm, question_raw, field_type,
                 options_json, reason, tier, created_at)

outbox(id, job_id, to_addr, cc_addr, subject, body, attachments_json,
       reference_number, created_at, send_after, sent_at, cancelled_at, status,
       error, gmail_message_id, gmail_thread_id, reply_state)

events, rate_ledger, settings, searches, blocked_companies
```

Job statuses in use: `new`, `discovered`, `enriched`, `scored`, `tailored`,
`awaiting_answers`, `awaiting_review`, `approved`, `outbox`, `submitted`,
`manual_required`, `rejected`, `expired`, `error`, `tailor_failed`,
`apply_failed`.

---

## Phase 7 — Generic accessibility-tree adapter

**Goal:** apply reliably to ATS platforms nobody has written an adapter for.

**Estimate:** 3 days.

### 7.1 Why the current generic adapter is not enough

`GENERIC` in `adapters/index.js` already exists and routes unknown forms through
`applyExternal()` with `requiresReview: true`. It reuses `collectFieldsInPage()`
from `fields.js`, which walks `input, select, textarea` and resolves labels.

That works for forms built from native controls. It fails on:

- **Custom controls** — `div[role="textbox"]`, `div[role="combobox"]`,
  `[contenteditable]`, listbox-based selects. Common in React/Vue career sites.
- **Shadow DOM.** `querySelectorAll` does not cross shadow boundaries, so a form
  inside a web component is invisible.
- **Labels that are not labels** — a heading or paragraph positioned above the
  control, associated only visually.
- **Multi-step wizards** on unknown platforms — the current external flow reads
  one page and stops.
- **Fields revealed conditionally** — "Do you need sponsorship?" → Yes reveals
  three more questions.

### 7.2 Design

Build a second collector alongside the existing one, not a replacement. The DOM
collector is faster and deterministic; use it first and fall back.

```
applyExternal()
  └─ collectFields(page, vendor)
       ├─ collectFieldsInPage()        # existing, native controls
       └─ if < 2 fields found, or vendor.a11y === true:
            collectA11yFields()        # new, phase 7
```

#### 7.2.1 Getting both a name and a usable locator

This is the crux. `page.accessibility.snapshot()` returns a tree with no element
handles, so you cannot fill anything from it. `locator.ariaSnapshot()` returns
YAML — good for LLM context, useless for filling.

**Approach: compute the accessible name in-page and tag the element.** This is
what `fields.js` already does with `data-bot-field`, extended to cover a11y
roles and shadow DOM.

New file `src/apply/a11y.js`:

```js
export const collectA11yInPage = (rootSelector) => {
  // 1. Deep query — pierce open shadow roots, which querySelectorAll will not.
  const deepQueryAll = (root, out = []) => {
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, out);
    }
    return out;
  };

  // 2. Implicit + explicit role.
  const roleOf = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', file: 'file',
               submit: 'button', button: 'button', range: 'slider',
               number: 'spinbutton' }[t] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return null;
  };

  // 3. Accessible name, in spec order (a practical subset of accname).
  const nameOf = el => {
    const byIds = ids => ids.split(/\s+/)
      .map(id => document.getElementById(id)?.innerText || '').join(' ').trim();

    if (el.getAttribute('aria-labelledby')) {
      const t = byIds(el.getAttribute('aria-labelledby'));
      if (t) return t;
    }
    if (el.getAttribute('aria-label')?.trim()) return el.getAttribute('aria-label').trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.innerText.trim()) return l.innerText.trim();
    }
    const wrap = el.closest('label');
    if (wrap?.innerText.trim()) return wrap.innerText.trim();
    if (el.title?.trim()) return el.title.trim();
    if (el.placeholder?.trim()) return el.placeholder.trim();

    // Visual-only labelling: nearest preceding text node in the same block.
    let n = el.parentElement;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      const cand = [...n.childNodes]
        .filter(c => c.nodeType === 1 && !c.contains(el))
        .map(c => c.innerText?.trim())
        .filter(t => t && t.length < 200);
      if (cand.length) return cand.at(-1);
    }
    return '';
  };

  // 4. Description — often carries the real constraint ("numbers only").
  const descOf = el => {
    const d = el.getAttribute('aria-describedby');
    return d ? d.split(/\s+/).map(id => document.getElementById(id)?.innerText || '')
                .join(' ').trim().slice(0, 200) : '';
  };

  // ... emit one node per control, tagging with data-bot-a11y=<uid>
};
```

Each returned node:

```jsonc
{
  "uid": "a11y-3f2a",              // selector is [data-bot-a11y="a11y-3f2a"]
  "role": "combobox",
  "name": "Are you legally authorised to work in South Africa?",
  "description": "",
  "required": true,
  "value": "",
  "options": ["Yes", "No"],        // for combobox/listbox/radiogroup
  "group": "Work eligibility",     // nearest fieldset legend / role=group name
  "disabled": false
}
```

Radio groups collapse to one node keyed on `name` attribute or the enclosing
`role="radiogroup"`, exactly as `fields.js` already does.

#### 7.2.2 LLM field mapping

Serialise nodes to compact JSON and send with the master profile. Constraints:

- **Cap the payload.** Truncate to ~6,000 characters of serialised form. If
  larger, chunk by `group` and make one call per chunk.
- **The model returns data, never actions.** Output is
  `{ "fills": [{ "uid": "...", "value": "..." }], "unanswerable": [{ "uid": "...", "why": "..." }] }`.
  The runner fills deterministically. This keeps the blast radius small and the
  whole thing auditable.
- **Route every value back through `guardAnswer()`** before filling. The mapping
  call is a convenience layer over the existing ladder, not a bypass of it.

Prefer the existing resolver where it can answer. Order per field:

1. `matchProfile()` — deterministic
2. answer bank exact, then fuzzy
3. LLM batch mapping (new — one call for the whole form rather than one per field)
4. park

The batch call is the phase 7 addition. Doing it per-field as today costs 15–20
LLM calls per form; batching cuts it to one or two and gives the model the whole
form as context, which measurably improves ambiguous fields.

#### 7.2.3 Multi-step support

Generalise the Easy Apply state machine (`linkedin-easy.js`) into a shared loop:

```js
// src/apply/wizard.js
export async function runWizard(page, { collect, resolve, fill, advance, isTerminal }, opts)
```

Advance detection, in order:
1. A button whose accessible name matches `/^(next|continue|save and continue|proceed)/i`
2. A button of type submit that is not the terminal submit
3. A progress indicator (`role="progressbar"`, `aria-valuenow`) that increments

Terminal detection: a button matching `/^(submit|send|apply|finish|complete)/i`.

Guard with `MAX_STEPS = 8` and a **no-progress detector** — if two consecutive
steps produce an identical field-uid set, the form is not advancing; abandon and
record why rather than looping.

#### 7.2.4 Conditional fields

After filling a step, re-collect before advancing. If the uid set changed,
resolve and fill the new fields too, up to 3 re-collection rounds per step. This
is how "Do you require sponsorship? → Yes" revealing three more questions gets
handled.

### 7.3 Prerequisite fix (do this first, it is small)

**Approved reviews do not currently teach the answer bank.** `POST /api/review`
with `action: 'approve'` sets `status = 'approved'` and nothing else. The
original design (`APPLY_BOT_PLAN.md` §3.7) says an approved LLM-drafted answer
should be written to `answers` with `source = 'llm_approved'`,
`human_verified = 1`.

Without this the answer bank only ever learns from questions that *parked*, so
review load never falls for questions the model answered plausibly. Fix in
`server.js`:

```js
if (action === 'approve') {
  const app = db.prepare(
    `SELECT filled_json FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1`).get(job.id);
  for (const f of JSON.parse(app?.filled_json || '[]')) {
    if (f.tier === 'llm' || f.probable) {
      saveAnswer({ question: f.question, value: f.value, fieldType: f.kind,
                   source: 'llm_approved', humanVerified: 1 });
    }
  }
  // ... existing status update
}
```

Do **not** persist `profile`-tier values — those are already deterministic and
would duplicate.

### 7.4 Files to create / change

| File | Change |
|---|---|
| `src/apply/a11y.js` | **new** — `collectA11yInPage`, role/name/description computation, shadow-DOM traversal |
| `src/apply/wizard.js` | **new** — shared multi-step loop with no-progress detection |
| `src/answer/resolver.js` | add `resolveFormBatch(nodes, ctx)` — one LLM call for a whole form, each value still through `guardAnswer()` |
| `src/apply/external.js` | fall back to a11y collection; use `runWizard` instead of single-page |
| `src/apply/linkedin-easy.js` | refactor onto `runWizard` (behaviour must not change — the existing integration test is the guard) |
| `src/apply/adapters/index.js` | add `a11y: true` to `GENERIC`; keep `requiresReview: true` |
| `src/server.js` | prerequisite fix in §7.3 |
| `scripts/a11y-tests.mjs` | **new** — see below |

### 7.5 Tests

`scripts/a11y-tests.mjs`, fixtures served via route interception:

**Name resolution**
- `aria-labelledby` beats `aria-label` beats `label[for]` beats wrapping label
- placeholder used only as a last resort
- visual-only label (a `<p>` above a `div[role=textbox]`) is found
- `aria-describedby` captured separately, not merged into the name

**Role detection**
- `div[role="textbox"]`, `[contenteditable]`, `div[role="combobox"]` with
  `role="option"` children, `role="radiogroup"`
- native controls still resolve identically to `collectFieldsInPage` (no
  regression)

**Shadow DOM**
- a form inside an open shadow root is found; nested shadow roots are traversed

**Batch mapping**
- a stubbed LLM returning a `fills` array produces the right DOM values
- a returned value that fails `guardAnswer()` parks instead of filling
- `unanswerable` entries park with the reason attached
- an option value not in the offered list parks rather than being forced

**Wizard**
- three-step form advances via "Continue" then "Submit"
- conditional field revealed after filling step 1 is collected and filled
- no-progress detector aborts a form whose Next button does nothing
- generic vendor never auto-submits even with `submit: true`

**Regression**
- `scripts/ats-tests.mjs` and `scripts/easyapply-integration.mjs` still pass
  unchanged after the `runWizard` refactor

### 7.6 Definition of done

- A custom fixture with shadow DOM, `div[role=textbox]`, a custom combobox and a
  conditional field fills end to end in review mode.
- All existing tests pass unmodified.
- One real long-tail application reaches `awaiting_review` with every field
  showing a source tier in the dashboard.

---

## Phase 8 — Scoring calibration against real outcomes

**Goal:** find out whether `THRESHOLD = 65` is right, and whether the fit score
predicts anything at all.

**Estimate:** 2 days of build, then weeks of accumulating data.

**Prerequisite: at least 40 submitted applications with recorded outcomes.**
Below that, do not change the threshold — see §8.5.

### 8.1 The problem

`THRESHOLD` was picked out of the air. `heuristicScore()`'s `worthScoring` gate
(`titleRelevant && hits.length >= 2`) was picked out of the air. Nobody knows
whether a fit score of 80 converts better than one of 66.

Worse, the failure is asymmetric and invisible: a threshold set too high
silently discards good jobs, and the only evidence is an empty pipeline that
looks like "not many jobs today".

### 8.2 Outcome capture

Three sources, in descending reliability:

1. **Email replies** — already implemented. `outbox.reply_state` is set to
   `replied` / `interview` / `rejected` by `checkReplies()`. Only covers the
   email channel.
2. **Manual marking** — the operator marks outcomes in the dashboard. Needed for
   Easy Apply and ATS, which return nothing.
3. **Inbox sweep (optional)** — extend the Gmail `readonly` scope already
   granted to search for messages mentioning the company name within 60 days of
   an application, and propose an outcome for confirmation. Do not auto-apply
   these; matching on company name alone is too loose.

Schema additions via `addColumn()`:

```js
addColumn('applications', 'outcome_state', 'TEXT');   // no_response|rejected|screen|interview|offer
addColumn('applications', 'outcome_at', 'TEXT');
addColumn('applications', 'outcome_source', 'TEXT');  // manual|email|inbox_sweep
addColumn('applications', 'outcome_note', 'TEXT');
```

`outcome_state` is deliberately ordinal — `no_response < rejected < screen <
interview < offer`. Treat "rejected after a human read it" as a better signal
than silence, because it means the application was at least parsed.

**Dashboard:** a "Sent" panel listing submitted applications older than 7 days
with no outcome, each with one-click buttons. Sort oldest first. Add an
`age_days` column so the operator can see what is going stale.

Auto-mark `no_response` after 45 days with `outcome_source = 'timeout'` — an
absence of a reply is data, and leaving it null biases every rate upward.

### 8.3 The calibration report

New `src/score/calibrate.js`, surfaced at `GET /api/calibration`:

```js
export function calibrationReport({ minSample = 8 } = {}) {
  // Buckets of 10 across fit_score, each with:
  //   n, response_rate, interview_rate, and a Wilson score interval
  // Plus breakdowns by tier, channel, ats_vendor, and search_keywords.
}
```

Report a **Wilson score interval**, not a bare percentage. With n = 9 and 2
responses, "22%" is meaningless on its own; the interval makes the uncertainty
visible and stops the operator over-reading noise.

Suppress any bucket with `n < minSample` rather than displaying a rate computed
from three data points.

Metrics worth having:

| Metric | Why |
|---|---|
| Response rate by fit-score decile | The core question — is the score predictive? |
| Response rate by tier (A/B/C/D) | Validates the role-targeting hypothesis, especially whether GTM Engineer (tier C) really does convert better |
| Response rate by channel | Easy Apply vs ATS vs email — likely the largest single effect |
| Response rate by ATS vendor | Detects a broken adapter submitting garbage |
| Parked rate by question | Which profile gaps cost the most volume |
| Time-to-response distribution | Sets the `no_response` timeout honestly |

### 8.4 Threshold sweep

Given labelled outcomes, sweep candidate thresholds and report, for each:

- applications that would have been sent
- responses that would have been captured
- responses missed (jobs below threshold that did respond — **false negatives,
  the expensive error**)
- response rate

Present it as a table, not a single recommended number. The right threshold
depends on how much daily budget is spare: if the caps are not being hit, a
lower threshold is free volume; if they are, a higher one raises quality.

**Do not auto-adjust `THRESHOLD`.** Show the table, let the operator set it in
the dashboard, and store it in `settings` so it is not a code change.

### 8.5 Statistical discipline

This is where a system like this most easily fools its owner.

- **Minimum n = 40 submitted applications with outcomes** before changing
  anything. Below that, differences between buckets are noise.
- **Minimum n = 8 per bucket** before displaying a rate.
- Expect a base response rate of **2–8%**. At 5% and n = 40, a single extra
  response moves the rate by 2.5 points. Do not chase that.
- **Do not re-tune after every batch.** Weekly at most.
- Beware the loop: the threshold determines what gets applied to, which
  determines the data used to set the threshold. Below-threshold jobs are never
  observed, so false negatives are structurally invisible. Fix with §8.6.

### 8.6 False-negative audit

Deliberately apply to a small random sample of **rejected** jobs — 1 in 20,
capped at 2 per day — and label the outcomes. Without this the calibration data
is censored and will drift upward forever, converging on a threshold that only
looks good because everything below it is unobserved.

Implement as a flag on `runScoring()`: with probability 0.05, a job scoring
between 40 and `THRESHOLD` is marked `status = 'scored'` with
`reject_reason = 'audit sample'`, and `applications.outcome_note` records that
it was one. Exclude audit-sample applications from the headline response rate;
report them separately.

### 8.7 Prompt improvement from labelled data

Once 20+ applications have outcomes, add few-shot examples to the scoring
prompt in `score/index.js`: three postings that got interviews, three that got
silence, each with title and a 200-character description excerpt. Cheap, and it
grounds the model in what actually converts for this candidate rather than
generic notions of fit.

Keep the examples in `settings` so they can be regenerated without a code change.

### 8.8 Files to create / change

| File | Change |
|---|---|
| `src/score/calibrate.js` | **new** — bucketing, Wilson intervals, threshold sweep |
| `src/db.js` | outcome columns, `pendingOutcomes()`, `setOutcome()`, `autoTimeoutOutcomes()` |
| `src/score/index.js` | read threshold from `settings`; audit sampling; optional few-shot block |
| `src/server.js` | `GET /api/calibration`, `POST /api/outcome`, `POST /api/threshold` |
| `dashboard/` | Sent panel with outcome buttons; calibration panel with bucket table |
| `scripts/calibration-tests.mjs` | **new** |

### 8.9 Tests

- Wilson interval matches known values (n=10 k=1 → roughly 0.018–0.404)
- Buckets below `minSample` are suppressed, not shown as 0%
- Threshold sweep counts false negatives correctly on a synthetic labelled set
- `autoTimeoutOutcomes()` marks only applications older than 45 days with no
  outcome, and sets `outcome_source = 'timeout'`
- Audit sampling fires at roughly the configured rate over 1,000 synthetic jobs
  and never samples a job below the floor score
- Setting a threshold in `settings` changes `runScoring` behaviour without a
  code change

### 8.10 Definition of done

- Calibration panel renders real buckets with intervals and honest suppression.
- Threshold is operator-settable from the dashboard.
- Audit sampling is running and its applications are excluded from headline
  rates.
- A written answer to: *does fit score predict response for this candidate?* —
  including "not enough data yet", which is a legitimate and likely outcome.

---

## Phase 9 — Workday (optional)

**Goal:** stop routing Workday postings to `manual_required`.

**Estimate:** 1 week.

**Decide before building.** Workday is currently deferred by design
(`DEFERRED` in `adapters/index.js`) and the operator clears those by hand in
about four minutes each. Check the real numbers first:

```sql
SELECT ats_vendor, COUNT(*) FROM jobs
WHERE status = 'manual_required' GROUP BY ats_vendor;
```

If Workday is fewer than ~3 per week, this is a week of work to save twelve
minutes. Build it only if the queue is genuinely outgrowing manual clearing.

### 9.1 What makes Workday hard

1. **An account per tenant.** Every company runs its own Workday instance at
   `<tenant>.wdN.myworkdayjobs.com`. Each needs a separate registration with
   email verification. This, not the form filling, is the actual work.
2. **A 5–7 page wizard**: My Information → My Experience → Application Questions
   → Voluntary Disclosures → Self Identify → Review → Submit.
3. **Aggressive session state.** Partially completed applications persist
   server-side and must be resumed rather than restarted.

The mercy: Workday exposes **`data-automation-id` on essentially every control**,
and those are stable across tenants and versions. Once written, the adapter is
unusually durable. This is the opposite of the LinkedIn situation.

### 9.2 Tenant account management

```js
addColumn/CREATE TABLE workday_tenants(
  tenant        TEXT PRIMARY KEY,   -- e.g. "acme.wd1"
  base_url      TEXT NOT NULL,
  email         TEXT NOT NULL,      -- mksiphugu+acme_wd1@gmail.com
  password_enc  TEXT NOT NULL,      -- AES-256-GCM, key in profile/
  verified_at   TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  state         TEXT NOT NULL       -- pending_verify|active|locked|failed
)
```

- **Plus-addressing.** `mksiphugu+<tenant>@gmail.com`. Gmail delivers to the
  same inbox, and the tenant is recoverable from the address. A handful of
  Workday tenants reject `+` in emails — detect the validation error and mark the
  tenant `failed` with a reason rather than retrying.
- **Passwords**: 24 random characters, encrypted at rest with a key in
  `profile/` (0600). Never logged, never returned to the dashboard, never in an
  event message.
- **Verification**: poll Gmail (the `readonly` scope is already granted) for a
  message to the plus-address within 10 minutes, extract the verification link,
  visit it. Fail the tenant after 3 attempts rather than looping.

### 9.3 Wizard adapter

`src/apply/adapters/workday.js`, built on `runWizard` from phase 7.

Stable `data-automation-id` values worth knowing (verify against a live tenant —
they do occasionally change):

| Purpose | Selector |
|---|---|
| Apply button | `[data-automation-id="adventureButton"]` |
| Autofill with resume | `[data-automation-id="autofillWithResume"]` |
| Apply manually | `[data-automation-id="applyManually"]` |
| Email field | `[data-automation-id="email"]` |
| Password | `[data-automation-id="password"]` |
| Verify password | `[data-automation-id="verifyPassword"]` |
| Create account | `[data-automation-id="createAccountSubmitButton"]` |
| Sign in | `[data-automation-id="signInSubmitButton"]` |
| File upload | `[data-automation-id="file-upload-input-ref"]` |
| Next / continue | `[data-automation-id="bottom-navigation-next-button"]` |
| Submit | `[data-automation-id="bottom-navigation-submit-button"]` |
| Error banner | `[data-automation-id="errorBanner"]` |
| Form field wrapper | `[data-automation-id="formField-<name>"]` |
| Dropdown option list | `[data-automation-id="promptOption"]` |

Two Workday-specific behaviours the generic filler will get wrong:

- **Dropdowns are not `<select>`.** They are button-plus-listbox. Click the
  control, wait for `[data-automation-id="promptOption"]`, click the option whose
  text matches. A `selectOption()` call will silently do nothing.
- **Date fields are three separate inputs** (month / day / year) with
  `[data-automation-id="dateSectionMonth-input"]` and siblings. Fill each.

### 9.4 Flow

```
1. Land on the posting → detect tenant from hostname
2. Tenant known and active?  → sign in
   Tenant unknown?           → register, verify by email, then sign in
3. Click Apply → prefer "Autofill with Resume" (uploads the tailored PDF and
   prefills Experience — a large time saving, and the reason phase 0's
   text-layer PDF work matters here)
4. Walk the wizard via runWizard()
5. Voluntary disclosures → decline everything (invariant 8)
6. Review page → screenshot every section
7. Submit in auto mode; abandon and queue for review otherwise
```

**Resumability.** Workday keeps partial applications. On re-entry, detect the
"continue where you left off" state and resume rather than restarting, or the
bot will accumulate duplicate drafts on the tenant account.

### 9.5 Risks

- **Account lockout** from repeated failed logins. Cap at 2 attempts per tenant
  per day, then mark `locked` and stop.
- **CAPTCHA on registration.** Some tenants enable it. Detect and route that
  tenant permanently to `manual_required` — do not attempt to solve it.
- **Duplicate applications.** Check the tenant account's "My Applications" page
  before applying; Workday will happily accept the same application twice and it
  looks careless to the employer.
- **Password reset emails** arriving unprompted mean something is wrong. Surface
  them as `warn` events.

### 9.6 Files

| File | Change |
|---|---|
| `src/apply/adapters/workday.js` | **new** — wizard adapter |
| `src/apply/workday/tenants.js` | **new** — registry, registration, encrypted password store |
| `src/apply/workday/verify.js` | **new** — Gmail verification-link extraction |
| `src/apply/adapters/index.js` | move `workday` out of `DEFERRED` into `VENDORS` |
| `src/db.js` | `workday_tenants` table |
| `dashboard/` | tenant list panel with state and last-login |
| `scripts/workday-tests.mjs` | **new** |

### 9.7 Tests

Fixtures reproducing Workday's markup with real `data-automation-id` attributes:

- Registration form fills and submits; plus-address is derived from the tenant
- A validation error rejecting `+` marks the tenant `failed` with a reason
- Verification-link extraction from a realistic Workday email body
- Custom dropdown: click → option list → select by text (assert `selectOption()`
  would *not* have worked, so the test documents why the code is shaped this way)
- Three-part date field fills correctly
- Wizard advances through all six pages
- Voluntary disclosures always decline
- Lockout: two failed logins mark the tenant `locked` and a third is not attempted
- Duplicate detection: an existing application for the same posting skips
- Passwords never appear in any emitted event or log line

### 9.8 Definition of done

- One real Workday application submitted end to end on a fresh tenant.
- Tenant credentials encrypted at rest and absent from all logs.
- Duplicate detection verified against a tenant that already has an application.
- Workday jobs no longer land in `manual_required` except on CAPTCHA.

---

### 9.9 Decision — not built (2026-07-22)

The spec says to check the queue before building. Checked:

```sql
SELECT ats_vendor, COUNT(*) FROM jobs WHERE status = 'manual_required' GROUP BY ats_vendor;
-- 0 rows
SELECT COUNT(*) FROM jobs
WHERE external_apply_url LIKE '%workday%' OR external_apply_url LIKE '%taleo%' OR external_apply_url LIKE '%icims%';
-- 0
SELECT COUNT(*) FROM applications;  -- 0
```

The `manual_required` queue is empty, no posting has ever resolved to a Workday
tenant, and nothing has been submitted through any channel yet. The threshold in
§9 is "fewer than ~3 per week"; the observed rate is zero, on a pipeline that has
not yet applied to anything.

So this would be a week of work — per-tenant registration, email verification,
encrypted credential storage, a 5–7 page wizard, duplicate detection, lockout
handling — to clear a queue that does not exist, and it would ship untested
against a real tenant because there is no real tenant to test against.

**Revisit when** the query above shows Workday consistently above ~3 per week.
Phase 7's `runWizard` was built to be the foundation for it, so the wizard half
of §9.3 is already done when that day comes; what remains is tenant account
management (§9.2), which was always the actual work.

The one thing carried forward: Workday, Taleo and iCIMS stay in `DEFERRED`, so
they route to `manual_required` with a reason rather than falling through to the
generic adapter — which, now that the accessibility collector exists, would
otherwise make a confident and wrong attempt at them.

---

## 10. Suggested order

1. **§7.3 prerequisite** — approved reviews teach the answer bank. Half a day,
   independently valuable, reduces review load immediately.
2. **Phase 8 outcome capture only** (§8.2) — the Sent panel and outcome columns.
   Ship this *early*, before phase 7, because calibration needs weeks of
   accumulated data and every day without it is a day of lost signal.
3. **Phase 7** — the a11y adapter.
4. **Phase 8 analysis** (§8.3–8.7) — once n ≥ 40.
5. **Phase 9** — only if the `manual_required` queue justifies it.

Phase 8's data collection is the long pole. Start it first even though the
analysis comes last.
