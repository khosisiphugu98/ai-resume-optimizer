import { CAPS, HOURS, PATHS } from '../config.js';
import { todayRates, bumpRate, getSetting } from '../db.js';
import fs from 'node:fs';

export const CHANNELS = ['linkedin_easy', 'external_ats', 'email'];

/**
 * Only linkedin_easy carries LinkedIn ban risk, so the caps are per-channel
 * rather than one shared budget (plan §8.1). Throttling a Greenhouse form or an
 * emailed CV buys nothing and costs volume.
 */
export function capRemaining(channel) {
  const rates = todayRates();
  return Math.max(0, (CAPS[channel] ?? 0) - (rates[channel] ?? 0));
}

/** Local-time operating window. Outside it, work is deferred rather than dropped. */
export function withinHours(now = new Date()) {
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
  const day = local.getDay();
  if (HOURS.weekdaysOnly && (day === 0 || day === 6)) return { ok: false, reason: 'outside operating days (weekend)' };
  const h = local.getHours();
  if (h < HOURS.start || h >= HOURS.end) return { ok: false, reason: `outside operating hours (${HOURS.start}:00–${HOURS.end}:00 SAST)` };
  return { ok: true };
}

/** Every gate that must pass before an application is attempted. */
export function canApply(channel, { ignoreHours = false } = {}) {
  if (fs.existsSync(PATHS.stop)) return { ok: false, reason: 'STOP file present' };

  const rates = todayRates();
  if (rates.challenges_hit > 0) {
    return { ok: false, reason: 'a LinkedIn challenge was hit today — halted until manually cleared' };
  }

  if (!ignoreHours) {
    const hrs = withinHours();
    if (!hrs.ok) return hrs;
  }

  const left = capRemaining(channel);
  if (left <= 0) return { ok: false, reason: `daily cap reached for ${channel} (${CAPS[channel]})` };

  if (channel.startsWith('linkedin') && rates.linkedin_pageviews >= CAPS.linkedin_pageviews) {
    return { ok: false, reason: 'LinkedIn pageview budget exhausted' };
  }

  return { ok: true, remaining: left };
}

export function recordApplication(channel) {
  bumpRate(channel);
}

export function currentMode() {
  const m = getSetting('mode', 'observe');
  return ['observe', 'review', 'auto'].includes(m) ? m : 'observe';
}

/** Gap between applications. Deliberately long and randomised. */
export function applicationGap() {
  const min = 120_000, max = 480_000;
  const u = Math.random(), v = Math.random();
  const z = Math.abs(Math.sqrt(-2 * Math.log(u || 1e-9)) * Math.cos(2 * Math.PI * v));
  return Math.min(max, min + z * (max - min) / 3);
}
