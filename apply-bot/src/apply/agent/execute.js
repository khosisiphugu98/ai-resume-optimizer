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
import { normaliseQuestion } from '../../answer/bank.js';
import { matchOption } from '../../answer/options.js';

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

/**
 * The ARIA role a planned field type is actually exposed as.
 *
 * `by: 'role'` used to build `getByRole('textbox')` whatever the field was, so
 * a plan naming a radio group, a select or a checkbox could never locate it —
 * the executor looked for a textbox with that accessible name and found
 * nothing. On job 280 Claude correctly identified all six controls, three of
 * them radio groups, and the plan still failed as "form did not advance"
 * because half of what it had found was unreachable.
 */
const ROLE_FOR_TYPE = {
  select: 'combobox',
  radio: 'radiogroup',
  checkbox: 'checkbox',
  date: 'textbox',
  textarea: 'textbox',
};

/** A plan field locator → a Playwright locator builder for one frame. */
function fieldBuilder(loc, type = 'text') {
  const role = ROLE_FOR_TYPE[type] || 'textbox';
  return frame => {
    switch (loc.by) {
      case 'label': return frame.getByLabel(loc.value, { exact: false });
      case 'placeholder': return frame.getByPlaceholder(loc.value, { exact: false });
      case 'name': return frame.locator(`[name="${loc.value.replace(/"/g, '\\"')}"]`);
      case 'role': return frame.getByRole(role, { name: loc.value });
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

/**
 * Select by label, then by value, then by whichever option the answer actually
 * means. The planner describes a field before the page is open, so it never sees
 * the option list and answers in its own words — which is the one place a
 * semantic fit has to happen at fill time rather than in the resolver.
 */
async function selectClosest(loc, value) {
  const v = String(value);
  try { await loc.selectOption({ label: v }); return v; } catch { /* try the value attribute */ }
  try { await loc.selectOption(v); return v; } catch { /* fall through to matching */ }

  const labels = (await loc.locator('option').allTextContents()).map(t => t.trim()).filter(Boolean);
  const m = matchOption(v, labels, { semantic: true });
  if (!m) throw new Error(`"${v}" is not one of: ${labels.join(' | ')}`);
  await loc.selectOption({ label: m.option });
  return m.option;
}

/**
 * Check the option a value names, inside the group the plan located.
 *
 * `loc.check()` was called straight on the located element, which is right only
 * when the plan happened to point at one radio. A plan describes a *question*,
 * so the locator is the group — and checking a group does nothing.
 */
async function checkRadio(loc, value) {
  const v = String(value);

  const named = loc.getByRole('radio', { name: v }).first();
  if (await named.count().catch(() => 0)) { await named.check({ force: true }); return v; }

  const radios = loc.getByRole('radio');
  const n = await radios.count().catch(() => 0);
  // No radios inside it means the plan pointed at one, not at the group.
  if (!n) { await loc.check({ force: true }); return v; }

  const labels = [];
  for (let i = 0; i < n; i++) {
    const r = radios.nth(i);
    const label = (await r.getAttribute('aria-label').catch(() => null))
      || (await r.getAttribute('value').catch(() => null)) || '';
    labels.push(label.trim());
  }
  const m = matchOption(v, labels, { semantic: true });
  if (!m) throw new Error(`"${v}" is not one of: ${labels.join(' | ')}`);
  await radios.nth(m.index).check({ force: true });
  return m.option;
}

/** Apply one value to a plan-located control. Returns the landed value. */
async function fillPlanField(item, value) {
  const loc = item.locator;
  switch (item.fieldType) {
    case 'select': return await selectClosest(loc, value);
    case 'checkbox': if (value === false || /^(no|false|unchecked)$/i.test(String(value))) await loc.uncheck(); else await loc.check(); return value;
    case 'radio': return await checkRadio(loc, value);
    default: await loc.fill(String(value)); return value;
  }
}

/**
 * @returns { outcome, filled, parked, steps } — outcome is 'ready' (reached the
 *          terminal without submitting), 'parked', or 'stuck'.
 */
export async function executePlan(page, plan, { job = null, ctx = {}, resumePath = null, pins = {}, submitGate = null } = {}) {
  if (plan.kind === 'unsupported') return { outcome: 'stuck', filled: [], steps: 0, reason: 'planner returned unsupported' };

  // preSteps reveal a form hidden behind a button (landing pages).
  for (const step of plan.preSteps || []) {
    const btn = await firstFrameLocator(page, controlBuilder({ by: 'role', value: step.target }));
    if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(1500); }
  }

  const uploaded = [];
  const uploadedLabels = new Set();
  const pinnedFilled = [];
  const pinnedLabels = new Set();

  // Resolve the plan's fields to live locators. File fields are handled here
  // (setInputFiles) rather than through the answer resolver, like external.js.
  const collect = async () => {
    const items = [];
    for (let i = 0; i < plan.fields.length; i++) {
      const f = plan.fields[i];
      const loc = await firstFrameLocator(page, fieldBuilder(f.locator, f.type));
      if (!loc) continue;

      // Operator pin (Phase 4): a corrected answer for this vendor shape outranks
      // the resolver — fill it directly and never ask the model.
      const norm = normaliseQuestion(f.label);
      if (pins[norm] != null && !pinnedLabels.has(f.label)) {
        pinnedLabels.add(f.label);
        try {
          await fillPlanField({ locator: loc, fieldType: f.type }, pins[norm]);
          pinnedFilled.push({ uid: `plan-${i}`, question: f.label, value: pins[norm], tier: 'operator', kind: f.type });
        } catch { /* a pin that won't apply just falls through to review */ }
        continue;
      }

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
    // Fill-only unless a submit gate is supplied (Phase 5). Even then the wizard
    // only *reaches* the terminal and hands it back — the gate below decides
    // whether it is actually pressed.
    submit: !!submitGate,
    collect,
    resolve: items => resolveFormBatch(items, ctx),
    fill: (item, value) => fillPlanField(item, value),
    findTerminal: () => plan.submit ? firstFrameLocator(page, controlBuilder(plan.submit)) : Promise.resolve(null),
    findAdvance: () => plan.advance ? firstFrameLocator(page, controlBuilder(plan.advance)) : Promise.resolve(null),
    signature: stepSignature,
  });

  const filled = [...uploaded, ...pinnedFilled, ...(result.filled || [])];

  // Reached the terminal with submit intent: the gate decides whether to press it.
  if (result.outcome === 'submit') {
    // Awaited: the gate is a policy check today and a pre-send review tomorrow,
    // and a synchronous call would have silently treated a pending Promise as
    // "allowed" the moment either one needed to do I/O.
    if (!await submitGate(filled, result.parked || [])) return { outcome: 'ready', filled, steps: result.steps };
    const before = page.url();
    await result.terminal.click();
    await page.waitForTimeout(4000);
    const body = await page.locator('body').innerText().catch(() => '');
    const confirmed = page.url() !== before
      || /thank you|application (received|submitted|complete)|we('?ve| have) received|submitted successfully/i.test(body);
    // Only claim 'submitted' on real confirmation — otherwise hold for review
    // rather than report an application that may not have gone through.
    return { outcome: confirmed ? 'submitted' : 'ready', filled, steps: result.steps, evidence: null };
  }

  return { ...result, filled };
}
