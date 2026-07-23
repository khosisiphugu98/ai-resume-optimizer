# apply-bot

Autonomous job application pipeline. Full design: [`../docs/APPLY_BOT_PLAN.md`](../docs/APPLY_BOT_PLAN.md).

**Phase 6 (current):** all three channels — LinkedIn Easy Apply, five external ATS
platforms, and email — with a review queue and an outbox. Ships in **observe**
mode; it applies to nothing until you switch it.

## First run

```bash
cd apply-bot
npm install
npx playwright install chromium

cp profile.example.json profile/master-profile.json   # already seeded for Khosi
npm run profile    # list what still needs confirming — do this first
export OPENAI_API_KEY=sk-...                          # optional; scoring degrades without it

npm run login      # log in to LinkedIn by hand, once — 2FA included
npm run check      # confirm the session stuck
npm run run        # dashboard + one discover/enrich pass
npm run score      # fit-score everything enriched
```

### Confirm the profile before anything else

`npm run profile` lists every unconfirmed field. **Unconfirmed values are ignored** —
any application asking about one parks instead of using it. The years figures in the
seeded profile were read off your CV timeline; they are suggestions, not facts, and
they end up on real employment applications. Set `confirmed: true` only where the
number is yours.

Fully confirming the profile is the single biggest lever on how much runs
autonomously.

Dashboard → http://localhost:5175

You log in yourself in a persistent Chrome profile (`data/chrome-profile`). The bot
never sees your password and never handles 2FA.

### Settings

The gear in the control bar opens everything that is configured once: the OpenAI
key, Gmail, profile status and the daily caps. It carries a small amber dot while
something it owns is unset, and is otherwise silent.

Secrets are written to `profile/` at mode 600 and gitignored. Neither the API nor
the dashboard ever reads a key back — only whether one is set and its last four
characters. The server binds to `127.0.0.1` only: it has no authentication
because it is not meant to be reachable from anywhere but this machine.

### The browser profile has one owner

A Chrome profile takes exactly one browser at a time. A crashed run or a stray
script leaves one behind, and a second launch does not queue — it fails with
`Opening in existing browser session`.

So the dashboard treats itself as the owner: it clears any leftover browser on
startup, and again before launching one. If you see
`Cleared N leftover browser process holding the profile` on the way up, that is
this working, not a problem.

Enrichment sidesteps the question entirely. It reads LinkedIn's public guest
endpoint over plain HTTP, so it needs no browser, no session and no pageview
budget, and it keeps working while another stage has the browser. Only
`login`, `check`, `discover`, `seed`, `tailor` and `apply` need Chrome.

### Running autonomously

`npm run run` is a single discover/enrich pass — it stops on its own. To keep the
whole pipeline moving without you, use `npm run auto` (or the toggle in the
dashboard control bar). It loops the full sequence —
`discover → enrich → score → tailor → apply → email → replies` — then waits the
between-cycle interval (15 min by default; set `auto_interval_ms` in settings) and
goes again, until you stop it.

It adds no new policy: the daily caps, the operating-hours window and the run mode
still gate every application from inside the stages, so **`auto` in observe mode
still applies to nothing** — it discovers, enriches, scores and tailors on repeat,
and stops short of submitting until you switch to review or auto mode. Stages never
run two at a time, so it never fights a manual dashboard button over the browser.

The kill switch pauses the loop rather than ending it: turn STOP on and it parks
before its next stage; clear it and the same loop resumes. Because it was left on
is remembered, restarting the dashboard resumes it too.

## Commands

| Command | Does |
|---|---|
| `npm run login` | One-time manual LinkedIn login |
| `npm run check` | Session status, today's rates, current mode |
| `npm run serve` | Dashboard only |
| `npm run run` | Dashboard + one discover/enrich pass |
| `npm run auto` | Dashboard + the full pipeline on repeat until stopped |
| `npm run discover` | Discovery only |
| `npm run enrich [n]` | Fetch JDs, resolve apply routes (no browser, no session) |
| `npm run apply [mode] [n] [--now]` | Apply via Easy Apply and external ATS |
| `npm run email [n]` | Draft email applications into the outbox |
| `npm run outbox [-- --send]` | List held drafts, or send them now |
| `npm run replies` | Poll sent threads for responses |
| `npm run gmail:auth` | One-time Gmail connection |
| `npm run seed [--force]` | Load the base resume into the optimiser's saved default |
| `npm run tailor [n]` | Tailor + export a PDF per scored job |
| `npm run score [n]` | Fit-score enriched jobs |
| `npm run profile` | List unconfirmed profile fields |
| `npm run searches` | List search terms and blocked companies |
| `npm run stop` / `resume` | Kill switch |
| `npm run mode [m]` | `observe` \| `review` \| `auto` |
| `npm run verify` | Print-PDF text-layer check |
| `npm test` | 202 tests, no network |

## How a question gets answered

Ladder, first hit wins (`src/answer/resolver.js`). The tier that answered is
recorded on every field, so a wrong answer is always traceable.

1. **Profile** — deterministic lookup (`src/answer/matchers.js`). Never sees a model.
2. **Answer bank, exact** — normalised question text, scoped company → ats → global.
3. **Answer bank, fuzzy** — token-set cosine ≥ 0.85, flagged `probable`.
4. **LLM draft** — profile is the only fact source; must return `UNANSWERABLE`.
5. **Park** — queue it for you. Never a guess.

`guardAnswer()` re-checks anything a model produced, because a prompt is not a
control: years-of-experience answers must trace to a `confirmed` `skills[].years`
entry, work authorisation may never come from a model, and credentials must appear
in the profile.

Answering one parked question in the dashboard releases every application waiting
on it, and answers every future occurrence automatically.

## Applying

```bash
npm run mode review        # fill everything, submit nothing
npm run apply              # walk the Easy Apply flow for tailored jobs
```

Three modes, switchable in the dashboard header or via `npm run mode`:

| Mode | Behaviour |
|---|---|
| `observe` | Applies to nothing. The default. |
| `review` | Fills every step, screenshots it, abandons, queues for approval. |
| `auto` | Fills and submits. |

In review mode the dashboard shows every field the bot filled with **the tier that
produced each value** — `profile` (green), `bank-exact`, `llm` (amber), `probable`
(red, a fuzzy answer-bank match worth checking) — plus a screenshot of every step.
Approve queues it for submission; the next `npm run apply` re-runs the flow and
submits.

Approving re-runs rather than resuming: LinkedIn discards in-progress
applications, sessions expire and postings change, so a half-filled modal from an
hour ago cannot be picked back up. It costs a second pass through the form, which
only matters while you are in review mode.

**Parking beats submitting.** If any required question cannot be answered
truthfully, the application is abandoned and the modal discarded — even in auto
mode. It never guesses to get to the end.

### External ATS platforms

LinkedIn's Apply button usually opens a new tab behind a redirect shim, so the
runner follows the popup, lets it settle on its final URL, and fingerprints the
vendor from that.

| Vendor | Handling |
|---|---|
| Greenhouse, Lever, Ashby, Workable, SmartRecruiters | Automated |
| Anything unrecognised | Generic adapter + accessibility collector — filled, **never auto-submitted** |
| Workday, Taleo, iCIMS | Routed to `manual_required` with a reason |

These five boards are the same shape — one page, labelled inputs, a file input, a
submit button — so they share one flow and differ only by config in
`src/apply/adapters/index.js`: how to recognise them, where the form is, where the
file and submit controls are, and what success looks like. Five bespoke adapters
would rot independently; one flow plus five configs does not. Ashby and Workable
render behind hashed CSS class names, so selectors lean on stable attributes
(`name`, `type`, `data-ui`, `aria-label`, button text) rather than classes.

Two behaviours worth knowing:

- **The form is often in an iframe.** These boards are commonly embedded on the
  company's own careers domain, so the runner searches every frame for one that
  actually contains form controls.
- **Prefilled values are never clobbered.** Several boards parse the uploaded
  resume and autofill from it; where their value already matches ours it is left
  alone and marked `prefilled` in the review table.

### Boards nobody has written an adapter for

The five named vendors are built from native `input`, `select` and `textarea`
elements, which is what makes one shared flow enough for all of them. A React or
Vue careers site often is not: the controls are `div[role="textbox"]`, the select
is a button plus a listbox, and the whole form may sit inside a web component
where `querySelectorAll` cannot reach it at all.

For those, a second collector walks the accessibility tree instead
(`src/apply/a11y.js`). It computes each control's accessible name in the page —
`aria-labelledby`, then `aria-label`, then a `<legend>` or `<label for>`, then a
wrapping label, then a name from the element's own contents, and only as a last
resort a placeholder — pierces open shadow roots, and tags each control so it can
be found again to fill. Where a label is only visual (a `<p>` sitting above the
box), the nearest preceding text in the enclosing block is used.

The DOM collector still runs first, because it is faster and deterministic;
finding fewer than two fillable fields is the signal to fall back.

Multi-step forms go through the same loop as Easy Apply (`src/apply/wizard.js`).
Two guards there are worth knowing about:

- **Fields are re-read after filling.** "Do you require sponsorship? → Yes" can
  reveal three more questions; advancing without re-reading would submit them
  blank.
- **A form that does not advance is abandoned, not retried.** If clicking Next
  produces the same set of questions again, the run stops with a reason rather
  than spinning until the step ceiling.

An unknown form is still never auto-submitted, whatever the mode.

### Email applications

Common in South African postings: *"Send your CV to careers@company.co.za, quoting
reference MKT/2026/04 in the subject line."* Treated as a first-class channel.

```bash
npm run gmail:auth      # one-time; without it, drafts are written to disk only
npm run email           # draft into the outbox
```

Sent through the **Gmail API rather than SMTP** — your real address, correct
threading, and the mail lands in your own Sent folder. Scopes are `gmail.send` and
`gmail.readonly`; nothing here can alter or delete mail.

**Drafts hold for 15 minutes, then send themselves.** Cancelling is the action,
not sending — no input is needed to let one go. This is the only deliberate delay
left in autonomous mode, because email cannot be unsent, the recipient is a named
human, and a malformed send is a first impression you cannot retract. Set
`OUTBOX_HOLD_MINUTES=0` to disable. The dashboard flushes the outbox once a
minute, so leaving it open is what keeps mail moving.

Three guards:

- **The recipient must literally appear in the posting.** A model-suggested
  address that is not in the text is discarded in favour of one that is. Sending a
  CV to a hallucinated stranger is the worst failure available here.
- **Required documents are detected deterministically**, not by the model, and
  unioned with whatever the model reports. A posting demanding a certified ID copy
  or transcripts parks rather than sending a knowingly incomplete application.
- **Reference numbers are carried into the subject line.** ZA postings routinely
  bin applications that omit them.

Replies are polled and classified (`replied` / `interview` / `rejected`). Email is
the only channel that returns outcome data automatically — the ATS ones tell you
nothing.

### Safety

| Control | Setting |
|---|---|
| Easy Apply / day | 15 (the only ban-exposed channel) |
| External ATS / day | 35 |
| Email / day | 15 |
| LinkedIn pageviews / day | 250 |
| Gap between applications | 2–8 min, log-normal |
| Operating window | 08:00–19:00 SAST, weekdays |
| Challenge / captcha | Global halt, sticky for the rest of the day |
| Kill switch | `npm run stop` |

`--now` bypasses the operating-hours check for testing. Nothing bypasses the caps
or the challenge halt.

## How tailoring works

`src/tailor/optimiser.js` drives the deployed optimiser
(khosisiphugu98.github.io/ai-resume-optimizer) in the same browser: fill the job
description, optimise, accept all diffs, export.

`npm run seed` uploads the base resume once and clicks Save as Default. resume.js
encrypts it into localStorage against a non-extractable IndexedDB key, both of
which live in the persistent Chrome profile, so every later run skips upload and
AI-parsing entirely. **It expires after 30 days** (`loadDefaultOnStartup` in
resume.js), so tailoring re-seeds automatically whenever the default is missing.

Export uses Chromium's `page.pdf()`, not the site's own download button. Measured
on the same resume:

| | Extractable text | Section headers |
|---|---|---|
| `#download-pdf-btn` (html2canvas → JPEG) | 2 chars | none |
| Base CV PDF | 8,415 chars | letter-spaced, extract as `D E V E L O P M E N T` |
| `page.pdf()` | 9,370 chars | clean words |

The header row matters as much as the character count: ATS parsers use section
headings to segment a CV into experience / education / skills. Headers that
extract as spaced single letters mean the parser cannot segment the document.

Every generated PDF passes a text-layer gate (name, email, ≥5 skills) before it is
allowed anywhere near an upload. A PDF that fails is deleted and the job moves to
`tailor_failed`.

## Search terms

What discovery looks for lives in the database and is edited in the dashboard's
**Search terms** panel — add a title, pause one that is not earning its keep,
delete it. Each row shows how many jobs it has ever turned up, which is the point
of the panel: a term returning nothing still spends a pageview off the daily cap
on every run. `SEARCHES` in `src/config.js` seeds the table on first boot and is
never read again. `npm run searches` lists the current set.

## Blocking

Two vetoes, both reversible, both reachable from a job's drawer:

- **Block this application** — the job goes to `blocked` and drops out of the
  queues apply and email read from. Any draft already held in the outbox is
  cancelled, because a held draft sends itself when its timer expires. The
  tailored resume is kept, so unblocking costs nothing and returns the job to the
  stage it had reached.
- **Block this company** — the same sweep across every live job at that employer,
  plus a standing filter so their future postings are rejected at discovery.
  Unblock either from the drawer or from the chip under the search terms.

Neither can touch an application that has already been submitted. Blocking is a
veto on sending, not an undo.

## Outcomes, and whether any of this works

Everything upstream is a guess until something comes back. `THRESHOLD = 65` was
picked out of the air, and so was the rule deciding which postings are worth
scoring at all. Neither has ever been checked against a real reply.

**The Sent panel is the whole dataset.** Easy Apply and the ATS boards report
nothing back, so unless outcomes get marked there is no data. It lists submitted
applications older than seven days with no verdict, oldest first, with one-click
buttons: no response, rejected, screen, interview, offer. Email replies label
themselves — `Check replies` classifies them and writes the outcome — but that is
one channel of three.

The scale is ordinal on purpose. *Rejected* ranks above *no response*, because a
rejection means a human actually opened it.

Two things happen without being asked:

- An application with no reply after 45 days is marked `no_response` with source
  `timeout`. Silence is data; leaving it unlabelled would quietly drop it from
  the denominator and push every response rate upward.
- One in twenty jobs scoring between 40 and the threshold is applied to anyway,
  capped at two a day and labelled `audit sample`. This is the only defence
  against the loop where the threshold decides what gets applied to, which
  decides the data used to set the threshold — without it, jobs below the line
  are never observed, false negatives leave no trace, and the number drifts
  upward forever on evidence that looks good only because everything underneath
  was never tried. Audit samples are excluded from the headline rate and reported
  separately.

**The calibration panel** answers one question in words: *does the fit score
predict a response?* For a long time the answer will be "not enough data yet",
and it says so rather than showing a ranking. Below that: response rate by score
decile, channel, tier, ATS vendor and search term; the profile gaps costing the
most volume; time to response; and a threshold sweep.

Every rate carries a Wilson interval and any group under eight is suppressed
rather than shown as 0% — three applications and no replies is not a 0% response
rate, it is no information, and displayed as a percentage it reads like the
strongest finding on the page.

In the sweep, the column to read is **missed**: replies from applications that
scored *below* that threshold. A threshold set too high discards good jobs
silently, and the only symptom is a thin pipeline that looks like a quiet week.
Nothing is auto-tuned — the panel shows the trade-off, you set the number, and it
is stored in `settings` rather than in code.

Rules of thumb, from `docs/APPLY_BOT_PHASES_7_9.md` §8.5:

- 40 labelled applications before changing anything.
- Expect a 2–8% base response rate. At 5% and n=40, one extra reply moves the
  rate by 2.5 points. Do not chase that.
- Weekly at most, not after every batch.

## Tuning

The rest lives in `src/config.js`:

- `CAPS` — per-channel daily limits; only `linkedin_easy` carries ban risk
- `AUTH_BLOCKERS` / `ZA_LOCATIONS` — the work-authorisation filter (§2.3), the
  highest-leverage rule in the system
- `REJECT_TITLE` — seniority band
- `SELECTORS` — every LinkedIn selector, with fallbacks. When LinkedIn changes its
  DOM, discovery logs a loud warning and this is the only file to touch.

## Notes

- `npm run run` keeps the pipeline and dashboard in one process. Running `serve`
  and `discover` in separate terminals also works — the SSE endpoint tails the
  events table as well as the in-process bus.
- Any captcha or checkpoint halts everything and logs `critical`. Clear it by hand
  in the browser before restarting; never let it retry.
- `data/` and `profile/` are gitignored — session, database and PII stay local.

## After editing `resume.js`

```bash
node scripts/update-hashes.mjs
```

Its sha256 appears in **two** places in `index.html` (the `integrity` attribute and
the CSP `script-src`). Update only one and CSP blocks the script with no page error
and no failed request — the page renders from static HTML and every button is
silently dead.
