# Apply-bot 3-day continuous run — log review, 1 August 2026

Window reviewed: **2026-07-28T18:11Z → 2026-07-31T22:13Z** (9,465 events, 4,377 jobs,
285 application attempts). Mode `auto`, agent enabled, `allow_generic_autosubmit=1`.
Loop still live at time of writing (`node src/cli.js serve`, PID 32929; watcher PID 10631).

Sources: `data/pipeline.sqlite` (`events`, `jobs`, `applications`, `rate_ledger`,
`outbox`, `page_captures`), `artifacts/logs/submissions-watch.log`,
`artifacts/submissions/*.json`, `profile/google-token.json`.

---

## 1. Headline

**The bot is spending its entire LinkedIn safety budget on *finding* jobs and has
almost none left for *applying* to them.**

Three full days, 29–31 July:

| | |
|---|---|
| Discovery runs | 143 (~300 cards seen each) |
| Jobs discovered | 1,844 |
| Rejected at score/enrich | 1,476 (80%) |
| Tailored | 158 |
| **Submitted** | **8** |

Per-channel, from `rate_ledger` — cap in brackets:

| date | `linkedin_easy` | `external_ats` | `email` | `linkedin_pageviews` |
|---|---|---|---|---|
| 2026-07-29 | 3 (15) | 4 (1000) | **0** (300) | **250 / 250** |
| 2026-07-30 | 4 (15) | 1 (1000) | **0** (300) | **250 / 250** |
| 2026-07-31 | 2 (15) | 0 (1000) | **0** (300) | **250 / 250** |

The pageview budget is exhausted every single day. The two channels it is
supposed to protect run at **20% and 0.2% of their caps**. Meanwhile 79 jobs sit
in `tailored` — 66 of them `external`, which carries no LinkedIn ban risk at all —
averaging 23.5 hours old, oldest 77 hours.

The system is not failing to find work. It is failing to *deliver* work it has
already paid to prepare.

---

## 2. Defects, ranked

### P0-1 — Discovery starves apply of the LinkedIn pageview budget

`discover` re-runs the **full search set on every 15-minute orchestrator cycle**.
157 `Searching …` pageviews on 31 July alone (289 on the 29th), plus ~90 more from
the `enrich` signed-in browser fallback (`discover/linkedin.js:390`). Cap reached at
**10:26 UTC on 31 July** — before midday — after which:

* 44 further `discover` runs aborted with `LinkedIn pageview cap (250) reached`
* `apply` logged `Holding linkedin_easy: LinkedIn pageview budget exhausted` × 20
* `external_ats` was gated even earlier, at `EXTERNAL_PAGEVIEW_SHARE = 0.6` → 150
  pageviews (`apply/rate.js:73`) — so the highest-capacity, zero-risk channel was
  shut off for roughly two-thirds of every day.

The spend buys very little. `Discovery complete — 362 cards seen, 39 new kept` is
the typical line: **~43,000 card-views across 3 days to keep 1,844 jobs.** The
overwhelming majority of every search page is postings already in the database.

**Fix**

1. **Reserve, don't share.** `capRemaining` should hold a hard floor of the pageview
   budget for `apply` (e.g. 80 of 250) that `discover`/`enrich` cannot touch, instead
   of first-come-first-served. The current 60% share for external is a ceiling on
   external, not a floor for anything.
2. **Decouple discovery cadence from the loop cadence.** `PIPELINE` in
   `orchestrator.js:26` runs all seven stages every cycle. Give `discover` its own
   interval (2–3 h), or skip any search whose last run was under N hours ago.
3. **Rotate the search set.** Run a slice of the ~26 searches per cycle rather than
   all of them; the tier-A searches deserve more frequency than tier-C.

Expected effect: enough reserved budget for 15/15 Easy Apply and an uncapped
external channel, from the same 250 pageviews.

---

### P0-2 — The apply stage lies about why it did nothing, which hid P0-1

`src/apply/run.js:114-142`. When `canApply()` fails for every channel, `activeTypes`
is empty, `typeList` becomes `'NULL'`, the query matches only `status='approved'`
rows, and the stage emits:

> `No jobs ready to apply to — tailor some first`

**44 of 54 apply runs on 31 July emitted this line while 79 tailored jobs were
waiting.** The message names the one thing that was not the problem, and the real
reason (budget exhausted) is only visible in a separate warn.

**Fix:** branch on `activeTypes.length === 0` before running the query and emit the
actual gate reason returned by `canApply` for each channel. Two lines of code; it
would have made this whole investigation a five-minute read.

---

### P0-3 — Gmail has been disconnected since 29 July; 146 identical failures

First failure `2026-07-29T08:48:12Z`, last `2026-07-31T22:13:35Z`, **146 occurrences**
(144 in `replies`, 2 in `email`), all `invalid_grant`.

Cause is in `profile/google-token.json`:

```
refresh_token_expires_in: 14935   # 4.1 hours
```

A refresh token with a bounded lifetime is what Google issues when the OAuth
consent screen is still in **Testing** publishing status. The token was minted
29 July 02:33 SAST and died ~4 hours later. Re-running `npm run gmail:auth` will
work for another four hours and then break again.

Two consequences, and the second is worse than the first:

* **The email channel is dead.** 0 sends in 3 days against a cap of 300; 2 `outbox`
  rows in `failed`; drafts piling up in `artifacts/emails/`.
* **Outcome tracking is dead.** `replies` is the only loop that learns whether
  anything worked. It has run 144 times since 29 July and read nothing. Every
  employer reply in that window is unseen, and the `reply_state` column is stale.

**Fix**

1. Set the Google Cloud OAuth consent screen for this project to **Production**
   (Testing → Publish app). Then re-run `npm run gmail:auth` once. Refresh tokens
   then persist until explicitly revoked.
2. `src/email/gmail.js` currently has no handler for `invalid_grant` — it re-threw
   the same error 146 times. It should detect that specific code, mark Gmail
   disconnected in `settings`, emit **one** actionable alert per day
   (`Gmail disconnected — run: npm run gmail:auth`), and skip the stage instead of
   re-failing it every cycle.

---

### P0-4 — Anthropic spend limit hit; the pre-send safety review silently degraded

20 events carry:

```
Claude 400: "You have reached your specified API usage limits.
             You will regain access on 2026-08-01 at 00:00 UTC."
```

* 16 × `Claude planner failed … falling back to gpt-4o` — acceptable degradation.
* 4 × `Pre-send review could not run … deterministic checks only` — **not**
  acceptable. That is the gate that inspects what is about to be sent to an
  employer, and it downgraded itself without holding anything back.

**Fix**

1. Raise or remove the workspace spend limit, and alert on approaching it rather
   than discovering it in a 400.
2. Treat a spend-limit 400 in the **pre-send review** as a *hold*, not a soft
   degrade: park the application for the next cycle rather than sending under
   deterministic checks only. The planner fallback to gpt-4o is fine as-is.

---

### P1-5 — `looksLikeSelector` rejects ordinary placeholder text (and misses real selectors)

`src/apply/agent/plan.js:79`:

```js
const looksLikeSelector = v =>
  /^[.#\[]/.test(v) || /_[0-9a-f]{6,}\b/i.test(v) || /[.#>]{1}[\w-]{2,}/.test(v);
```

The third alternative matches **any string containing a `.` followed by two word
characters**. Verified behaviour:

| value | verdict | correct? |
|---|---|---|
| `Click to upload or drag & drop (.pdf)` | rejected | ✗ false positive |
| `you@email.com` | rejected | ✗ false positive |
| `Upload your CV (max 5MB, .doc or .docx)` | rejected | ✗ false positive |
| `LinkedIn URL (linkedin.com/in/...)` | rejected | ✗ false positive |
| `._7e3b9f11` | rejected | ✓ |
| `div > input` | **accepted** | ✗ false negative — a real CSS selector |

11 logged plan rejections, several on both planners in sequence
(`Claude plan rejected … falling back to gpt-4o` → `gpt-4o plan rejected`), so the
page ended up unsolved and captured. Any upload control whose visible label names a
file extension is currently unplannable — and upload controls are exactly the ones
that matter.

**Fix:** test whether the *whole* value is a selector, not whether it contains a
dot. Something like:

```js
const looksLikeSelector = v =>
  /^[.#\[]/.test(v) ||
  /_[0-9a-f]{6,}\b/i.test(v) ||
  /^[a-z][\w-]*\s*[>+~]\s*[a-z][\w-]*/i.test(v) ||   // real combinators
  /^[a-z]*[.#][\w-]+$/i.test(v);                      // whole string is tag.class
```

Add the six rows above as fixtures in `scripts/agent-tests.mjs`.

---

### P1-6 — 20% of tailoring produces nothing new, and those jobs die permanently

51 `tailor` errors:

| kind | count |
|---|---|
| `Optimisation changed nothing …` | 37 |
| `The exported CV is identical to the one tailored for job #N` | 12 |
| other | 2 |

**The guards themselves are correct and should stay** — they are catching a real
optimiser problem (`optimiser.js:260` and `:376`), not creating one. The defect is
what happens next: `tailor_failed` is a **terminal state**. All 76 jobs in it have
exactly `1` error event, the newest dated 29 July. Nothing ever re-selects them.

**Fix**

1. Make `tailor_failed` retryable on a bounded counter, the way `apply_failed`
   already is (`run.js:129`), with a varied seed so the second attempt is not
   deterministically identical to the first.
2. Investigate the no-op itself. Most likely cause given the code path: "Accept All"
   deliberately excludes diffs the fabrication guard flagged (`optimiser.js:239-242`),
   so a JD whose every suggestion trips the guard applies zero diffs and completes
   "successfully" having changed nothing. Log `diffCount` vs. applied count on the
   failure so this is visible.

---

### P1-7 — `links.portfolio` is empty, costing 19 applications

19 jobs went to `manual_required` with:

> `the posting asks for a portfolio or work samples, and links.portfolio is empty in the profile`

`profile/master-profile.json:26` → `"portfolio": ""`.

**Fix:** fill the field. This is one edit and recovers 19 stranded jobs — the best
effort-to-recovery ratio in this report. If there is genuinely no portfolio URL, a
GitHub or LinkedIn featured-section link is better than a hard block.

---

### P2-8 — Easy Apply wizard stalls

| symptom | count |
|---|---|
| `form did not advance past step N — the same fields came back` | 25 |
| `step 1 has no next, review or submit control` | 16 |
| `No apply button after 10s` | 8 |
| `Clicked submit but saw no confirmation` | 2 |

The step-1 variant dominates. `data/agent-snapshots/` already holds 64 captures —
these need to be read against the failures rather than accumulating. Recommend
dumping the accessibility tree at the stuck step and diffing it against a known-good
step 1 before touching selectors.

### P2-9 — Typeahead comboboxes are filled instead of selected

5 abandonments from `parked: City (could not apply "Pretoria": locator.fill: Timeout 30000ms exceeded)`.
`fill` never resolves on a listbox-backed combobox. Needs type-then-pick-option.
Also a throughput cost: 30 s burned per occurrence.

### P2-10 — Network timeouts

`page.goto` 30 s timeout × 9 (7 apply, 2 discover), `locator.click` 30 s × 12,
3 × `net::ERR_ABORTED`, 1 × `getaddrinfo ENOTFOUND oauth2.googleapis.com`,
1 × `LLM call failed: fetch failed`. Individually transient; collectively ~10
minutes of wall-clock a day. Worth one retry with `waitUntil: 'commit'` before
recording a failure.

### P2-11 — The human queue has never been drained

| queue | pending |
|---|---|
| `skill_suggestions` | **124** |
| `parked_questions` | 18 |
| `jobs.awaiting_answers` | 10 |
| `jobs.awaiting_review` | 7 |
| `page_captures` (unsolved pages) | 62 |

Each parked question blocks exactly one application. The captures cluster usefully:
`www.linkedin.com` 17, `jobs.micro1.ai` 13 — micro1 alone is 13 applications behind
one unwritten adapter.

Also worth noting: 6 jobs went to `manual_required` because the apply link lands on
`accounts.google.com`. Those are Google Forms postings; a sign-in wall is a correct
give-up, but they should be routed to a distinct state so they are not re-tried.

---

## 3. Performance

Beyond the budget starvation in P0-1:

* **Cycle design.** `orchestrator.js:26` runs all seven stages every 15 minutes.
  `discover` and `enrich` are expensive and slow-changing; `apply` and `email` are
  cheap and time-sensitive. Split them onto separate cadences.
* **Discovery yield.** ~300 cards seen per run to keep ~40. The bot has no memory of
  which search/page combinations were already fully harvested. Tracking the newest
  `external_id` seen per search and stopping the scroll when it recurs would cut the
  card volume by most of its current value at no loss.
* **Latency.** Discovered → tailored averages **17.3 hours** (max 156 h). Tailored →
  applied is currently unbounded — the backlog averages 23.5 h and tops out at 77 h.
  Meanwhile 107 jobs reached `expired` (91 × "no longer accepting applications").
  Postings are closing while their CVs sit on disk.
* **Rejection cost.** 3,733 rejections, led by `fit 0 < 65` (1,170),
  `off-target: no role-family term` (898) and `seniority: above band` (805). These
  land at enrich over cheap guest fetches (641/day), so they are not burning the
  ban budget — but 898 off-target rejections are decidable from the card title
  alone, at discovery, before any fetch at all.

---

## 4. Recommended order of work

**Today — restores throughput, ~1 hour of work**

1. Publish the Google OAuth consent screen to Production, re-run `npm run gmail:auth`.
   *(Unblocks the email channel and, more importantly, reply tracking.)*
2. Fill `links.portfolio` in `profile/master-profile.json`. *(19 jobs.)*
3. Raise the Anthropic spend limit; confirm it cleared at 2026-08-01T00:00Z.
4. Fix the `No jobs ready to apply to` message to report the real gate.

**This week — the actual bottleneck**

5. Reserve a pageview floor for `apply`; give `discover` its own longer interval.
6. Fix `looksLikeSelector`; add the six fixtures.
7. Make `tailor_failed` retryable; log `diffCount` on the no-op path.
8. Add `invalid_grant` handling to `gmail.js` (one alert/day, not 146 errors).
9. Hold rather than degrade the pre-send review on a spend-limit 400.

**Next — quality**

10. Drain the 124 skill suggestions and 18 parked questions.
11. Write the micro1 adapter (13 captures).
12. Type-then-select for comboboxes; retry-once on `page.goto` timeouts.
13. Move role-family filtering to the discovery card.

---

## 5. What is working

Worth stating, because it is a change from the 27 July assessment: **submissions are
happening.** 21 recorded in `artifacts/submissions/`, 15 jobs in `submitted`,
10 across the 29–31 July window. The four blockers in `PIPELINE_ASSESSMENT_2026-07-27.md`
are cleared — nothing in these logs shows generic forms structurally unable to submit,
or one parked field aborting a whole form. Scoring, enrichment (`jd_instructions` and
closing-date prioritisation), the fabrication guard, and the duplicate-CV guard are
all doing their jobs and doing them visibly.

The problem now is throughput, not capability.
