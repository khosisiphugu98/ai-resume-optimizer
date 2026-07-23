/**
 * Autonomous-loop tests.
 *
 * The loop owns no policy — caps, hours and mode live in the stages — so what has
 * to be pinned down here is the sequencing: that it runs the pipeline in order and
 * on repeat, that STOP pauses it rather than ending it, that it waits out a held
 * lock instead of skipping a stage, and that stop() actually unwinds it. All of
 * that is exercised with fake stages, an instant clock and a scripted kill switch,
 * so the suite is deterministic and touches nothing real.
 */
import assert from 'node:assert/strict';
import { createOrchestrator, PIPELINE } from '../src/orchestrator.js';

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.stack || err.message}`); fail++; }
};

// Yield to the macrotask queue so the loop's promise chain can advance, then poll
// until it has unwound. Every scenario below stops itself, so this always settles.
const tick = () => new Promise(r => setImmediate(r));
async function waitIdle(ctl, max = 100_000) {
  for (let i = 0; i < max; i++) { if (!ctl.active) return; await tick(); }
  throw new Error('loop never went idle');
}

// A fast, quiet harness. interval short so a between-cycle wait is a single tick;
// sleep yields to the macrotask queue (rather than resolving as a microtask) so a
// loop that parks on STOP still lets this test's own stop() land; log is swallowed.
const yieldTick = () => new Promise(r => setImmediate(r));
const base = { interval: 5_000, sleep: yieldTick, log: () => {} };

console.log('\norchestrator');

await test('runs the full pipeline in dependency order, once', async () => {
  const calls = [];
  let ctl;
  ctl = createOrchestrator({
    ...base,
    isStopped: () => false,
    runStage: async stage => {
      calls.push(stage);
      if (stage === 'replies') ctl.stop();   // one full cycle, then unwind
      return { ran: true };
    },
  });
  ctl.start();
  await waitIdle(ctl);
  assert.deepEqual(calls, PIPELINE);
});

await test('loops more than once until stopped', async () => {
  const calls = [];
  let cycles = 0, ctl;
  ctl = createOrchestrator({
    ...base,
    isStopped: () => false,
    runStage: async stage => {
      calls.push(stage);
      if (stage === 'replies' && ++cycles === 2) ctl.stop();
      return { ran: true };
    },
  });
  ctl.start();
  await waitIdle(ctl);
  assert.equal(calls.length, PIPELINE.length * 2);
  assert.deepEqual(calls.slice(0, PIPELINE.length), PIPELINE);
  assert.deepEqual(calls.slice(PIPELINE.length), PIPELINE);
});

await test('STOP pauses the loop, then it resumes when the switch clears', async () => {
  const calls = [];
  let stopped = true, sleeps = 0, ctl;
  ctl = createOrchestrator({
    ...base,
    isStopped: () => stopped,
    // While parked the loop only sleeps; clear the switch after a few polls.
    sleep: () => { if (++sleeps >= 3) stopped = false; return yieldTick(); },
    runStage: async stage => {
      calls.push(stage);
      if (stage === 'replies') ctl.stop();
      return { ran: true };
    },
  });
  ctl.start();
  await waitIdle(ctl);
  assert.ok(sleeps >= 3, 'should have parked and polled the kill switch');
  assert.deepEqual(calls, PIPELINE, 'no stage runs while parked; all run once cleared');
});

await test('waits out a held lock and retries the same stage rather than skipping it', async () => {
  const calls = [];
  let firstDiscover = true, ctl;
  ctl = createOrchestrator({
    ...base,
    isStopped: () => false,
    runStage: async stage => {
      calls.push(stage);
      // First discover reports the lock is busy — the loop must come back to it.
      if (stage === 'discover' && firstDiscover) { firstDiscover = false; return { ran: false }; }
      if (stage === 'replies') ctl.stop();
      return { ran: true };
    },
  });
  ctl.start();
  await waitIdle(ctl);
  assert.deepEqual(calls, ['discover', ...PIPELINE], 'discover attempted twice, no stage skipped');
});

await test('start() is idempotent while already looping', async () => {
  let ctl;
  let releases;
  const gate = new Promise(r => { releases = r; });
  ctl = createOrchestrator({
    ...base,
    isStopped: () => false,
    runStage: async () => { await gate; return { ran: true }; },   // park on the first stage
  });
  assert.equal(ctl.start(), true, 'first start takes');
  assert.equal(ctl.active, true);
  assert.equal(ctl.start(), false, 'second start is a no-op');
  ctl.stop();
  releases({ ran: true });
  await waitIdle(ctl);
});

await test('stop() unwinds a loop that is parked on STOP', async () => {
  let ctl;
  ctl = createOrchestrator({
    ...base,
    isStopped: () => true,                       // parked forever unless stopped
    runStage: async () => ({ ran: true }),
  });
  ctl.start();
  await tick(); await tick();
  assert.equal(ctl.active, true, 'still parked');
  ctl.stop();
  await waitIdle(ctl);
});

console.log(fail ? `\n${fail} failed\n` : `\n${pass} passed\n`);
process.exit(fail ? 1 : 0);
