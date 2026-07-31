import { CAPS, HOURS, PATHS, PAGEVIEW_FLOORS } from '../config.js';
import { todayRates, bumpRate, getSetting } from '../db.js';
import fs from 'node:fs';

export const CHANNELS = ['linkedin_easy', 'external_ats', 'email'];

/** LinkedIn pageviews still unspent today, across every consumer. */
export function pageviewsRemaining() {
  return Math.max(0, CAPS.linkedin_pageviews - (todayRates().linkedin_pageviews ?? 0));
}

/**
 * Whether `consumer` may spend a LinkedIn pageview right now.
 *
 * Every consumer shares one budget but stops at a different floor (see
 * PAGEVIEW_FLOORS), so the ones that matter least give way first. `browse` is
 * discovery and the enrich browser fallback; the rest are apply channels.
 */
export function pageviewBudget(consumer) {
  const floor = PAGEVIEW_FLOORS[consumer] ?? 0;
  const remaining = pageviewsRemaining();
  if (remaining > floor) return { ok: true, remaining, floor };
  return {
    ok: false, remaining, floor,
    reason: floor > 0
      ? `LinkedIn pageview budget down to ${remaining}/${CAPS.linkedin_pageviews} — the last ${floor} are reserved for higher-priority work`
      : `LinkedIn pageview budget exhausted (${CAPS.linkedin_pageviews}/day)`,
  };
}

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
  // A LinkedIn checkpoint is a LinkedIn problem. Halting every channel on one
  // stopped emailed CVs and third-party ATS forms too, neither of which LinkedIn
  // can see — a blast radius three times larger than the thing being protected.
  if (rates.challenges_hit > 0 && channel.startsWith('linkedin')) {
    return { ok: false, reason: 'a LinkedIn challenge was hit today — LinkedIn halted until manually cleared' };
  }

  // APPLY_BOT_IGNORE_HOURS lets a supervised operator run outside the normal
  // window (e.g. a weekend live run) without editing the HOURS const. It bypasses
  // only the time-of-day/day-of-week gate — the LinkedIn pageview budget and the
  // per-channel caps below still apply, so it cannot be used to blow the anti-ban
  // guards. Unset it and the window is enforced again.
  if (!ignoreHours && process.env.APPLY_BOT_IGNORE_HOURS !== '1') {
    const hrs = withinHours();
    if (!hrs.ok) return hrs;
  }

  const left = capRemaining(channel);
  if (left <= 0) return { ok: false, reason: `daily cap reached for ${channel} (${CAPS[channel]})` };

  // Both apply channels spend LinkedIn pageviews: Easy Apply opens the posting,
  // and external resolves its apply URL through the signed-in posting. They draw
  // on the same budget as discovery, but from above its floor — see
  // PAGEVIEW_FLOORS. external_ats stops with 20 left so that it can never starve
  // linkedin_easy, which is capped at 15 and carries the ban risk the budget
  // exists to manage.
  if (channel === 'linkedin_easy' || channel === 'external_ats') {
    const budget = pageviewBudget(channel);
    if (!budget.ok) return { ok: false, reason: budget.reason };
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

/**
 * Gap between applications, channel-aware.
 *
 * linkedin_easy carries account-ban risk, so it keeps the long, randomised,
 * human-like pacing even in 24/7 mode — pacing, not the clock, is what protects
 * the account. external_ats and email carry no LinkedIn risk, so they get a short
 * gap to maximise throughput (but not zero: a burst still trips ATS-side rate
 * limits and captchas, and gives the mail provider a reason to flag the sender).
 *
 * APPLY_BOT_GAP_MS forces a fixed gap for every channel — a supervised-run escape
 * hatch; leave it unset for the channel-aware defaults.
 */
export function applicationGap(channel = 'linkedin_easy') {
  const fixed = Number(process.env.APPLY_BOT_GAP_MS);
  if (Number.isFinite(fixed) && fixed >= 0) return fixed;

  if (channel === 'linkedin_easy') {
    const min = 120_000, max = 480_000;
    const u = Math.random(), v = Math.random();
    const z = Math.abs(Math.sqrt(-2 * Math.log(u || 1e-9)) * Math.cos(2 * Math.PI * v));
    return Math.min(max, min + z * (max - min) / 3);
  }

  // External ATS / email: short randomised gap, 3–12s.
  const min = 3_000, max = 12_000;
  return min + Math.random() * (max - min);
}
