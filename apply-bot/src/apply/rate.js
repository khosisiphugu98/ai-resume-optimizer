import { CAPS, HOURS, PATHS } from '../config.js';
import { todayRates, bumpRate, getSetting } from '../db.js';
import fs from 'node:fs';

export const CHANNELS = ['linkedin_easy', 'external_ats', 'email'];

/**
 * The most of the LinkedIn pageview budget the external channel may consume.
 *
 * Resolving an external apply URL opens the signed-in LinkedIn posting, so
 * external browsing is LinkedIn browsing and counts against the same anti-ban
 * budget — it was simply never gated on it. 60% leaves a working reserve for Easy
 * Apply, which is the channel the budget was written for.
 */
export const EXTERNAL_PAGEVIEW_SHARE = 0.6;

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

  if (channel.startsWith('linkedin') && rates.linkedin_pageviews >= CAPS.linkedin_pageviews) {
    return { ok: false, reason: 'LinkedIn pageview budget exhausted' };
  }

  // External applications spend the LinkedIn budget too — resolving an apply URL
  // means opening the signed-in posting — but only the linkedin channels were ever
  // gated on it. With external capped at 1000 that is 1000 LinkedIn pageviews a day
  // against a 250 budget, and it showed: external burned 247 of 250 while
  // linkedin_easy used none, starving the channel the budget exists to protect.
  // External may spend up to a share of it and no more; the remainder is held for
  // the channel that actually carries the ban risk.
  if (channel === 'external_ats' && rates.linkedin_pageviews >= EXTERNAL_PAGEVIEW_SHARE * CAPS.linkedin_pageviews) {
    return {
      ok: false,
      reason: `external has used its share of the LinkedIn pageview budget `
        + `(${rates.linkedin_pageviews}/${CAPS.linkedin_pageviews}) — the rest is reserved for Easy Apply`,
    };
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
