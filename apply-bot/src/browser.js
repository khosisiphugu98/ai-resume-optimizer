import { chromium } from 'playwright';
import fs from 'node:fs';
import { PATHS, SELECTORS, LINKEDIN } from './config.js';
import { emit, emitFrame } from './bus.js';

let ctx = null;
let screencastAttached = new WeakSet();

/**
 * Single persistent context — you log in by hand once and the profile keeps the
 * session, cookies and fingerprint stable. Never run two of these against one
 * LinkedIn account (§8.2).
 */
// Headed by default — a real window on a real profile is the least detectable
// shape, and you can watch it. HEADLESS=1 for tests and unattended runs.
export async function getContext({ headless = process.env.HEADLESS === '1' } = {}) {
  if (ctx) return ctx;
  fs.mkdirSync(PATHS.chromeProfile, { recursive: true });
  ctx = await chromium.launchPersistentContext(PATHS.chromeProfile, {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'en-ZA',
    timezoneId: 'Africa/Johannesburg',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx.on('close', () => { ctx = null; });
  return ctx;
}

export async function closeContext() {
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
}

/**
 * Stream the page to the dashboard via CDP screencast. This is the "see
 * everything that's happening" window — §7.2.
 */
export async function attachScreencast(page) {
  if (screencastAttached.has(page)) return;
  screencastAttached.add(page);
  const session = await page.context().newCDPSession(page);
  session.on('Page.screencastFrame', async ({ data, sessionId }) => {
    emitFrame(data);
    await session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', {
    format: 'jpeg', quality: 55, maxWidth: 1100, maxHeight: 700, everyNthFrame: 2,
  }).catch(() => {});
  return session;
}

/** Try each selector in order; return the first that matches. */
export async function firstMatch(scope, selectors) {
  for (const sel of selectors) {
    const el = await scope.$(sel);
    if (el) return el;
  }
  return null;
}

export async function textOf(scope, selectors) {
  const el = await firstMatch(scope, selectors);
  if (!el) return null;
  return (await el.innerText().catch(() => null))?.trim().split('\n')[0] || null;
}

/**
 * Any challenge means stop everything — with nobody watching, blundering through
 * a checkpoint repeatedly is how accounts get banned (§8.2).
 */
export class ChallengeDetected extends Error {
  constructor(what) { super(`LinkedIn challenge detected: ${what}`); this.name = 'ChallengeDetected'; }
}

export async function assertNoChallenge(page) {
  const url = page.url();
  if (/\/checkpoint\/|\/authwall|challengesV2/i.test(url)) throw new ChallengeDetected(url);
  for (const sel of SELECTORS.challenge) {
    if (await page.$(sel)) throw new ChallengeDetected(sel);
  }
}

export function stopRequested() {
  return fs.existsSync(PATHS.stop);
}

export async function isLoggedIn(page) {
  await page.goto(LINKEDIN.loginProbe, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  return !/\/login|\/authwall|\/uas\//i.test(page.url());
}

/** Human-ish pacing. Log-normal, not uniform — real gaps cluster short with a tail. */
export function humanDelay(minMs = 3000, maxMs = 12000) {
  const u = Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u || 1e-9)) * Math.cos(2 * Math.PI * v);
  const spread = (maxMs - minMs) / 3;
  const ms = Math.min(maxMs, Math.max(minMs, minMs + Math.abs(z) * spread));
  return new Promise(r => setTimeout(r, ms));
}

export { emit };
