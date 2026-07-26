# Adaptive agent — Phase 4: Operator feedback loop

Goal: turn the review table into a teaching surface. When the operator corrects
or approves an agent-driven application, that judgement flows back into the two
memories the agent draws on — the **answer bank** (global, per-question) and the
**cached plan** (per-vendor shape) — so the same mistake isn't made twice and
confidence toward auto-submit (Phase 5) accrues.

Design-doc principle 4: **the operator is the highest authority.** A human
correction overrides the cache, the bank, and the model.

## The three operator actions

The review card already lists every filled field with its source tier. Phase 4
makes it act:

| Action | Writes to answer bank | Writes to cached plan | Effect |
|---|---|---|---|
| **Correct a field** (edit the value inline) | `saveAnswer(source:'human', verified)` — outranks everything, wins next time everywhere | pin `questionNorm → value` on the plan for this vendor shape | The exact question is answered right from now on, globally *and* locked for this vendor |
| **Re-plan** (this page was mis-read) | — | delete the cached plan | Next visit to this shape re-plans from scratch — the coarse "the structure was wrong" escape |
| **Approve** (existing) | `learnFromApproved` (drafted answers → verified) | `success_count++` on the plan | Confirms the plan; raises it toward the Phase-5 auto-submit threshold |

Correct handles "right structure, wrong answer"; Re-plan handles "wrong
structure"; Approve is the confidence signal. Together they cover the design
doc's *correct-a-field / field-misread / approve* trio.

## Data model

Two additive columns (same migration pattern as before):

- **`applications.plan_fingerprint`** — set by `recordAttempt` when the agent
  drove the application (`result.agent.fingerprint`). This is what lets a review
  action find the cached plan the application came from.
- **`page_plans.pins_json`** — operator pins: `{ "<questionNorm>": value }`.
  A pin is vendor-scoped and outranks the resolver entirely (operator authority).

New db helpers: `pinPlanField(fingerprint, questionNorm, value)`,
`deletePlan(fingerprint)`; `getPlan` returns the parsed `pins`.

## How a pin is applied

`executePlan` gets the plan's `pins`. In `collect()`, before a field goes to the
resolver, its label is normalised and looked up in `pins`; a hit is filled
directly with the pinned value and recorded as tier **`operator`** — it never
touches `resolveFormBatch`, because the operator has already decided. Everything
else resolves exactly as today (and `guardAnswer` still applies to model output).

## Server + dashboard

- **`/api/review` POST** gains `correct` (`id`, `question`, `value`) and `replan`
  (`id`); `approve` additionally bumps the plan's `success_count` when the
  application was agent-driven. `correct` writes the bank, pins the plan (if the
  application has a fingerprint), and updates the stored `filled_json` so the card
  reflects the fix.
- **Review card**: each field value becomes inline-editable (blur/Enter saves via
  `correct`); agent cards get a small **Re-plan** control. A corrected field
  re-renders with an `operator` tier badge.

## Tests (network-free)

- A correction saves a `human`, verified answer that then wins via `lookupExact`,
  and pins the value on the plan; a subsequent execute uses the pin (tier
  `operator`) without calling the resolver.
- Re-plan deletes the cached plan, so the next `getPlan` is a miss.
- Approving an agent application bumps the plan's `success_count`.

## NOT in Phase 4

No auto-submit (that's Phase 5 — Phase 4 only *builds the confidence* it reads).
No few-shot exemplar store for the planner (the pin + re-plan pair covers the
correction need without it; revisit if planning quality needs it).
