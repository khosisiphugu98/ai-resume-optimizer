# Adaptive agent — Phase 5: Confident auto-submit

Goal: let the agent *submit* an unknown-page application on its own — but only
when it is genuinely safe to. Every phase so far fills and queues for review.
Phase 5 adds the one gate that turns "filled" into "submitted", and only that.

This is the phase with real-world consequences (a real application goes out), so
the gate is deliberately strict and the whole thing stays behind the existing
**`auto` mode, which is off by default.** In `observe`/`review` mode the agent
never submits, exactly as in Phase 2–4.

## The gate

`autoSubmitAllowed({ submitIntent, planSuccessCount, filled, parked })` returns
true only when **all** hold:

1. **submitIntent** — the run is already trying to submit (`auto` mode, or an
   operator-approved job). This is the existing `submit` flag `applyExternal`
   receives; the agent never manufactures submit intent on its own.
2. **Nothing parked** — a parked field means something was unanswerable or hit
   the guard. If anything parked, a human should see it.
3. **Plan is proven** — `planSuccessCount >= AUTOSUBMIT_MIN_SUCCESS` (default 3).
   A brand-new vendor shape (0 successes) never auto-submits; it fills, reviews,
   the operator approves (Phase 4 bumps success), and only after enough approvals
   does the shape become eligible. This is the confidence ramp.
4. **Every value is grounded** — every filled field's tier is in
   `{profile, bank-exact, operator, resume, prefilled}`, and none is `probable`.
   An ungrounded model answer (`llm`, `bank-fuzzy`) blocks auto-submit — including
   generated open-ended prose, which a human should glance at. As the operator
   approves answers (Phase 4 → bank `human`/`llm_approved`), more fields become
   grounded and more shapes clear the gate over time.

Fail any check → fill and queue for review, exactly as Phase 2–4.

## Why this is safe

- **Off by default.** Requires `auto` mode, which the operator sets deliberately.
- **The guard is untouched.** `guardAnswer` still vets every model value; a
  guarded value parks, and a parked field fails gate check 2.
- **No ungrounded submission.** Check 4 means nothing the model invented can go
  out unreviewed — only confirmed-profile, operator-verified, or résumé/prefilled
  data.
- **Proven-shape only.** Check 3 means a shape must have been human-approved
  several times before it submits itself.
- **Channel rules unchanged.** The agent only runs on the generic unknown-page
  escalation; email and the `requiresReview` ATSs (Workday/Taleo/iCIMS) keep
  their existing never-auto-submit behavior on the deterministic path.

## Code shape

- **`src/apply/agent/gate.js`** — `autoSubmitAllowed(...)` (pure, unit-tested) +
  `AUTOSUBMIT_MIN_SUCCESS`.
- **`execute.js`** — `executePlan` gains an optional `submitGate(filled, parked)`
  callback. When the wizard reaches the terminal (`ready`), if `submitGate`
  returns true it clicks the terminal, waits, screenshots, confirms (url change
  or a success phrase), and returns `submitted` with evidence; otherwise it
  returns `ready` as today.
- **`index.js`** — `runAgent` receives the `submit` intent, builds the gate from
  it + the cached/just-saved plan's `success_count`, and passes it to
  `executePlan`. A replayed cached plan carries its real success count; a
  freshly-planned shape has 0, so it can never auto-submit on first sight.
- **`external.js`** — passes `submit` into `runAgent`; maps a `submitted` agent
  result into the standard return so `run.js` records it and counts it against
  the daily cap.

## Tests (network-free)

- Gate truth table: passes only when submitIntent && no parked && success≥MIN &&
  all grounded; each single failure (parked present, low success, an `llm` or
  `probable` field, no submit intent) blocks it.
- `executePlan` with a gate that returns true clicks the terminal and returns
  `submitted`; with a gate that returns false it returns `ready` and never
  clicks (the existing fill-only guarantee).
- `runAgent`: a replayed high-success plan with all-grounded fills and submit
  intent submits; the same shape at 0 successes does not.

## NOT in Phase 5

No new UI — auto-submit is a mode the operator already sets. No relaxation of the
guard, the channel rules, or the daily caps. The gate is the whole feature.
