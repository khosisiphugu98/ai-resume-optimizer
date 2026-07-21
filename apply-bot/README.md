# apply-bot

Autonomous job application pipeline. Full design: [`../docs/APPLY_BOT_PLAN.md`](../docs/APPLY_BOT_PLAN.md).

**Phase 1 (current):** discovery + observability. Finds and filters jobs, fetches
descriptions, resolves apply routes. **Applies to nothing.**

## First run

```bash
cd apply-bot
npm install
npx playwright install chromium

npm run login      # log in to LinkedIn by hand, once — 2FA included
npm run check      # confirm the session stuck
npm run run        # dashboard + one discover/enrich pass
```

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
| `npm run searches` | List configured searches |
| `npm run stop` / `resume` | Kill switch |
| `npm run mode [m]` | `observe` \| `review` \| `auto` |
| `npm run verify` | Print-PDF text-layer check |
| `node scripts/smoke.mjs` | Filter + board tests, no network |

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
