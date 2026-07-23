/**
 * The autonomous supervisor loop.
 *
 * `npm run run` does a single discover/enrich pass and stops; this is the thing
 * that keeps the whole pipeline moving on its own until the kill switch goes on.
 * It sequences the stages in dependency order, sleeps a configurable interval,
 * and repeats.
 *
 * It deliberately owns none of the policy. Daily caps, operating hours, run mode
 * and the STOP kill switch are all enforced inside the individual stages, so the
 * loop only sequences and paces them — it never decides whether an application is
 * allowed. Two things it does own:
 *
 *   · The single browser profile has one owner, so stages never run concurrently.
 *     Every stage goes through the same `running` lock the dashboard buttons use
 *     (injected as `runStage`); if a manual stage is in flight the loop waits it
 *     out rather than colliding with it.
 *   · STOP pauses the loop, it does not end it. Clearing the kill switch resumes
 *     the same loop, which matches `npm run resume`.
 */
import { getSetting } from './db.js';
import { emit } from './bus.js';
import { stopRequested } from './browser.js';

// Full pipeline, in dependency order. Each stage reads the rows the previous one
// produced (discovered → enriched → scored → tailored → applied), and `replies`
// closes the loop by checking for responses to what already went out.
export const PIPELINE = ['discover', 'enrich', 'score', 'tailor', 'apply', 'email', 'replies'];

export const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 60_000;

// One granularity for every wait: how often the loop re-checks the kill switch
// while paused, how long it backs off when a manual stage holds the lock, and the
// step it sleeps the between-cycle interval in so a stop is felt within a tick
// rather than after fifteen minutes.
const TICK_MS = 5_000;

/** Between-cycle interval, read fresh each cycle so a dashboard change applies next pass. */
export function autoIntervalMs() {
  const v = Number(getSetting('auto_interval_ms', DEFAULT_INTERVAL_MS));
  return Number.isFinite(v) && v >= MIN_INTERVAL_MS ? v : DEFAULT_INTERVAL_MS;
}

const realSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Build a loop controller.
 *
 * `runStage(stage)` must resolve to `{ ran }` — `ran: false` meaning the shared
 * lock was held by something else, which is the signal to wait and retry rather
 * than skip the stage. Everything else is injectable so the loop can be tested
 * with fake stages, an instant clock and a scripted kill switch.
 */
export function createOrchestrator({
  runStage,
  pipeline = PIPELINE,
  interval = autoIntervalMs,
  isStopped = stopRequested,
  log = emit,
  sleep = realSleep,
} = {}) {
  const intervalMs = typeof interval === 'function' ? interval : () => interval;

  let looping = false;    // the loop is live
  let cancelled = false;  // stop() was called; unwind at the next check

  /** Idle here while the kill switch is on, so clearing it resumes the same loop. */
  async function pause() {
    log({ stage: 'auto', level: 'warn', message: 'Kill switch on — autonomous loop paused. Clear it to resume.' });
    while (isStopped() && !cancelled) await sleep(TICK_MS);
    if (!cancelled) log({ stage: 'auto', message: 'Kill switch cleared — resuming autonomous loop.' });
  }

  /** Run one stage, waiting out any manual stage that holds the lock first. */
  async function runOne(stage) {
    for (;;) {
      if (cancelled) return;
      if (isStopped()) { await pause(); if (cancelled) return; }
      const res = await runStage(stage);
      if (!res || res.ran !== false) return;   // ran (or errored inside) — done with this stage
      await sleep(TICK_MS);                     // lock was busy — back off and retry
    }
  }

  async function cycle() {
    for (const stage of pipeline) {
      if (cancelled) return;
      await runOne(stage);
    }
  }

  /** Sleep the between-cycle interval in ticks so a stop is felt within a tick. */
  async function waitInterval() {
    const total = intervalMs();
    for (let waited = 0; waited < total && !cancelled; waited += TICK_MS) {
      await sleep(Math.min(TICK_MS, total - waited));
    }
  }

  async function loop() {
    const mins = Math.max(1, Math.round(intervalMs() / 60_000));
    log({ stage: 'auto', message: `Autonomous loop started — full pipeline, then a pass every ${mins} min until stopped.` });
    while (!cancelled) {
      await cycle();
      if (cancelled) break;
      const mid = Math.max(1, Math.round(intervalMs() / 60_000));
      log({ stage: 'auto', message: `Cycle complete — next pass in ${mid} min. STOP or the dashboard toggle halts it.` });
      await waitInterval();
    }
    looping = false;
    log({ stage: 'auto', message: 'Autonomous loop stopped.' });
  }

  return {
    /** Start looping. Returns false if already running (idempotent). */
    start() {
      if (looping) return false;
      looping = true;
      cancelled = false;
      loop().catch(err => {
        looping = false;
        log({ stage: 'auto', level: 'error', message: `Autonomous loop crashed: ${err.message}` });
      });
      return true;
    },
    /** Ask the loop to unwind. It stops at the next stage boundary or tick. */
    stop() { cancelled = true; },
    get active() { return looping; },
  };
}
