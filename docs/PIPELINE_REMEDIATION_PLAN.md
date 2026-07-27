# Apply-bot remediation plan

> **Status — 28 Jul 2026.** Shipped and merged to `main`: **PR-0, 0e, PR-1a,
> PR-2, PR-1b, PR-1c, PR-4a/4b/4c**, plus the skill-list cleanup. `npm test` green
> (17 suites). Measured on the 30-field audit form: **required parks 7 → 0**.
>
> Three items in this plan turned out to be wrong and were corrected while
> building — see "Corrections made while building" at the end.
>
> **Still outstanding: PR-1d (the planner), PR-3 (volume — the title gate and the
> ~294 recoverable jobs), PR-4d–4g (rate-limit correctness, adapters,
> bookkeeping).**
>
> **Generic auto-submit is OFF.** `allow_generic_autosubmit` defaults to off, so
> unrecognised forms are still filled and held. Turning it on is the switch that
> lets applications go to employers on forms nobody has vetted the shape of.



Companion to `PIPELINE_ASSESSMENT_2026-07-27.md`. Every item below traces to a
finding there. Ordered into shippable units; each unit is independently useful and
independently revertable.

**Sequencing principle:** stop the harm → make submission possible → make the fill
correct → recover volume → harden. Volume last on purpose: there is already a
43-job tailored backlog that cannot be submitted, so adding supply before fixing
conversion just grows the queue.

**Test discipline:** there are 16 network-free suites under `scripts/`, run by
`npm test`. Every unit below names the suite it extends. No unit ships without a
test that fails before the fix.

---

## PR-0 — Stop the harm (ship first, no behaviour risk)

Four independent bugs that are actively damaging the candidate's reputation right
now. None of them change control flow.

### 0a. Refuse to ship an untailored CV
**Finding:** 19 of 164 PDFs are text-identical; the only email ever sent carried a
generic CV.
**Where:** `tailor/optimiser.js:153` (`diffCount > 0` accepted), `:222` page check,
`:229` skills check.
**Do:**
- Extract the seed's text once (`SEED_RESUME`, `optimiser.js:13`), cache its
  normalised sha256.
- After export, hash the new PDF's text. If it equals the seed hash → delete the
  file and throw. A job must not reach `tailored` with the base CV.
- Assert `check.chars > 3000` (currently computed at `:238` and never asserted).
- Assert `box.h < 1.15 × A4px` — the current `box.h > 20000` guard plus
  `height: ${box.h}px` makes the one-page check structurally unfailable.
- Narrow `validateResumePdf`'s `skills` argument from all 188 profile keys to a
  hard technical subset (~12). Today `Remote`, `KPI`, `charts`, `collaborate` count
  toward the "5 skills found" threshold.
**Test:** extend `scripts/evidence-tests.mjs` (or a new `tailor-tests.mjs`) with a
fixture PDF identical to the seed → expect throw.

### 0b. Rename the MIME boundary
**Where:** `email/mime.js:32` — `----=_bot_<ts>_<rand>`.
**Do:** drop the literal `bot`. Use `----=_mime_<ts>_<rand>`. Also add `Date:`,
`Message-ID:` and `Reply-To:` headers while in the file.
**Test:** `scripts/email-tests.mjs` — assert the serialised message contains no
`/bot/i` and has a `Date:` header.

### 0c. Fix the email address regex
**Where:** `email/extract.js:23` — `[\w.]{2,}` TLD class swallows a sentence-final
period. 5 of 45 stored addresses (11%) end in `.` and will hard-bounce.
**Do:** `[\w-]+(\.[\w-]+)*\.[a-z]{2,}` plus a trailing-punctuation strip. Add a
role-address denylist (`dpo@`, `privacy@`, `legal@`, `noreply@`, `unsubscribe@`).
**Test:** `email-tests.mjs` with the 5 real failing strings as fixtures.

### 0d. Cap the auto-confirm loop
**Finding:** 188/188 skills are `confirmed: true`, 172 with no `source`. The
allowlist the optimiser may weave into the CV now includes `AWS`,
`machine learning`, `Data Scientist`.
**Where:** `optimiser.js:284` (seeds allowlist from confirmed), `:317` (confirms
whatever the evidence gate returns).
**Do:** require a non-null `source` on every auto-confirmed skill; exclude
`source: null` skills from the browser allowlist at `:284`; cap auto-confirms per
run. Then a one-off data repair: re-run `npm run audit` and clear `confirmed` on
everything with no evidence.
**Test:** `evidence-tests.mjs` — a skill confirmed with no source must not appear
in the allowlist.

### 0e. Data repair (no code)
- Verify `mksiphugu@gmail.com` on the LinkedIn account, **or** set
  `identity.email` to `ksiphugu@icloud.com`. Clears the #1 park (×10) at zero cost.
- Fill `identity.city`, `misc.hasDriversLicense`, `misc.startAvailability`, and add
  a numeric `compensation.expectedAnnual`.

---

## PR-1 — Make submission possible

The four blockers. This is the unit that turns 0 submissions into >0.

### 1a. B3 — let a tier-1 park fall through to the answer bank
**Where:** `answer/resolver.js:67-82`. `resolveDeterministic` returns the profile
tier's park immediately, so tiers 2 (`bank-exact`) and 3 (`bank-fuzzy`) are
unreachable whenever the profile produced a value that didn't fit the options.
**Do:** capture the tier-1 park in a local instead of returning it; try
`lookupExact` then `lookupFuzzy`; return the park only if both miss. ~6 lines.
**Why first:** it is the smallest change with the largest blast radius — it makes
every operator correction, past and future, actually take effect. The one row in
`answers` has `times_used: 0` after three days.
**Test:** `answer-tests.mjs` — profile value not in options + a bank row for that
question → expect the bank value, tier `bank-exact`.

### 1b. B2 — fill what resolved, park at the terminal
**Where:** `apply/wizard.js:62` returns `parked` before the fill loop runs.
**Do:** fill every `status: 'ok'` field first; accumulate parks; only abandon at the
step boundary, returning the partial `filled` list. Keep the invariant that a form
with any required park is never *submitted* — but stop discarding correct work.
**Consequence:** LinkedIn stops recording 0.0-field applications; review cards
become useful; operator corrections have something to correct.
**Test:** `apply-tests.mjs` — a form with 3 resolvable + 1 unresolvable required
field → expect 3 filled and outcome `parked`.

### 1c. B1 — make `requiresReview` overridable
**Where:** `adapters/index.js:81`, `apply/external.js:243`, `run.js:187-193`.
**Do:**
- Gate on `vendor.requiresReview && !operatorOverride`, where `operatorOverride` is
  `job.status === 'approved'` OR a new `allow_generic_autosubmit` setting.
- **Never demote an approved job back to `awaiting_review`.** If it genuinely cannot
  submit, set `manual_required` with a reason — do not loop.
- Emit `result.heldForReview` (built at `external.js:291`, currently never read) in
  the `Ready for review` message and store it in `outcome_note`.
**Risk:** this is the change that lets the bot submit to unknown vendors. Ship it
*after* PR-2 so the fill is correct first, and default the setting to off.
**Test:** `ats-tests.mjs` — approved + generic → submit intent survives to the wizard.

### 1d. B4 — repair the planner, then the confidence ramp
**Where:** `agent/plan.js:76,127,135`, `llm-anthropic.js:26`, `agent/index.js:84`,
`db.js:894`.
**Do, in order:**
1. Treat `kind: 'unsupported'` as a **soft** failure at `:127` — log at `warn`, fall
   through to the gpt-4o fallback at `:135`. Only return `unsupported` if both
   providers decline. (Observed live twice this run: Claude declined, fallback never
   ran.)
2. Raise `maxTokens` from 2000 to ~16000 and add an explicit
   `if (stop_reason === 'max_tokens') throw` — currently a truncated response falls
   into `JSON.parse` and surfaces as a bogus syntax error.
3. Rewrite the nullable `advance`/`submit` schema branches as `anyOf`, not
   `type: ['object','null']` with a contradictory `required`.
4. `bumpPlanSuccess` immediately after a successful `savePlan` (saves one visit).
5. Re-key plan reuse from the exact control fingerprint to **host-scoped**
   confidence. 17 captures produced 17 unique fingerprints; `accounts.google.com`
   alone produced three. The current key can never repeat.
**Test:** `agent-tests.mjs` — a `callClaudeFn` stub returning `unsupported` must
still invoke `callOpenAIFn`.

---

## PR-2 — Field mechanics: identification and answering

This is the unit that fixes "correct information in every field". Note that
identification is **entirely deterministic** — no LLM is involved — so most of this
is ordinary code.

### 2a. Never answer a question we could not read  ← highest correctness value
**Finding:** the 18-field Braun fill contains three fields whose *question text* is
literally `"Yes"`. Label resolution fell back to the control's own option text, and
the model then answered "Yes" to three questions nobody could read.
**Where:** `a11y.js` accessible-name resolution (the `NAME_FROM_CONTENT` path at
`:110`).
**Do:** if the resolved question is empty, or equals/appears in the field's own
`options`, or is under ~3 characters → mark the field `unreadable` and **park
unconditionally**, never send it to the resolver. This is a one-line guard in the
resolver plus a flag from the collector.
**Test:** `a11y-tests.mjs` fixture where a checkbox's only text is its own label.

### 2b. Treat `readOnly` as unfillable
**Where:** `a11y.js:157` — `disabledOf` checks `el.disabled` and `aria-disabled`,
not `el.readOnly` / `aria-readonly`.
**Effect today:** a 30s `locator.fill` timeout on a readonly input, which parks the
whole application (`fill-error`, 11 occurrences).
**Test:** `a11y-tests.mjs` — a `<input readonly>` must not be collected.

### 2c. Route the right *value* into option lists
**Where:** `answer/matchers.js` / `answer/options.js`.
**Do:**
- **Country-code selects:** detect them (options predominantly matching
  `/\(\+\d+\)/`) and feed `identity.country`, not `identity.phone`. Verified:
  `"South Africa"` matches `"South Africa (+27)"`; the raw phone can never match.
- **Email selects:** match on local-part/domain against `identity.email`, and prefer
  a real address over an Apple private-relay one.
- **Date controls:** `Availability / earliest start date` received `"30 days"`.
  Derive an ISO date from `authorization.noticePeriodDays` when the control is a
  date type.
**Test:** `answer-tests.mjs` — the three real option lists from `parked_questions`
as fixtures.

### 2d. Fix `extractSkill` and the years hijack
**Where:** `answer/matchers.js:137`, `resolver.js:172`.
**Do:**
- Map generic qualifiers (`relevant`, `full-time`, `professional`, `total`, `work`,
  `overall`) to `current.totalYearsExperience` instead of treating them as a skill
  noun. `"How many years of relevant full-time experience…"` currently extracts the
  junk noun `"relevant full-time"` and parks — it killed both Agoda jobs this run.
- Do **not** route a question to the years matcher when it has `Yes`/`No` options.
  `"Do you have 4–5 years of experience in digital marketing?"` is a boolean.
- Relax the strict equality at `resolver.js:176` (`String(total) !== v.trim()`) so
  `"3 years"` matches `3`.
**Test:** `answer-tests.mjs` — table of question → expected extraction.

### 2e. Make `guardAnswer` correct in both directions
**Where:** `resolver.js:167-207`.
- **Too strict:** `:188-192` — *both* branches return `ok: false`, so any work-auth
  question reaching the model is an automatic park even when the profile knows the
  answer. Make the known case resolve from the profile instead of rejecting.
  (Live: `"Are you a South African citizen?"` parked.)
- **Too loose:** `:198` only fires on exactly `yes`/`true` — *"Yes, I hold a valid
  licence"* bypasses the credential check entirely. Match affirmative prose.
- **Too loose:** `:202` accepts a credential if **any** word >4 chars from the
  question appears anywhere in the résumé. On a full CV that is nearly always true.
  Require the credential noun itself, not any long word.
- **Missing:** add guards for **location** and **salary**. The model invented
  `City → "Johannesburg"` in testing and `Current city → "South Africa"` in the live
  run; nothing checks either.
**Test:** `answer-tests.mjs` — one case per rule, both directions.

### 2f. Stop the LLM tier dropping fields  ← the actual LLM failure
**Finding:** 22 of 30 llm-tier parks are `model returned no answer for this field` —
the model omitted those uids entirely from its batch JSON. It dropped questions it
demonstrably knew (`"In which country do you currently work?"`).
**Where:** `answer/resolver.js:236-289` (`chunkFields`, `batchMap`), `llm.js:5`.
**Do:**
- Move the resolver off **`gpt-4o-mini`** to a stronger model for `batchMap`
  specifically. This is a small-model failure on long structured output.
- Add a **completeness retry**: after `batchMap`, any uid present in the chunk but
  absent from both `fills` and `unanswerable` gets one focused re-ask (that field
  alone) before parking. This alone should recover most of the 22.
- Lower `BATCH_CHAR_BUDGET` (6000) and raise `maxTokens` (2000) — the current pair
  plus 6000 chars of résumé and 2500 of JD invites truncation.
**Test:** `answer-tests.mjs` with a stub `callLLM` that omits a uid → expect the
retry, not a park.

### 2g. Loosen literal profile matching
**Finding:** `First name` resolves at tier `profile`; `Enter your first name` falls
through to the LLM. Real applications burn LLM calls on first/last name.
**Where:** `answer/matchers.js:13` MATCHERS.
**Do:** normalise away leading imperatives (`enter`, `please enter`, `type`,
`your`) before matching.
**Test:** `answer-tests.mjs` — the real labels seen in `filled_json`.

---

## PR-3 — Volume recovery (upstream gates)

≈294 recoverable applications currently sitting in `rejected`.

### 3a. The title gate — the single biggest leak
**Where:** `score/index.js:78,114`, `reject-criteria.js:84-90`.
**Finding:** 1188 of 2305 jobs were killed by a 12-term substring regex over the
**title only**, hard-set to score 0 with **no LLM call** — and then written to the
board as `reject_reason = 'fit 0 < 65'`, which makes an unjudged job look like a
considered rejection.
**Do:**
- Test `jd_text` as well as the title. `heuristicScore` already has the JD in hand.
- Add `\b` word boundaries (today `data` matches `Metadata`, `Data Entry Clerk`).
- Add the missing families: `media buyer|ppc|seo|sem|crm|lifecycle|acquisition|
  demand gen|performance|business intelligence|insights|reporting|google ads|social`.
- Write an honest reason: `'title gate: outside role families'`, never `fit 0 < 65`.
**Recovers:** ~120 on-target titles, 64 with GA4/Ads/BI in the JD.

### 3b. Anchor `lead`
**Where:** `config.js:91`, `reject-criteria.js:77-81`.
`\blead\b` kills `Lead Generation Analyst`, `Growth Lead`, `CRO Lead`. Use
`^lead\b|\blead$|\bteam lead\b|\btech lead\b` with a negative lookahead for
`lead generation`. Also reconsider `f_E: '2,3,4'` at `linkedin.js:31` — the search
asks LinkedIn for mid-senior roles and then rejects 473 locally.
**Recovers:** ~73.

### 3c. Validate `blockers[]`
**Where:** `score/index.js:175-181`. This is raw, unvalidated LLM free text used as
an unappealable hard reject — *not* the `AUTH_BLOCKERS` regex list.
**Do:** drop `/^(none|n\/a|-)?$/i` (3 jobs were rejected with the literal reason
`blocker: None`); require an enum `auth|language|location|credential|experience` in
the JSON schema; hard-reject only on `auth`/`language`; route `credential` and
`experience` to review at their real score. **Pass `identity.city/country` into the
scoring prompt** — 9 jobs were rejected for being on-site in the candidate's own
country because the prompt never says where they live.
**Recovers:** ~42.

### 3d. Threshold and calibration
Drop 65 → 55 (`score/index.js:8`). Of 613 real scores the 50-59 bucket holds 8 and
60-69 holds 88 — the cut runs through the densest band, rejecting 55 jobs at 60-64.
Lower `AUDIT.floor` to 0 so the sampler can see the 1188 title-gate zeros it is
currently blind to. **Recovers:** ~55.

### 3e. `apply_type='unknown'`
4 tailored jobs at avg fit 76 (incl. one at 85) have a finished PDF and **no code
path that will ever send it** — `run.js:89` selects only `easy_apply|external`,
`outbox.js:149` only `email`. Meanwhile `runTailoring` (`optimiser.js:293`) has no
`apply_type` filter, so it spends a browser session and an LLM pass on them anyway.
**Do:** filter `runTailoring`; let `run.js` accept `unknown` and fall through to
`resolveExternalUrl`; add a re-enrich pass that re-runs `classifyApply`.

---

## PR-4 — Safety, dedupe and hygiene

### 4a. Duplicate applications  ← happening now
Jobs 2462 and 2463 resolved to the **same** `jobs.micro1.ai` URL and both filled.
No dedupe on resolved apply URL, company, or email recipient. `queueEmail`
(`db.js:512`) is a bare INSERT.
**Do:** unique-ish guard on `external_apply_url` and on `outbox.to_addr` per
company; skip with a logged reason.

### 4b. Never `throw` after clicking submit
**Where:** `external.js:302-306`. Today an unconfirmed submit throws →
`apply_failed` → re-selected next cycle → **the form is submitted again**. Also
`page.locator('body').innerText()` reads the main frame only, so iframe-hosted
confirmations are missed.
**Do:** search all frames; return a terminal `submitted_unconfirmed` state that
escalates to a human rather than retrying. Screenshot in `execute.js` before
returning (the one path allowed to auto-submit currently captures no evidence).

### 4c. Login-wall guard
`accounts.google.com` is the most-captured "form" in the database, and this run the
bot tried to fill a Google sign-in page for TalentPop.
**Do:** if the host is an identity provider or the form contains a password field →
`manual_required` immediately. No fill, no agent escalation, no retry burn.

### 4d. Rate-limit correctness
- `external.js:130` debits `linkedin_pageviews` but `rate.js:49` only enforces it
  for `linkedin*` channels — external burned 247/250 while `linkedin_easy` used 0.
  Either charge external to its own counter or gate it.
- `linkedin-easy.js` never bumps pageviews at all — real LinkedIn browsing is
  undercounted.
- `rate.js:31` halts **all** channels on `challenges_hit` including email. Scope to
  LinkedIn. Use `isVisible()` in `browser.js:190` (`page.$()` matches hidden nodes).
- `db.js:137` `today()` is UTC while `withinHours()` is SAST — caps roll at 02:00
  SAST. Pick one timezone.

### 4e. Adapters
`ats:greenhouse` fills **only the CV attachment** across 8 applications — no name,
no email. Fix that adapter before registering new ones. Then register the
unregistered vendors seen in captures: `oraclecloud.com`, `app.recruitis.io`
(11 controls), `recruitcrm.io`, `uttr.catsone.com`, `meltwatercareers.ttcportals.com`,
`belong.advania.co.uk` (20 controls, reported as "no fillable fields").

### 4f. Bookkeeping
- `applications.outcome`: `blocked` conflates "filled, awaiting review" (24) with
  "vendor unsupported" (6). Widen the enum; populate `outcome_note`.
- `run.js:128` increments `apply_attempts` before the `try`, and the
  `ChallengeDetected` branch never rolls it back. 6 jobs sit at 3 attempts,
  permanently invisible. Add a terminal `apply_exhausted` status.
- Don't spend retries on deterministic failures — `No application form found` will
  fail identically on attempts 2 and 3.
- `tailored_at` (`db.js:107`) is written by nothing; all 37 rows NULL. Write it.
- `outputName` (`optimiser.js:35`) truncates to 40 chars — 190 rows map to 159
  paths, so one job's PDF overwrites another's. Append `job.id`.
- `applySecretsToEnv()` is called only from `server.js:29`, so every `npm run` CLI
  stage runs keyless and silently degrades. Call it in `cli.js`.

### 4g. Decide on the referees
The CV broadcasts four named people's personal mobile numbers and emails to every
employer automatically. That is a deliberate choice to make, not a default.

---

## What I'd ship, in what order

| unit | unlocks | risk |
|---|---|---|
| **PR-0 + 0e** | stops reputational damage; clears the #1 park | none |
| **PR-1a** | operator corrections finally work | very low |
| **PR-2a, 2b, 2c, 2d** | correct fills; kills the top 4 park causes | low |
| **PR-2f** | recovers ~22 dropped-field parks | low |
| **PR-1b** | partial fills; LinkedIn stops scoring 0.0 | medium |
| **PR-1c** | **first real submissions** | high — gate behind a setting |
| **PR-4a, 4b, 4c** | prevents duplicates/spam once volume rises | low |
| **PR-3a–3e** | ~294 recoverable jobs | medium |
| **PR-1d** | the adaptive agent starts learning | medium |
| **PR-4d–4g** | hygiene | low |

**Keep the autonomous loop off until PR-0 and PR-2a are merged.** It currently fills
live vendor forms with an 11.6% chance of the wrong CV and can answer "Yes" to
questions it cannot read.

---

## Corrections made while building (27 Jul 2026)

Two items in this plan were wrong. Both were caught by checking the fix against
real artefacts rather than against the tests, which is the only reason they were
caught at all — the tests passed in both cases.

### 0a — "compare the export against the seed PDF" would have caught nothing

The plan said to hash the seed résumé's text and refuse any export that matches.
Implemented and unit-tested green. Then, checked against the 164 real PDFs:

```
seed PDF text hash ............ dc7cb603…
the 14 duplicate exports ...... 4532b3dd…   ← all identical to EACH OTHER
```

The optimiser loads the seed and **re-renders it into its own template**, so an
untailored export never matches the seed file's text layer — it matches the other
untailored exports. The guard would have been silent on the exact failure it was
written for.

**Corrected to:** read `#resume-content` (the element the PDF is printed from)
before and after optimisation and compare the document against *itself*. That
catches every route to an untailored export, including the one the plan missed —
diffs that exist but are all withheld by the fabrication guard, where `diffCount`
is non-zero and nothing is applied. Verified: the two known duplicates are
identical under this comparison (guard fires), a genuinely tailored CV is not
(guard silent).

### 0d — "exclude source-less skills from the allowlist" would have broken tailoring

The plan assumed skills without a `source` were the auto-confirmed junk. They are
not. The 172 source-less entries contain **both** the genuine core — `SQL`,
`Python`, `Google Tag Manager`, `Looker Studio`, `Tableau`, `DV360`,
`programmatic` — **and** the junk — `AWS`, `Bachelor's degree`, `Remote`,
`WordPress`. They are simply the entries that predate the `source` field.
Excluding them would have stopped the optimiser using the candidate's real skills.

**Corrected to:** cap auto-confirmation at 5 per job and require evidence, which
stops the list growing unattended without touching existing data. Clearing the
junk that is already there is a data decision for the operator — `npm run audit`
reports exactly which confirmed skills the CVs cannot support. **Not done.**

### One further bug found during implementation, not in the original plan

`matchProfile` compared ASCII patterns against raw form text, so
`Do you have a valid driver’s licence?` (U+2019, as typed by every word processor)
did not match `/driver'?s? licen[sc]e/`. The question fell through to the model,
which correctly declined to assert a licence — so a fact the profile knew was
never used. Fixed by folding curly quotes, dashes and non-breaking spaces before
matching (`normalisePunctuation`). This class of miss is likely to affect other
matchers on real ATS copy.

Also corrected: the plan implied nothing connected "when can you start" to the
notice period. A matcher already did; its pattern read `availability to start`
while the live form said `available to start`. Widened rather than duplicated —
and the answer deliberately stays the bare `30 days`, because that is what the
duration rule fits onto a `1 month` dropdown. Prose would fit nothing.

---

## What shipped

| item | file(s) | verified by |
|---|---|---|
| 0a untailored-CV guard | `tailor/optimiser.js` | real-artefact check + `tailor-tests.mjs` |
| 0a single-page ratio | `tailor/optimiser.js` | measured 40 exports (675px wide, ratio 1.22–1.33) → limit 1.8 |
| 0a min text length | `tailor/optimiser.js` | `MIN_RESUME_CHARS = 3000` vs real 8100–9100 |
| 0a curated skill check | `scripts/extract-text.mjs` | `tailor-tests.mjs` — old list certifies junk, new one rejects it |
| 0b MIME boundary + headers | `email/mime.js` | `email-tests.mjs` — no `/bot/i`, Date/Message-ID/Reply-To present |
| 0c address regex + role denylist | `email/extract.js` | `email-tests.mjs` — the 5 real trailing-dot addresses |
| 0c cc-leak on corrected recipient | `email/extract.js` | rebuilt from the deterministic scan |
| 0d auto-confirm cap | `tailor/optimiser.js` | `MAX_AUTO_CONFIRMS_PER_JOB = 5`, evidence required |
| 0e profile facts | `master-profile.json` | licence, availability, salary set (city outstanding) |
| 0e gaps can't hide | `profile.js` | `unconfirmed()` + `editableGaps()` now cover city/licence/availability/salary |
| **1a tier fall-through** | `answer/resolver.js` | `answer-tests.mjs` + live: email resolves `bank-exact` |
| punctuation folding | `answer/matchers.js` | `answer-tests.mjs` |
| salary numeric control | `answer/matchers.js` | `answer-tests.mjs` |
| availability phrasings | `answer/matchers.js` | `answer-tests.mjs` |
| stale 24/7 hours tests | `scripts/apply-tests.mjs` | pre-existing failures, unrelated to this work |

## Immediate follow-ups

1. **`identity.city` is still empty** — the one gap that caused a fabricated value
   (`Current city → "South Africa"` on a live application). Nothing else can supply it.
2. **41 jobs sit in `awaiting_answers`, 16 of them blocked on the email question
   this fix now answers.** `releaseAnswered('email address')` frees them — but it
   returns them to `scored`, so they re-tailor. That is a deliberate burst of
   optimiser work; run it when you want to spend it, ideally after PR-2 so more
   parked questions clear in the same pass.
3. **Clear the poisoned skill list** — `npm run audit`, then unconfirm what the CVs
   cannot support.
