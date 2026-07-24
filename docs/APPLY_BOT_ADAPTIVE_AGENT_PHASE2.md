# Adaptive agent — Phase 2: Planner (fill-only, implementation plan)

Goal: when the deterministic apply flow gives up on an unknown external page, an
**LLM planner** reads the page (reusing Phase 1's snapshot), returns a
**structured plan**, and an **executor** fills the form through the existing
wizard primitives. **It never submits. Review mode only.** The plan and every
filled field are surfaced in the dashboard review table.

Phase 1 turned the blind tail into a labelled dataset. Phase 2 is the first
phase that actually *solves* those pages — but only up to "filled and queued for
a human", never up to "submitted". Auto-submit is Phase 5.

## Where it plugs in

`applyExternal` (src/apply/external.js) has three points where it captures a
snapshot and throws. Phase 2 inserts one escalation call *before* each throw:

| Failure point | Phase 1 | Phase 2 |
|---|---|---|
| `!scope` (no form) | capture + throw | try the agent; on success return `ready`/`parked`; else capture + throw |
| `!first.items.length` (no fields) | capture + throw | same |
| wizard `stuck` | capture + throw | same |

The agent is **off by default** (`agent_enabled` setting). With it off the flow
is byte-for-byte what it is today. Turning it on is how Phase 2 is validated on
the captured `alignerr.com` / `micro1.ai` pages.

## The four steps

```
observe()  → a model-ready page description (Phase 1's buildSnapshot + traps)
plan()     → cached? no cache in Phase 2 — always ask the model for a plan
execute()  → fill the plan through runWizard, submit:false → outcome ready|parked
             (on model/exec failure, return null and let the caller capture+throw)
```

### 1. Observe — `src/apply/agent/observe.js`
Reuses `capture.buildSnapshot` (a11y tree + DOM fields + frames + outline) and
adds the two structural traps from the design doc: a **landing page** (an
"Apply"/"Start" button that must be clicked to reveal the form) and a **form
behind a tab**. Output is compact JSON — controls, visible button labels, frame
list, tag histogram — never the full HTML.

### 2. Plan — `src/apply/agent/plan.js`
Provider-abstracted. **Primary: `claude-opus-4-8`** via structured outputs
(`output_config.format` with a JSON schema — the plan is guaranteed to validate).
**Fallback: `gpt-4o`** through the existing `callLLM` path, triggered on *any*
Anthropic failure (missing key, HTTP error, or a plan that fails our own sanity
check). The schema:

```json
{
  "kind": "form" | "landing" | "unsupported",
  "preSteps": [{ "action": "click", "target": "<accessible name>" }],
  "fields":  [{ "label": "...", "type": "email", "required": true,
               "locator": { "by": "label|role|name|placeholder", "value": "..." } }],
  "advance": { "by": "role", "value": "Next" } | null,
  "submit":  { "by": "role", "value": "Submit application" } | null
}
```

Locators are restricted to stable strategies (accessible name, label, role,
name/placeholder attr) — never hashed classes, the same discipline the vendor
configs already use.

Auth note: the bot has no Anthropic SDK and no key by default. `plan.js` hand-
rolls the Messages API call the same way `llm.js` hand-rolls OpenAI (raw
`fetch`, `x-api-key` + `anthropic-version`). Until an `ANTHROPIC_API_KEY` is set
(gear, like the OpenAI key) or an `ant auth` profile exists, **the planner falls
back to gpt-4o on every call** — Phase 2 still ships and validates.

### 3. Execute — `src/apply/agent/execute.js`
Translates the plan into the primitive set `runWizard` already understands.
Every field value still goes through `resolveFormBatch` → `guardAnswer`: **the
agent decides *where* a value goes; the resolver decides *whether* it is
allowed.** `submit` is forced to `false`, so the wizard stops at the terminal
control and returns `ready` (or `parked`) — it never clicks submit. The plan's
`preSteps` reveal a hidden form; `advance` moves between steps; `submit` is only
used to *recognise* the terminal, not to press it.

### 4. Learn — deferred
No plan cache, no fingerprint reuse, no feedback write-back in Phase 2. Those are
Phases 3–4. Phase 2 only proves the planner + executor solve real pages.

## MCP — considered, deferred

An MCP route (Claude drives a local Playwright MCP server tool-by-tool) was
considered. It is deferred, for three reasons: Anthropic's server-side MCP
connector can't reach a `localhost` browser (would need a client-side tool
loop); it would have to attach to our persistent Chrome over CDP; and, most
importantly, letting the model click and type directly puts it in charge of the
*values*, which collides with the anti-fabrication guard. The structured-plan +
our-executor split keeps `guardAnswer` on every value. Revisit MCP as a spike
once we've seen how a plain planner does on the captured pages.

## Dashboard

The review table already shows every filled field with its source tier. Phase 2
adds an **`agent`** tier badge so operator-visible fields the planner drove are
obvious, and shows the plan `kind` + fingerprint on the card. The correction UI
(pin/relabel) is Phase 4.

## Config & secrets

- `agent_enabled` setting (default off) — the escalation switch, toggled from the gear.
- `ANTHROPIC_API_KEY` — new allowed secret in `secrets.js`, set from the gear like the OpenAI key; status shown in Settings.
- Model ids centralised: planner primary `claude-opus-4-8`, fallback `gpt-4o`.

## Tests (network-free, matching the suite)

- Plan schema: a valid plan passes `validatePlan`; missing `kind`, a hashed-class
  locator, or an unknown field type is rejected.
- Provider fallback: with a stub Anthropic caller that throws, the planner falls
  back to the OpenAI caller and still returns a plan; with neither key, it
  returns null (and the caller captures + throws, as today).
- Executor: against a fixture page it fills the plan's fields and **stops at the
  terminal without clicking submit** (`outcome: 'ready'`), and an ungrounded
  value still parks via the guard.
- Off path: with `agent_enabled` unset, `applyExternal` behaviour is unchanged.

## Explicitly NOT in Phase 2

No auto-submit (whatever the mode), no plan cache/replay, no per-vendor learned
memory, no operator correction write-back. Those are Phases 3–5. Phase 2 ends
when, with the agent enabled and a key present, a previously-unsolvable captured
page fills and lands in the review queue.
