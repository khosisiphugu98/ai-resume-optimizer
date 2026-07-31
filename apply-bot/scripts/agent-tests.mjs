/**
 * Adaptive agent — Phase 2 (planner, fill-only).
 *
 * The promises under test: a plan must pass a real sanity check before it runs;
 * the planner tries Claude first and falls back to gpt-4o on any failure; and
 * the executor fills a plan but NEVER submits. All network-free — the model
 * callers are injected, and the executor runs against a fake page.
 */
import './_sandbox.mjs';   // refuses to run against the real database
import assert from 'node:assert/strict';

import { validatePlan, planPage } from '../src/apply/agent/plan.js';
import { executePlan } from '../src/apply/agent/execute.js';
import { runAgent } from '../src/apply/agent/index.js';
import {
  db, setSetting, getPlan, savePlan, bumpPlanSuccess, bumpPlanFail, PLAN_DEMOTE_AT,
  pinPlanField, deletePlan, hostPlanSuccess,
} from '../src/db.js';
import { normaliseQuestion } from '../src/answer/bank.js';
import { autoSubmitAllowed, AUTOSUBMIT_MIN_SUCCESS } from '../src/apply/agent/gate.js';

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); fail++; }
};

const validPlan = {
  kind: 'form', preSteps: [],
  fields: [{ label: 'Email', type: 'email', required: true, locator: { by: 'label', value: 'Email' } }],
  advance: null, submit: { by: 'role', value: 'Submit' },
};

// ---------------------------------------------------------------------------
console.log('\nplan validation');

await test('a well-formed plan passes', () => {
  assert.equal(validatePlan(validPlan).ok, true);
});

await test('an unknown kind is rejected', () => {
  assert.equal(validatePlan({ ...validPlan, kind: 'wizard' }).ok, false);
});

await test('a hashed-class locator is rejected — plans must use stable handles', () => {
  const p = { ...validPlan, fields: [{ label: 'Email', type: 'email', required: true, locator: { by: 'label', value: '._7e3b9f11' } }] };
  const r = validatePlan(p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /hashed|selector/i);
});

// The selector guard has to separate a CSS selector from a label, and for three
// days it did neither. It asked whether the value *contained* a dot followed by
// two word characters, which threw out the upload and email controls on every
// generic form — both planners rejected the same page in sequence and it went to
// capture unsolved — while passing "div > input" straight through. Both directions
// are pinned here; either one regressing costs applications.
await test('placeholder text that merely contains a dot is a label, not a selector', () => {
  const labels = [
    'Click to upload or drag & drop (.pdf)',
    'you@email.com',
    'Upload your CV (max 5MB, .doc or .docx)',
    'LinkedIn URL (linkedin.com/in/...)',
    'e.g. Jane Smith',
    'What is your notice period? (e.g. 30 days)',
    'Website / portfolio (e.g. github.com/you)',
    'First name',
  ];
  for (const value of labels) {
    const r = validatePlan({ ...validPlan, fields: [{ label: 'X', type: 'text', required: true, locator: { by: 'label', value } }] });
    assert.equal(r.ok, true, `rejected a real label: ${value} (${r.reason})`);
  }
});

await test('anything that is actually a CSS selector is still rejected', () => {
  const selectors = [
    '._7e3b9f11', 'div > input', 'li + a', 'input[name="email"]', '#apply-form',
    '[data-testid="cv"]', 'button.primary', 'button.primary.large', ':nth-child(2)',
    'form#apply', 'field_a1b2c3d4',
  ];
  for (const value of selectors) {
    const r = validatePlan({ ...validPlan, fields: [{ label: 'X', type: 'text', required: true, locator: { by: 'label', value } }] });
    assert.equal(r.ok, false, `accepted a selector: ${value}`);
  }
});

await test('an unknown field type is rejected', () => {
  const p = { ...validPlan, fields: [{ label: 'X', type: 'signature', required: true, locator: { by: 'label', value: 'X' } }] };
  assert.equal(validatePlan(p).ok, false);
});

await test('"unsupported" is a valid verdict, not a malformed plan', () => {
  assert.equal(validatePlan({ kind: 'unsupported', preSteps: [], fields: [], advance: null, submit: null }).ok, true);
});

// ---------------------------------------------------------------------------
console.log('\nplanner provider fallback');

const observation = { host: 'x.test', title: 'Apply', traps: {}, buttons: [], controls: [], frames: [], outline: {} };
const envBefore = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
const restoreEnv = () => {
  for (const [k, v] of [['ANTHROPIC_API_KEY', envBefore.a], ['OPENAI_API_KEY', envBefore.o]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

await test('with a Claude key, a good Claude plan is used (OpenAI never called)', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  delete process.env.OPENAI_API_KEY;
  let openaiCalled = false;
  const plan = await planPage(observation, {
    callClaudeFn: async () => validPlan,
    callOpenAIFn: async () => { openaiCalled = true; return validPlan; },
  });
  assert.deepEqual(plan, validPlan);
  assert.equal(openaiCalled, false);
});

await test('a thrown Claude call falls back to gpt-4o', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENAI_API_KEY = 'sk-test';
  const openaiPlan = { ...validPlan, kind: 'landing' };
  const plan = await planPage(observation, {
    callClaudeFn: async () => { throw new Error('503 overloaded'); },
    callOpenAIFn: async () => openaiPlan,
  });
  assert.equal(plan.kind, 'landing');   // came from the fallback
});

await test('an invalid Claude plan (not just an error) also falls back', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENAI_API_KEY = 'sk-test';
  const bad = { kind: 'form', preSteps: [], fields: [{ label: 'E', type: 'email', required: true, locator: { by: 'label', value: '.hashed_1a2b3c' } }], advance: null, submit: null };
  const plan = await planPage(observation, {
    callClaudeFn: async () => bad,
    callOpenAIFn: async () => validPlan,
  });
  assert.deepEqual(plan, validPlan);
});

await test('with no keys at all, the planner returns null — the caller then captures + throws', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const plan = await planPage(observation, {
    callClaudeFn: async () => validPlan,
    callOpenAIFn: async () => validPlan,
  });
  assert.equal(plan, null);
});

restoreEnv();

// ---------------------------------------------------------------------------
console.log('\nexecutor is fill-only');

function fakeLocator({ visible = true, count = 1, onClick } = {}) {
  const self = {
    count: async () => count,
    first: () => self,
    isVisible: async () => visible,
    click: async () => { if (onClick) onClick(); },
    fill: async () => {}, selectOption: async () => {}, check: async () => {},
    uncheck: async () => {}, setInputFiles: async () => {},
  };
  return self;
}

function fakePage({ onSubmitClick } = {}) {
  const submit = fakeLocator({ onClick: onSubmitClick });
  const miss = () => fakeLocator({ count: 0, visible: false });
  const frame = {
    url: () => 'https://x.test',
    getByLabel: miss, getByPlaceholder: miss, getByText: miss, locator: miss,
    getByRole: (_role, opts) => (opts && opts.name === 'Submit') ? submit : miss(),
    evaluate: async () => [],
  };
  return { frames: () => [frame], url: () => 'https://x.test', waitForTimeout: async () => {} };
}

await test('reaching the terminal does NOT click submit — outcome is ready', async () => {
  let submitClicked = false;
  const page = fakePage({ onSubmitClick: () => { submitClicked = true; } });
  const plan = { kind: 'form', preSteps: [], fields: [], advance: null, submit: { by: 'role', value: 'Submit' } };
  const r = await executePlan(page, plan, { ctx: {} });
  assert.equal(r.outcome, 'ready');
  assert.equal(submitClicked, false, 'the executor pressed submit — it must never submit');
});

await test('an unsupported plan is a clean give-up (stuck), not a crash', async () => {
  const r = await executePlan(fakePage(), { kind: 'unsupported', preSteps: [], fields: [], advance: null, submit: null }, { ctx: {} });
  assert.equal(r.outcome, 'stuck');
});

// ---------------------------------------------------------------------------
console.log('\nescalation gating');

await test('the agent is off by default — runAgent short-circuits to null', async () => {
  // agent_enabled is unset in the throwaway test DB, so this returns before it
  // ever touches the page.
  const r = await runAgent(/* page */ {}, { stage: 'no-form', reason: 'test' });
  assert.equal(r, null);
});

// ---------------------------------------------------------------------------
console.log('\nlearned plan cache (Phase 3)');

const resetPlans = () => db.exec('DELETE FROM page_plans');

await test('a saved plan round-trips, and a re-save overwrites and resets counters', () => {
  resetPlans();
  savePlan({ fingerprint: 'fp-A', host: 'x.test', plan: validPlan });
  assert.deepEqual(getPlan('fp-A').plan, validPlan);
  bumpPlanSuccess('fp-A'); bumpPlanFail('fp-A');
  const other = { ...validPlan, kind: 'landing' };
  savePlan({ fingerprint: 'fp-A', host: 'x.test', plan: other });
  const row = getPlan('fp-A');
  assert.equal(row.plan.kind, 'landing');
  assert.equal(row.success_count, 0);   // reset on re-solve
  assert.equal(row.fail_count, 0);
});

await test('a plan that keeps failing without a winning majority is withheld (demoted)', () => {
  resetPlans();
  savePlan({ fingerprint: 'fp-B', host: 'x.test', plan: validPlan });
  for (let i = 0; i < PLAN_DEMOTE_AT; i++) bumpPlanFail('fp-B');
  assert.equal(getPlan('fp-B'), null, 'a demoted plan must not be served');
});

await test('a plan with more successes than failures is still served', () => {
  resetPlans();
  savePlan({ fingerprint: 'fp-C', host: 'x.test', plan: validPlan });
  for (let i = 0; i < PLAN_DEMOTE_AT + 2; i++) bumpPlanSuccess('fp-C');
  for (let i = 0; i < PLAN_DEMOTE_AT; i++) bumpPlanFail('fp-C');
  assert.ok(getPlan('fp-C'), 'a mostly-winning plan should keep being replayed');
});

await test('runAgent replays a cached plan with NO model call', async () => {
  resetPlans();
  setSetting('agent_enabled', '1');
  savePlan({ fingerprint: 'fp-REPLAY', host: 'x.test', plan: validPlan });
  let plannerCalls = 0;
  const r = await runAgent({}, { stage: 'no-form', reason: 't' }, {
    observeFn: async () => ({ host: 'x.test', fingerprint: 'fp-REPLAY' }),
    planFn: async () => { plannerCalls++; return validPlan; },
    executeFn: async () => ({ outcome: 'ready', filled: [{ uid: 'plan-0' }], steps: 1 }),
  });
  assert.equal(plannerCalls, 0, 'the planner (LLM) must not run when a cached plan fits');
  assert.equal(r.replayed, true);
  assert.equal(getPlan('fp-REPLAY').success_count, 1);
});

await test('a cached plan that no longer fits is re-planned, and the new plan is cached', async () => {
  resetPlans();
  setSetting('agent_enabled', '1');
  savePlan({ fingerprint: 'fp-STALE', host: 'x.test', plan: validPlan });
  let plannerCalls = 0, execCalls = 0;
  const freshPlan = { ...validPlan, kind: 'landing' };
  const r = await runAgent({}, { stage: 'no-form', reason: 't' }, {
    observeFn: async () => ({ host: 'x.test', fingerprint: 'fp-STALE' }),
    planFn: async () => { plannerCalls++; return freshPlan; },
    // First call (cached plan) is stuck; second call (fresh plan) succeeds.
    executeFn: async () => (++execCalls === 1
      ? { outcome: 'stuck', filled: [], steps: 1, reason: 'did not fit' }
      : { outcome: 'ready', filled: [], steps: 1 }),
  });
  assert.equal(plannerCalls, 1, 'a stale cached plan must trigger exactly one re-plan');
  assert.equal(r.replayed, false);
  assert.equal(getPlan('fp-STALE').plan.kind, 'landing', 'the fresh plan overwrites the stale one');
});

// ---------------------------------------------------------------------------
console.log('\noperator feedback (Phase 4)');

await test('a pin round-trips and a re-plan forgets the plan', () => {
  resetPlans();
  savePlan({ fingerprint: 'fp-PIN', host: 'x.test', plan: validPlan });
  assert.equal(pinPlanField('fp-PIN', normaliseQuestion('Email'), 'k@fixed.test'), true);
  assert.equal(getPlan('fp-PIN').pins[normaliseQuestion('Email')], 'k@fixed.test');
  assert.equal(pinPlanField('fp-UNKNOWN', 'q', 'v'), false);
  assert.equal(deletePlan('fp-PIN'), true);
  assert.equal(getPlan('fp-PIN'), null);
});

await test('an operator pin fills the field directly, bypassing the resolver (tier operator)', async () => {
  const pinned = 'k@corrected.test';
  let filledValue = null;
  const emailLoc = fakeLocator({});
  emailLoc.fill = async v => { filledValue = v; };
  const page = {
    frames: () => [{
      url: () => 'https://x.test',
      getByLabel: (v) => v === 'Email' ? emailLoc : fakeLocator({ count: 0, visible: false }),
      getByPlaceholder: () => fakeLocator({ count: 0 }), getByText: () => fakeLocator({ count: 0, visible: false }),
      locator: () => fakeLocator({ count: 0, visible: false }),
      getByRole: (_r, o) => (o && o.name === 'Submit') ? fakeLocator({}) : fakeLocator({ count: 0, visible: false }),
      evaluate: async () => [],
    }],
    url: () => 'https://x.test', waitForTimeout: async () => {},
  };
  const plan = { kind: 'form', preSteps: [], fields: [{ label: 'Email', type: 'text', required: true, locator: { by: 'label', value: 'Email' } }], advance: null, submit: { by: 'role', value: 'Submit' } };
  const r = await executePlan(page, plan, { ctx: {}, pins: { [normaliseQuestion('Email')]: pinned } });
  assert.equal(filledValue, pinned, 'the pinned value was typed into the field');
  const op = r.filled.find(f => f.question === 'Email');
  assert.equal(op.tier, 'operator');
  assert.equal(op.value, pinned);
});

// ---------------------------------------------------------------------------
console.log('\nconfident auto-submit gate (Phase 5)');

const groundedFill = [{ tier: 'profile' }, { tier: 'bank-exact' }, { tier: 'operator' }];
const okGate = { submitIntent: true, planSuccessCount: AUTOSUBMIT_MIN_SUCCESS, filled: groundedFill, parked: [] };

await test('passes only when submit intent + proven plan + all grounded + nothing parked', () => {
  assert.equal(autoSubmitAllowed(okGate), true);
});
await test('no submit intent blocks (review mode never submits)', () => {
  assert.equal(autoSubmitAllowed({ ...okGate, submitIntent: false }), false);
});
await test('an unproven plan (too few successes) blocks', () => {
  assert.equal(autoSubmitAllowed({ ...okGate, planSuccessCount: AUTOSUBMIT_MIN_SUCCESS - 1 }), false);
});
await test('any ungrounded model value (llm) blocks', () => {
  assert.equal(autoSubmitAllowed({ ...okGate, filled: [...groundedFill, { tier: 'llm' }] }), false);
});
await test('a fuzzy/probable answer blocks', () => {
  assert.equal(autoSubmitAllowed({ ...okGate, filled: [{ tier: 'bank-fuzzy', probable: true }] }), false);
});
await test('a parked (unanswerable/guarded) field blocks', () => {
  assert.equal(autoSubmitAllowed({ ...okGate, parked: [{ question: 'x' }] }), false);
});

function fakeSubmitPage({ onSubmit, confirmText = 'Thank you for applying' } = {}) {
  const submit = fakeLocator({ onClick: onSubmit });
  const miss = () => fakeLocator({ count: 0, visible: false });
  const frame = {
    url: () => 'https://x.test',
    getByLabel: miss, getByPlaceholder: miss, getByText: miss, locator: miss,
    getByRole: (_r, o) => (o && o.name === 'Submit') ? submit : miss(),
    evaluate: async () => [],
  };
  return {
    frames: () => [frame], url: () => 'https://x.test', waitForTimeout: async () => {},
    locator: sel => ({ innerText: async () => (sel === 'body' ? confirmText : '') }),
  };
}
const submitOnlyPlan = { kind: 'form', preSteps: [], fields: [], advance: null, submit: { by: 'role', value: 'Submit' } };

await test('executePlan presses submit and reports submitted when the gate allows it', async () => {
  let clicked = false;
  const page = fakeSubmitPage({ onSubmit: () => { clicked = true; } });
  const r = await executePlan(page, submitOnlyPlan, { ctx: {}, submitGate: () => true });
  assert.equal(clicked, true);
  assert.equal(r.outcome, 'submitted');
});

await test('executePlan never clicks submit when the gate refuses — stays fill-only (ready)', async () => {
  let clicked = false;
  const page = fakeSubmitPage({ onSubmit: () => { clicked = true; } });
  const r = await executePlan(page, submitOnlyPlan, { ctx: {}, submitGate: () => false });
  assert.equal(clicked, false, 'the gate said no — submit must not be pressed');
  assert.equal(r.outcome, 'ready');
});

await test('runAgent auto-submits a proven, grounded replay; a 0-success shape does not', async () => {
  resetPlans();
  setSetting('agent_enabled', '1');
  // The injected executor consults the real gate runAgent builds and reports back.
  const execViaGate = async (_page, _plan, opts) => (await opts.submitGate([{ tier: 'profile' }], [])
    ? { outcome: 'submitted', filled: [{ tier: 'profile' }], steps: 1 }
    : { outcome: 'ready', filled: [{ tier: 'profile' }], steps: 1 });

  savePlan({ fingerprint: 'fp-PROVEN', host: 'x.test', plan: validPlan });
  for (let i = 0; i < AUTOSUBMIT_MIN_SUCCESS; i++) bumpPlanSuccess('fp-PROVEN');
  const proven = await runAgent({}, { stage: 'stuck', reason: 't', submit: true }, {
    observeFn: async () => ({ host: 'x.test', fingerprint: 'fp-PROVEN' }), executeFn: execViaGate,
  });
  assert.equal(proven.outcome, 'submitted');

  savePlan({ fingerprint: 'fp-NEW', host: 'x.test', plan: validPlan });   // 0 successes
  const fresh = await runAgent({}, { stage: 'stuck', reason: 't', submit: true }, {
    observeFn: async () => ({ host: 'x.test', fingerprint: 'fp-NEW' }), executeFn: execViaGate,
  });
  assert.equal(fresh.outcome, 'ready', 'an unproven shape must not auto-submit even with intent');
});

setSetting('agent_enabled', '0');   // leave the switch as a fresh install would


// The ramp was unreachable in production: savePlan writes success_count = 0 and
// nothing bumped it on the first success, while the fingerprint (host + every
// control's role:name) never repeated — 17 captures produced 17 distinct
// fingerprints. A counter keyed on something that never recurs reads zero
// forever, so AUTOSUBMIT_MIN_SUCCESS could never be met.
await test('confidence accrues per site, but only vouches for a shape already proven', async () => {
  resetPlans();
  setSetting('agent_enabled', '1');
  const execViaGate = async (_page, _plan, opts) => (await opts.submitGate([{ tier: 'profile' }], [])
    ? { outcome: 'submitted', filled: [{ tier: 'profile' }], steps: 1 }
    : { outcome: 'ready', filled: [{ tier: 'profile' }], steps: 1 });

  // Spread the site's successes across several shapes, as real postings do.
  for (const fp of ['a', 'b', 'c']) {
    savePlan({ fingerprint: fp, host: 'many.test', plan: validPlan });
    bumpPlanSuccess(fp);
  }
  assert.equal(hostPlanSuccess('many.test'), 3, 'the site has earned three successes');
  assert.equal(getPlan('a').success_count, 1, 'no single shape reaches the threshold alone');

  // A shape with one success of its own, on a site at the threshold: submits.
  const known = await runAgent({}, { stage: 'stuck', reason: 't', submit: true }, {
    observeFn: async () => ({ host: 'many.test', fingerprint: 'a' }), executeFn: execViaGate,
  });
  assert.equal(known.outcome, 'submitted');

  // Same site, a shape that has never worked: held, despite the site's record.
  savePlan({ fingerprint: 'unseen', host: 'many.test', plan: validPlan });
  const unseen = await runAgent({}, { stage: 'stuck', reason: 't', submit: true }, {
    observeFn: async () => ({ host: 'many.test', fingerprint: 'unseen' }), executeFn: execViaGate,
  });
  assert.equal(unseen.outcome, 'ready', "a site's record must not vouch for an unproven shape");

  // A different site with no history: held.
  savePlan({ fingerprint: 'other', host: 'fresh.test', plan: validPlan });
  bumpPlanSuccess('other');
  const otherSite = await runAgent({}, { stage: 'stuck', reason: 't', submit: true }, {
    observeFn: async () => ({ host: 'fresh.test', fingerprint: 'other' }), executeFn: execViaGate,
  });
  assert.equal(otherSite.outcome, 'ready', 'a site with one success is not yet proven');
});

// A working plan used to be recorded as unproven, so the ramp started a visit
// further back than it should.
await test('a plan that works on first sight is credited immediately', async () => {
  resetPlans();
  setSetting('agent_enabled', '1');
  const r = await runAgent({}, { stage: 'stuck', reason: 't', submit: false }, {
    observeFn: async () => ({ host: 'new.test', fingerprint: 'fp-FIRST' }),
    planFn: async () => validPlan,
    executeFn: async () => ({ outcome: 'ready', filled: [{ tier: 'profile' }], steps: 1 }),
  });
  assert.equal(r.replayed, false);
  assert.equal(getPlan('fp-FIRST').success_count, 1, 'the first success must be recorded');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
