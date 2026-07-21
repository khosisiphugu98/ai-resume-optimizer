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

## Commands

| Command | Does |
|---|---|
| `npm run login` | One-time manual LinkedIn login |
| `npm run check` | Session status, today's rates, current mode |
| `npm run serve` | Dashboard only |
| `npm run run` | Dashboard + one discover/enrich pass |
| `npm run discover` | Discovery only |
| `npm run enrich [n]` | Fetch JDs, resolve apply routes |
| `npm run apply [mode] [n] [--now]` | Apply via Easy Apply and external ATS |
| `npm run email [n]` | Draft email applications into the outbox |
| `npm run outbox [-- --send]` | List held drafts, or send them now |
| `npm run replies` | Poll sent threads for responses |
| `npm run gmail:auth` | One-time Gmail connection |
| `npm run seed [--force]` | Load the base resume into the optimiser's saved default |
| `npm run tailor [n]` | Tailor + export a PDF per scored job |
| `npm run score [n]` | Fit-score enriched jobs |
| `npm run profile` | List unconfirmed profile fields |
| `npm run searches` | List configured searches |
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
| Anything unrecognised | Generic adapter — filled, **never auto-submitted** |
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

## Tuning

Everything lives in `src/config.js`:

- `SEARCHES` — the 17 saved searches across tiers A–D
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
