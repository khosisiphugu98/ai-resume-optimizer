import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logEvent } from './db.js';

// Single in-process event bus. The orchestrator publishes; the dashboard's SSE
// endpoint and the WebSocket screencast both subscribe.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

/**
 * Which run is currently executing, carried implicitly.
 *
 * Every line this pipeline logs is emitted from inside a stage run, but nothing
 * said so: `emit()` is called from about a hundred places across twelve modules,
 * none of which know they are part of a run, and threading a run id through all
 * of them would mean changing every signature between the orchestrator and the
 * field filler.
 *
 * AsyncLocalStorage carries it instead. `withRun()` opens a scope, and every
 * emit inside that scope — however deep, across as many awaits as it likes —
 * picks up the run id without being told. An emit outside any run (the server
 * starting, a manual CLI call) simply has none, which is honest: it wasn't part
 * of one.
 */
const runContext = new AsyncLocalStorage();

/** The run this code is executing inside, or null at the top level. */
export function currentRun() {
  return runContext.getStore() || null;
}

/**
 * Run `fn` as a named run, so everything it logs is grouped under one id.
 *
 * The open and close lines are emitted here rather than by the caller, because
 * a run that crashes must still be closed off in the log — that is precisely the
 * run somebody will go looking for.
 */
export async function withRun(stage, fn, { component = null, trigger = null } = {}) {
  const run = { id: `${stage}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, stage, startedAt: Date.now() };
  return runContext.run(run, async () => {
    emit({ stage, component: component || stage, message: `Started: ${stage}`, data: { trigger } });
    try {
      const out = await fn(run);
      emit({
        stage, component: component || stage, message: `Finished: ${stage}`,
        durationMs: Date.now() - run.startedAt,
        data: { ok: true, ...(out && typeof out === 'object' && !Array.isArray(out) ? { stats: out } : {}) },
      });
      return out;
    } catch (err) {
      emit({
        stage, component: component || stage, level: 'error',
        message: `Failed: ${stage} — ${err.message}`,
        durationMs: Date.now() - run.startedAt,
        data: { ok: false, error: err.message, stack: String(err.stack || '').split('\n').slice(0, 6).join('\n') },
      });
      throw err;
    }
  });
}

/**
 * Persist to the events table AND push to any connected dashboard.
 *
 * `component` and `data` are optional and additive: a caller that passes neither
 * logs exactly what it always logged. `data` is where structured facts go — the
 * numbers and identifiers a query or an export needs — while `message` stays a
 * sentence a person reads.
 */
export function emit(payload) {
  const run = currentRun();
  const row = logEvent({
    ...payload,
    runId: payload.runId ?? run?.id ?? null,
    stage: payload.stage ?? run?.stage ?? null,
  });
  bus.emit('event', { type: 'event', ...row });
  return row;
}

/** Board changed — dashboard should refetch. Not persisted. */
export function emitBoard() {
  bus.emit('event', { type: 'board' });
}

/** Live browser frame (base64 JPEG). Not persisted — too big and too transient. */
export function emitFrame(data) {
  bus.emit('frame', data);
}
