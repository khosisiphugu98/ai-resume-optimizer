// Run a validated plan (plan.js) against the live page, fill-only.
//
// The plan says WHERE each value goes; resolveFormBatch → guardAnswer still
// decides WHETHER a value is allowed, exactly as in the deterministic adapters.
// submit is forced false, so the wizard stops at the terminal control and
// returns `ready` — it never presses submit. See
// docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE2.md.
import path from 'node:path';
import { runWizard, stepSignature } from '../wizard.js';
import { resolveFormBatch } from '../../answer/resolver.js';

/** First frame where `build(frame)` yields a present, visible locator — or null. */
async function firstFrameLocator(page, build) {
  for (const frame of page.frames()) {
    let loc;
    try { loc = build(frame); } catch { continue; }
    if (!loc) continue;
    const n = await loc.count().catch(() => 0);
    if (n && await loc.first().isVisible().catch(() => false)) return loc.first();
  }
  return null;
}

/** A plan field locator → a Playwright locator builder for one frame. */
function fieldBuilder(loc) {
  return frame => {
    switch (loc.by) {
      case 'label': return frame.getByLabel(loc.value, { exact: false });
      case 'placeholder': return frame.getByPlaceholder(loc.value, { exact: false });
      case 'name': return frame.locator(`[name="${loc.value.replace(/"/g, '\\"')}"]`);
      case 'role': return frame.getByRole('textbox', { name: loc.value });
      case 'text': return frame.getByLabel(loc.value, { exact: false });
      default: return null;
    }
  };
}

/** A plan advance/submit control → a locator builder for one frame. */
function controlBuilder(ctrl) {
  return frame => (ctrl.by === 'text'
    ? frame.getByText(ctrl.value, { exact: false })
    : frame.getByRole('button', { name: ctrl.value }));
}

/** Apply one value to a plan-located control. Returns the landed value. */
async function fillPlanField(item, value) {
  const loc = item.locator;
  switch (item.fieldType) {
    case 'select': await loc.selectOption({ label: String(value) }).catch(async () => { await loc.selectOption(String(value)); }); return value;
    case 'checkbox': if (value === false || /^(no|false|unchecked)$/i.test(String(value))) await loc.uncheck(); else await loc.check(); return value;
    case 'radio': await loc.check(); return value;
    default: await loc.fill(String(value)); return value;
  }
}

/**
 * @returns { outcome, filled, parked, steps } — outcome is 'ready' (reached the
 *          terminal without submitting), 'parked', or 'stuck'.
 */
export async function executePlan(page, plan, { job = null, ctx = {}, resumePath = null } = {}) {
  if (plan.kind === 'unsupported') return { outcome: 'stuck', filled: [], steps: 0, reason: 'planner returned unsupported' };

  // preSteps reveal a form hidden behind a button (landing pages).
  for (const step of plan.preSteps || []) {
    const btn = await firstFrameLocator(page, controlBuilder({ by: 'role', value: step.target }));
    if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(1500); }
  }

  const uploaded = [];
  const uploadedLabels = new Set();

  // Resolve the plan's fields to live locators. File fields are handled here
  // (setInputFiles) rather than through the answer resolver, like external.js.
  const collect = async () => {
    const items = [];
    for (let i = 0; i < plan.fields.length; i++) {
      const f = plan.fields[i];
      const loc = await firstFrameLocator(page, fieldBuilder(f.locator));
      if (!loc) continue;

      if (f.type === 'file') {
        if (resumePath && !uploadedLabels.has(f.label)) {
          uploadedLabels.add(f.label);
          try {
            await loc.setInputFiles(resumePath);
            uploaded.push({ uid: `plan-${i}`, question: f.label, value: path.basename(resumePath), tier: 'resume', kind: 'file' });
            await page.waitForTimeout(1500);
          } catch { /* optional attachment */ }
        }
        continue;
      }

      items.push({
        uid: `plan-${i}`, question: f.label, fieldType: f.type, role: f.type,
        required: f.required, options: [], locator: loc,
      });
    }
    return items;
  };

  const result = await runWizard({
    submit: false,                                   // Phase 2 never submits
    collect,
    resolve: items => resolveFormBatch(items, ctx),
    fill: (item, value) => fillPlanField(item, value),
    findTerminal: () => plan.submit ? firstFrameLocator(page, controlBuilder(plan.submit)) : Promise.resolve(null),
    findAdvance: () => plan.advance ? firstFrameLocator(page, controlBuilder(plan.advance)) : Promise.resolve(null),
    signature: stepSignature,
  });

  return { ...result, filled: [...uploaded, ...(result.filled || [])] };
}
