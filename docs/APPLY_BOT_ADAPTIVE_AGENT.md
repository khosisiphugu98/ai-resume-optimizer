# Apply-bot: the adaptive, self-learning application agent

## Why

The selector fixes got every page past the *entry point*. What's left is
form-filling *depth* on pages nobody wrote an adapter for. Observed live
(review mode, July 2026):

- **Generic React/Vue SPAs** — `alignerr.com`, `micro1.ai` — the page loads but
  `formScope` + `a11yScope` find no fillable form, or the wizard can't advance.
- **Multi-step forms that stall** — "same fields came back after clicking next":
  a required field we *think* we filled wasn't satisfied, or a required field we
  never detected is blocking submission.

Hand-writing an adapter per vendor does not scale — the long tail of ATS and
bespoke career SPAs is exactly where volume leaks. This agent is the escalation
layer that handles the tail, **learns** each new shape, and lets the operator
correct it.

## Principles

1. **Deterministic-first.** The existing DOM/a11y collectors + the answer ladder
   (`resolver.js`) stay the primary path: fast, free, auditable. The agent is the
   *fallback*, triggered only when the deterministic path finds < 2 fields or the
   wizard returns `stuck`/`no form`.
2. **Learn, then stop guessing.** The first time the agent solves a page it caches
   the working plan keyed by a page fingerprint. The next time that shape appears
   it replays the cached plan deterministically — no LLM call. Guessing is a
   one-time cost per vendor shape, not per application.
3. **The anti-fabrication guard is non-negotiable.** `guardAnswer` still re-checks
   every model-produced value; PII, work-authorisation, credentials and
   years-of-experience must trace to the confirmed profile or answer bank. The
   agent may read structure freely; it may never invent an *answer*.
4. **The operator is the highest authority.** A human correction overrides the
   cache, the bank, and the model — and is what the agent learns from most.

## Architecture

Escalation inside the existing `applyExternal` / `applyEasy` flow:

```
collect (DOM → a11y)                         [existing, unchanged]
  └─ if < 2 fields OR wizard 'stuck'/'no form':
        observe()   → page snapshot: a11y tree + trimmed DOM + screenshot + frames
        plan()      → cached plan for this fingerprint, else LLM produces a plan
        execute()   → run the plan via wizard primitives, re-observing after each act
        learn()     → on success, persist/refine the plan; on stuck, record snapshot
```

### 1. Observe — `src/apply/agent/observe.js`
Builds a compact, model-ready page description: the accessibility tree (reusing
`a11y.js`), a trimmed DOM outline, the list of frames/shadow roots, visible
button labels, and a screenshot. Also detects the two structural traps seen live:
a **landing page** (an "Apply" button that must be clicked to reveal the form) and
a **form behind a button/tab**.

### 2. Plan — `src/apply/agent/plan.js`
Cache lookup first (`page_plans` by fingerprint). On miss, the LLM returns a
**structured plan**, not prose:

```json
{
  "kind": "form" | "landing" | "unsupported",
  "preSteps": [{ "action": "click", "target": "<accessible name/role>" }],
  "fields": [
    { "id": "email", "label": "Email address", "type": "email",
      "required": true, "locator": { "by": "label", "value": "Email" } }
  ],
  "advance": { "by": "role", "value": "button:Next" },
  "submit":  { "by": "role", "value": "button:Submit application" }
}
```

Locators lean on stable strategies (accessible name, label, role, name attr) — the
same discipline the vendor configs already use — never hashed classes.

### 3. Execute — `src/apply/agent/execute.js`
Translates the plan into the small primitive set the wizard already understands
(fill, select, check, click, upload) and drives it through `runWizard`, so the
no-progress guard, re-collection, and parking all still apply. Each field value
still goes through `resolveFormBatch` → `guardAnswer`; the agent decides *where*
a value goes, the resolver decides *whether* it's allowed.

### 4. Learn — the memory
Three layers, cheapest first:

| Layer | Table | Grows from | Reused as |
|---|---|---|---|
| Answer bank | `answers` (exists) | human + approved LLM answers | exact/fuzzy question match |
| **Page-plan cache** | `page_plans` (new) | a plan that filled+advanced | deterministic replay per fingerprint |
| Planner few-shots | `settings` | successful plans | exemplars in the plan prompt |

`page_plans`: `{ fingerprint, vendor_host, plan_json, success_count, fail_count,
last_used, created_from: llm|operator }`. A plan that fails increments `fail_count`
and regenerates; repeated failure demotes it.

### 5. Feedback — the operator loop
The dashboard review table already shows every filled field with its source tier.
Extend it so the operator can, on any agent-driven application:

- **Correct a field** → writes the answer bank (existing) *and* pins the
  field→value mapping on the plan (so the vendor's cached plan improves).
- **"Field misread / wrong control"** → marks that plan element bad; the agent
  re-plans that field next time and stores the correction as a few-shot.
- **Approve** → confirms the plan; `success_count++`, raising confidence toward
  auto-submit.

## Auto-submit gate

You accepted the auto-submit risk. The gate that makes it safe rather than
reckless: **submit automatically only when every *required* field resolved from
confirmed-profile or answer-bank data** (no ungrounded LLM value), the plan's
`success_count ≥ N`, and no field hit the anti-fabrication guard. Anything short of
that fills and queues for review instead of submitting. Email-channel and
Workday/Taleo/iCIMS rules are unchanged.

## Build order (each phase ships and is useful alone)

- **Phase 1 — Capture (low risk, no behaviour change).** On every `no form`/`stuck`
  failure, save the full page snapshot + fingerprint to `page_plans` as an
  unsolved example. Immediately turns today's blind tail into a labelled dataset.
- **Phase 2 — Planner, fill-only.** LLM planner + executor, review mode only, never
  submits. Validate on `alignerr.com` and `micro1.ai`. Surface the plan in the
  dashboard.
- **Phase 3 — Learned memory.** Cache + replay successful plans by fingerprint;
  refine on failure.
- **Phase 4 — Feedback UI.** Operator corrections write back to bank + plan cache.
- **Phase 5 — Confident auto-submit.** Enable the gate above.

Phases 1–2 are where the current failures get solved; 3–5 are what make it *learn*
and eventually run unattended.
