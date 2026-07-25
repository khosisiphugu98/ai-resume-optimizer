# Adaptive agent — Phase 3: Learned memory (plan cache/replay)

Goal: stop paying the LLM planner for a page shape we have already solved. The
first time the agent fills an unknown page, cache the working plan keyed by a
page fingerprint. The next time that shape appears, **replay the cached plan
deterministically — no model call.** A plan that stops working is demoted and
re-planned.

This is design-doc principle 2 ("Learn, then stop guessing"): guessing becomes a
one-time cost per vendor *shape*, not per application.

## Where it plugs in

Entirely inside `runAgent` (src/apply/agent/index.js), between observe and plan:

```
observe()               → fingerprint (already computed in Phase 2)
getPlan(fingerprint)    → a cached, non-demoted plan?
  ├─ yes → execute it. success → bump success, done (NO LLM call).
  │                     stuck   → bump fail, fall through to re-plan.
  └─ no  → planPage() (LLM) → execute → on success savePlan(fingerprint, plan).
```

Nothing else changes: the executor is Phase 2's `executePlan` (fill-only, never
submits), the gate is still `agent_enabled`, and a total miss still falls through
to Phase 1 capture + throw.

## The fingerprint as a reuse key

Phase 1 deferred the *reuse-grade* key to here, warning that getting it wrong
poisons the cache. We reuse Phase 1's `fingerprintOf(host, controls)` —
`sha256(host + '|' + sorted("role:normalizedName"))` — and rely on **graceful
degradation** rather than a perfect key:

- It is control-based, so it changes when the form's fields change and is stable
  across postings (job prose is not a control). Good enough to group shapes.
- If two pages collide (same fingerprint, different form), the replay can't do
  harm: `executePlan` re-locates every field on the *live* page and skips any
  locator that doesn't resolve, and it never submits. A plan that doesn't fit
  reaches no terminal → `stuck` → we bump fail and re-plan.

So a wrong cache entry costs one wasted replay attempt and a re-plan, never a bad
application. That is what makes reusing the Phase-1 key safe here.

## Storage — new `page_plans` table

Separate from `page_captures` (raw failures) by design — plans are *solved,
replayable* structures.

```sql
CREATE TABLE page_plans (
  id            INTEGER PRIMARY KEY,
  fingerprint   TEXT NOT NULL UNIQUE,
  host          TEXT,
  plan_json     TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'llm',   -- llm | operator (operator = Phase 4)
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX idx_page_plans_fp ON page_plans(fingerprint);
```

`savePlan` upserts on `fingerprint`: a fresh solve replaces the stored plan and
resets the counters; a re-solve of a previously-cached shape (after demotion)
overwrites it. `bumpPlanSuccess` / `bumpPlanFail` move the counters and stamp
`last_used_at`.

**Demotion.** `getPlan` returns a cached plan only if it is not demoted:
`fail_count < DEMOTE_AT` **or** `success_count > fail_count`. A plan that has
failed `DEMOTE_AT` times without a winning majority is skipped (treated as a
miss) and re-planned; the re-plan overwrites it and resets the counters. This is
self-healing: a vendor DOM change breaks the cached plan, it fails a few times,
gets re-planned, and the new plan takes over.

## Code shape

- **db.js** — the migration + `getPlan(fingerprint)`, `savePlan({fingerprint,
  host, plan, source})`, `bumpPlanSuccess(fingerprint)`, `bumpPlanFail(fingerprint)`,
  `listPagePlans()`. Additive migration, same pattern as `page_captures`.
- **agent/index.js** — the cache lookup / replay / refine flow above. Emits which
  path ran (cached replay vs fresh plan) so the event log shows the saving.
- **cli.js + package.json** — `npm run plans`: list cached shapes (host, source,
  success/fail, age), newest first — the Phase-3 "is it learning" surface, the
  mirror of `npm run captures`.

## Tests (network-free, matching the suite)

- Round-trip: `savePlan` then `getPlan` returns the plan; a second `savePlan` for
  the same fingerprint overwrites and resets counters.
- Counters: `bumpPlanSuccess` / `bumpPlanFail` move the right way and stamp
  `last_used_at`.
- Demotion: a plan past `DEMOTE_AT` fails with no winning majority is withheld by
  `getPlan`; one with more successes than failures is still served.
- Replay-first: with a cached plan present, `runAgent` executes it and the LLM
  planner is never called (injected/spied); on a cached-plan `stuck`, it re-plans.

## Explicitly NOT in Phase 3

No operator feedback write-back (Phase 4 sets `source: operator` and pins fields),
no auto-submit (Phase 5). Phase 3 ends when a second visit to a solved vendor
shape fills the page with zero model calls, and a broken cached plan heals itself
by re-planning.
