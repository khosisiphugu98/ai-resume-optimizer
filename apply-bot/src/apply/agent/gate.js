// The auto-submit gate (Phase 5). The one decision that turns an agent-filled
// page from "held for review" into "submitted". Deliberately strict, and only
// ever consulted when the run already intends to submit (auto mode, or an
// operator-approved job). See docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE5.md.

// A vendor shape must have been human-approved this many times before it may
// submit itself — the confidence ramp. A brand-new shape has 0 and never
// auto-submits on first sight.
export const AUTOSUBMIT_MIN_SUCCESS = 3;

// Tiers whose values trace to confirmed-profile, operator, or deterministic data
// — safe to send unreviewed. An ungrounded model value (llm) or a fuzzy bank hit
// (bank-fuzzy / probable) is NOT here, so a generated or guessed answer always
// blocks auto-submit and goes to review instead.
const GROUNDED = new Set(['profile', 'bank-exact', 'operator', 'resume', 'prefilled']);

/**
 * @param submitIntent      is the run already trying to submit? (auto/approved)
 * @param planSuccessCount  the cached plan's proven-success count
 * @param filled            fields that were filled, each with a `tier`
 * @param parked            fields that could not be answered (empty = none)
 * @returns true only when every condition for a safe autonomous submit holds
 */
export function autoSubmitAllowed({ submitIntent = false, planSuccessCount = 0, filled = [], parked = [] } = {}) {
  if (!submitIntent) return false;                              // never manufacture submit intent
  if (parked.length) return false;                             // anything unanswerable/guarded → review
  if (planSuccessCount < AUTOSUBMIT_MIN_SUCCESS) return false; // shape not proven yet
  for (const f of filled) {
    if (f.probable) return false;                              // a fuzzy hit is a maybe, not a fact
    if (!GROUNDED.has(String(f.tier || '').trim())) return false;  // any ungrounded value blocks
  }
  return true;
}
