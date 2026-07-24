/**
 * Adaptive agent — Phase 2 (planner, fill-only).
 *
 * The promises under test: a plan must pass a real sanity check before it runs;
 * the planner tries Claude first and falls back to gpt-4o on any failure; and
 * the executor fills a plan but NEVER submits. All network-free — the model
 * callers are injected, and the executor runs against a fake page.
 */
import assert from 'node:assert/strict';

import { validatePlan, planPage } from '../src/apply/agent/plan.js';
import { executePlan } from '../src/apply/agent/execute.js';
import { runAgent } from '../src/apply/agent/index.js';

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

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
