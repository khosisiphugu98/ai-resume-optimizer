# apply-bot

Autonomous job application pipeline. Full design: [`../docs/APPLY_BOT_PLAN.md`](../docs/APPLY_BOT_PLAN.md).

**Phase 2 (current):** discovery, fit scoring, the answer resolver and the parked
queue. **Applies to nothing** — form filling arrives in phase 4.

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
| `npm run score [n]` | Fit-score enriched jobs |
| `npm run profile` | List unconfirmed profile fields |
| `npm run searches` | List configured searches |
| `npm run stop` / `resume` | Kill switch |
| `npm run mode [m]` | `observe` \| `review` \| `auto` |
| `npm run verify` | Print-PDF text-layer check |
| `npm test` | 61 tests, no network |

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
