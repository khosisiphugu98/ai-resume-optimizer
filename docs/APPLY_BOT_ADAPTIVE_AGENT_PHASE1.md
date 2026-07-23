# Adaptive agent — Phase 1: Capture (implementation plan)

Goal: turn today's blind "no form found / did not advance" failures on unknown
external application pages into a **labelled dataset** we can build the planner
(Phase 2) against. **Zero behaviour change, zero model calls, zero cost.** The
apply flow fails exactly as it does now — capture is a best-effort side effect
that runs just before each failure throws.

Scope note (per operator): the target is *any company's external application
page*, not the two specific SPAs we happened to hit. Alignerr / micro1.ai are
just the first instances of the general class.

## What gets captured, and when

Three failure points in `src/apply/external.js`, each just before its `throw`:

| Site | Current error | `failure_stage` |
|---|---|---|
| `applyExternal`, no frame has a form (`!scope`) | `No application form found on <vendor> page` | `no-form` |
| `applyExternal`, form found but no fillable fields | `Form on <vendor> had no fillable fields` | `no-fields` |
| `applyExternal`, wizard returns `stuck` | `<wizard reason>` (e.g. "did not advance past step 1") | `stuck` |

Out of scope for Phase 1: the LinkedIn-side `No apply button` failure (that's the
entry bug we already fixed, not an unknown-page problem) and the Easy Apply
wizard (LinkedIn is a *known* vendor, not the long tail). We can add the Easy
Apply `stuck` site later if it earns its keep.

## The snapshot

A best-effort, model-ready description of the page at the moment of failure,
built by reusing collectors that already exist:

- **Accessibility tree** — `collectA11yInPage('body')` over every frame (the same
  in-page function `a11yScope` uses), so we capture the real fillable controls on
  React/Vue SPAs where the DOM collector sees nothing.
- **DOM field specs** — `collectFieldsInPage` per frame (native controls).
- **Frame list** — url + whether each frame carried controls.
- **Trimmed DOM outline** — tag histogram + landmark roles (`main`, `form`,
  `[role=dialog]`), not the full HTML.
- **Screenshot** — full-page PNG (already available via `shot()`).
- **Context** — `job_id`, resolved apply `url`, page `title`, `vendor`
  (`detectVendor` result), `failure_stage`, `failure_reason`.

Structured JSON + PNG are written to **`data/agent-snapshots/<fp8>/<id>.{json,png}`**
(`data/` is gitignored — page content and any prefilled PII stays local, same as
the SQLite DB). Only compact metadata + the two file paths live in the DB.

## Fingerprint (how we group "the same page shape")

```
fingerprint = sha256(host + '|' + controlSignature)
controlSignature = sorted("role:normalizedAccessibleName") joined by '\n'
```

- `host` = hostname of the resolved apply URL (the vendor/company domain).
- `controlSignature` comes from the a11y tree; job-specific prose isn't a form
  control, so a given vendor template hashes stably across postings.
- On a `no-form` page there are no controls, so the fingerprint collapses to the
  host — exactly right: one "this host shows no reachable form" example per site.

This is deliberately good-enough-for-grouping, not the final reuse key. Phase 1
only needs it to **dedupe** and to let us count distinct shapes. The reuse-grade
fingerprint (which decides when a cached *plan* may be replayed) is a Phase 3
decision, and getting it wrong there is what poisons the cache — so we defer it.

## Storage — new `page_captures` table

Kept separate from the `page_plans` cache in the design doc: captures are raw
*observations* (Phase 1); plans are *solved, replayable* structures (Phase 3).
Mixing them would muddy both.

```sql
CREATE TABLE page_captures (
  id              INTEGER PRIMARY KEY,
  job_id          INTEGER REFERENCES jobs(id),
  captured_at     TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  vendor          TEXT,          -- detectVendor(): generic | greenhouse | ...
  host            TEXT,
  url             TEXT,
  title           TEXT,
  fingerprint     TEXT NOT NULL,
  failure_stage   TEXT,          -- no-form | no-fields | stuck
  failure_reason  TEXT,
  control_count   INTEGER,       -- fillable controls seen (0 for no-form)
  snapshot_path   TEXT,          -- data/agent-snapshots/<fp8>/<id>.json
  screenshot_path TEXT,
  seen_count      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_page_captures_fp ON page_captures(fingerprint);
```

**Upsert, don't append.** On a fingerprint that already exists: bump `seen_count`,
refresh `captured_at` / `failure_reason` / paths, overwrite the snapshot files.
This keeps the auto loop re-hitting the same dead postings from ballooning the
dataset (recall the retry loop and the audit-sample re-tries). Added via the
existing additive-migration pattern in `db.js` (`CREATE TABLE IF NOT EXISTS` +
`addColumn`).

## Code shape

- **`src/apply/agent/capture.js`** — new. `captureUnsolvedPage(page, { job, vendor,
  stage, reason })`: builds the snapshot, computes the fingerprint, writes files,
  upserts the row. Wrapped entirely in `try/catch` — **capture must never change
  apply's outcome or throw**; on any error it logs a `warn` event and returns.
- **`src/apply/external.js`** — three one-line `await captureUnsolvedPage(...)`
  calls, each immediately before the corresponding `throw`.
- **`src/db.js`** — the migration + a small `upsertPageCapture()` / `listPageCaptures()`.
- **`package.json` + `src/cli.js`** — `npm run captures`: prints the distinct
  captured shapes (host, vendor, stage, control_count, seen_count, age), newest
  first. This is the Phase-1 "did it work" surface — **no dashboard UI yet**
  (the dashboard gets the planner's review table in Phase 2).

## Tests (no network, matching the existing suite)

- Fingerprint is stable: same control set → same fingerprint; different host or
  control set → different.
- `upsertPageCapture` inserts once, then bumps `seen_count` on the same
  fingerprint instead of adding a row.
- Capture is best-effort: a collector that throws is swallowed and the caller
  still sees the original apply failure unchanged.
- `no-form` capture records `control_count = 0` and a host-only fingerprint.

## Explicitly NOT in Phase 1

No LLM, no planner, no fill/execute, no auto-submit, no plan cache/reuse, no
dashboard UI, no change to what apply does on success or failure. Those are
Phases 2–5. Phase 1 ends when the running loop is quietly writing deduped
captures and `npm run captures` shows the dataset growing.

## Open decisions for sign-off

1. Separate **`page_captures`** table now, `page_plans` later (recommended) — vs.
   one table from the start.
2. Snapshots under **`data/agent-snapshots/`** (gitignored, local) — confirm
   that's the right home for page content + any prefilled PII.
3. Capture **external-page failures only** in Phase 1 (defer Easy Apply) — ok?
4. Fingerprint = **host + a11y control signature** as specified — ok as the
   grouping key (reuse key deferred to Phase 3)?
5. **`npm run captures`** CLI as the only Phase-1 surface (no dashboard) — ok?
