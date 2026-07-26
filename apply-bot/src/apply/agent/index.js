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

export function agentEnabled() {
  return getSetting('agent_enabled') === '1';
}

// A plan "worked" structurally if it reached the terminal (ready) or filled and
// then parked an unanswerable field — either way its locators fit the page. Only
// 'stuck' means the plan didn't fit.
const solved = outcome => outcome === 'ready' || outcome === 'parked';

/**
 * @returns null, or { outcome: 'ready'|'parked', filled, parked, steps, planKind, fingerprint, replayed }
 */
export async function runAgent(page, { job = null, ctx = {}, resumePath = null, stage = '', reason = '' } = {}, deps = {}) {
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
      const result = await executeFn(page, cached.plan, { job, ctx, resumePath, pins: cached.pins });
      if (solved(result.outcome)) {
        bumpPlanSuccess(fp);
        emit({ jobId: job?.id, stage: 'apply', message: `Agent replayed a cached plan on ${observation.host} [${shape}] — no model call, ${result.filled.length} field(s), held for review` });
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

    const result = await executeFn(page, plan, { job, ctx, resumePath });
    if (!solved(result.outcome)) {
      emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: `Agent plan did not solve the page — ${result.reason || 'stuck'}` });
      return null;
    }

    // It worked — remember it so the next visit to this shape needs no model.
    savePlan({ fingerprint: fp, host: observation.host, plan });
    emit({
      jobId: job?.id, stage: 'apply',
      message: `Agent ${result.outcome === 'parked' ? 'parked' : 'filled'} ${result.filled.length} field(s) on ${observation.host} [${shape}] — plan cached, held for review`,
    });
    return { ...result, planKind: plan.kind, fingerprint: fp, replayed: false };
  } catch (err) {
    emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: `Agent escalation failed (non-fatal): ${err.message.split('\n')[0]}` });
    return null;
  }
}
