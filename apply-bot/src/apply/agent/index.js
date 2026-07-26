// The adaptive agent's escalation entry point.
//
// Phase 2 (fill-only): observe an unknown application page, ask the planner for a
// structured plan, run it fill-only. Phase 3 (learned memory): before asking the
// model, look for a cached plan for this page shape and replay it with no model
// call; a plan that stops working is demoted and re-planned. Returns a
// filled/parked result the review queue can show, or null to let the caller
// capture the page (Phase 1) and throw exactly as today.
//
// Off by default: the `agent_enabled` setting is the switch. Best-effort by
// contract — any failure returns null and never changes the deterministic
// outcome. See docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE2.md and _PHASE3.md.
import { getSetting, getPlan, savePlan, bumpPlanSuccess, bumpPlanFail } from '../../db.js';
import { emit } from '../../bus.js';
import { observePage } from './observe.js';
import { planPage } from './plan.js';
import { executePlan } from './execute.js';
import { autoSubmitAllowed } from './gate.js';

export function agentEnabled() {
  return getSetting('agent_enabled') === '1';
}

// A plan "worked" if its locators fit the page — it reached the terminal (ready),
// filled and parked an unanswerable field (parked), or cleared the gate and
// submitted. Only 'stuck' means the plan didn't fit.
const worked = outcome => outcome === 'ready' || outcome === 'parked' || outcome === 'submitted';

// The Phase-5 gate as a callback executePlan can consult after filling. Never
// manufactures submit intent — `submit` comes from the run (auto/approved).
const makeGate = (submit, planSuccessCount) =>
  (filled, parked) => autoSubmitAllowed({ submitIntent: submit, planSuccessCount, filled, parked });

/**
 * @returns null, or { outcome: 'ready'|'parked'|'submitted', filled, parked, steps, planKind, fingerprint, replayed }
 */
export async function runAgent(page, { job = null, ctx = {}, resumePath = null, stage = '', reason = '', submit = false } = {}, deps = {}) {
  if (!agentEnabled()) return null;
  const { observeFn = observePage, planFn = planPage, executeFn = executePlan } = deps;

  try {
    emit({ jobId: job?.id, stage: 'apply', message: `Agent escalation (${stage}) — ${reason}` });

    const observation = await observeFn(page);
    const fp = observation.fingerprint;
    const shape = fp.slice(0, 8);

    // --- Phase 3: replay a cached plan for this shape, no model call ----------
    const cached = getPlan(fp);
    if (cached) {
      // A cached plan carries its proven success count — a plan the operator has
      // approved enough times can clear the gate; a fresh one (below) cannot.
      const result = await executeFn(page, cached.plan, {
        job, ctx, resumePath, pins: cached.pins, submitGate: makeGate(submit, cached.success_count),
      });
      if (worked(result.outcome)) {
        bumpPlanSuccess(fp);
        const how = result.outcome === 'submitted' ? 'submitted' : 'held for review';
        emit({ jobId: job?.id, stage: 'apply', message: `Agent replayed a cached plan on ${observation.host} [${shape}] — no model call, ${result.filled.length} field(s), ${how}` });
        return { ...result, planKind: cached.plan.kind, fingerprint: fp, replayed: true };
      }
      // The cached plan no longer fits — record the failure (which will eventually
      // demote it) and fall through to a fresh plan that overwrites it.
      bumpPlanFail(fp);
      emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: `Cached plan for ${observation.host} [${shape}] did not fit — re-planning` });
    }

    // --- Fresh plan from the model -------------------------------------------
    const plan = await planFn(observation, ctx);
    if (!plan || plan.kind === 'unsupported') {
      emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: 'Agent could not produce a usable plan — leaving to capture' });
      return null;
    }

    // A freshly-planned shape has 0 proven successes, so the gate can never let
    // it auto-submit on first sight — it fills, reviews, and earns confidence.
    const result = await executeFn(page, plan, { job, ctx, resumePath, submitGate: makeGate(submit, 0) });
    if (!worked(result.outcome)) {
      emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: `Agent plan did not solve the page — ${result.reason || 'stuck'}` });
      return null;
    }

    // It worked — remember it so the next visit to this shape needs no model.
    savePlan({ fingerprint: fp, host: observation.host, plan });
    const how = result.outcome === 'parked' ? 'parked' : (result.outcome === 'submitted' ? 'submitted' : 'filled');
    emit({
      jobId: job?.id, stage: 'apply',
      message: `Agent ${how} ${result.filled.length} field(s) on ${observation.host} [${shape}] — plan cached`,
    });
    return { ...result, planKind: plan.kind, fingerprint: fp, replayed: false };
  } catch (err) {
    emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: `Agent escalation failed (non-fatal): ${err.message.split('\n')[0]}` });
    return null;
  }
}
