import { EventEmitter } from 'node:events';
import { logEvent } from './db.js';

// Single in-process event bus. The orchestrator publishes; the dashboard's SSE
// endpoint and the WebSocket screencast both subscribe.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

/** Persist to the events table AND push to any connected dashboard. */
export function emit(payload) {
  const row = logEvent(payload);
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
