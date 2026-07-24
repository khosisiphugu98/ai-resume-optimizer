// The adaptive agent's escalation entry point (Phase 2, fill-only).
//
// Called by applyExternal at each point where the deterministic flow would give
// up. Observes the page, asks the planner for a structured plan, and runs it
// fill-only. Returns a filled/parked result the review queue can show, or null
// to let the caller capture the page (Phase 1) and throw exactly as today.
//
// Off by default: the `agent_enabled` setting is the switch. Best-effort by
// contract — any failure returns null and never changes the deterministic
// outcome. See docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE2.md.
import { getSetting } from '../../db.js';
import { emit } from '../../bus.js';
import { observePage } from './observe.js';
import { planPage } from './plan.js';
import { executePlan } from './execute.js';

export function agentEnabled() {
  return getSetting('agent_enabled') === '1';
}

/**
 * @returns null, or { outcome: 'ready'|'parked', filled, parked, steps, planKind, fingerprint }
 */
export async function runAgent(page, { job = null, ctx = {}, resumePath = null, stage = '', reason = '' } = {}) {
  if (!agentEnabled()) return null;

  try {
    emit({ jobId: job?.id, stage: 'apply', message: `Agent escalation (${stage}) — ${reason}` });

    const observation = await observePage(page);
    const plan = await planPage(observation, ctx);
    if (!plan || plan.kind === 'unsupported') {
      emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: 'Agent could not produce a usable plan — leaving to capture' });
      return null;
    }

    const result = await executePlan(page, plan, { job, ctx, resumePath });
    if (result.outcome === 'stuck') {
      emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: `Agent plan did not solve the page — ${result.reason || 'stuck'}` });
      return null;
    }

    emit({
      jobId: job?.id, stage: 'apply',
      message: `Agent ${result.outcome === 'parked' ? 'parked' : 'filled'} ${result.filled.length} field(s) on ${observation.host} [${observation.fingerprint.slice(0, 8)}] — held for review`,
    });
    return { ...result, planKind: plan.kind, fingerprint: observation.fingerprint };
  } catch (err) {
    emit({ jobId: job?.id, stage: 'apply', level: 'warn', message: `Agent escalation failed (non-fatal): ${err.message.split('\n')[0]}` });
    return null;
  }
}
