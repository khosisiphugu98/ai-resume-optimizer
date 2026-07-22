import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PATHS, SELECTORS, LINKEDIN } from './config.js';
import { emit, emitFrame } from './bus.js';

let ctx = null;
let screencastAttached = new WeakSet();

// ---------------------------------------------------------------------------
// Profile ownership.
//
// A Chrome user-data-dir takes exactly one owner. Chrome enforces that with a
// SingletonLock symlink inside the profile, and a second launch does not queue
// or fail cleanly — it prints "Opening in existing browser session", exits 0,
// and Playwright surfaces the whole launch command line as the error.
//
// That is a nasty failure because the *usual* cause is not a real conflict. A
// crashed run, a killed terminal, or a one-off script that never exited all
// leave a browser behind that nothing is driving, and every later run then dies
// on a stale lock held by a process nobody knows about. So rather than trusting
// the lock, ownership is verified against the live process table and anything
// orphaned is cleared away.
// ---------------------------------------------------------------------------

const SINGLETONS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/** Chrome processes whose --user-data-dir is our profile, main processes only. */
export function chromeOnProfile(profileDir = PATHS.chromeProfile) {
  const want = path.resolve(profileDir);
  let out = '';
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 });
  } catch {
    return [];
  }
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, cmd] = m;
    if (!cmd.includes(`--user-data-dir=${want}`)) continue;
    // Renderers, GPU and utility processes carry --type= and die with the parent.
    if (/--type=/.test(cmd)) continue;
    found.push({ pid: Number(pid), cmd });
  }
  return found;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Blocking on purpose: this also runs from an 'exit' handler, where nothing
// asynchronous gets a chance to finish.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Take the profile: kill any browser still holding it and clear the lock files.
 *
 * Only ever one LinkedIn session should exist anyway (§8.2), so a browser we did
 * not launch is by definition a leftover — reclaiming it is what keeps a crashed
 * run from bricking every run after it. The pid is logged so a genuine
 * double-run is visible rather than mysterious.
 */
export function reclaimProfile({ quiet = false } = {}) {
  const stray = chromeOnProfile();
  for (const { pid } of stray) {
    if (!quiet) {
      emit({
        stage: 'browser', level: 'warn',
        message: `Chrome pid ${pid} was still holding the browser profile — closing it before starting a new session`,
      });
    }
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  if (stray.length) {
    // SIGTERM lets Chrome flush its profile; escalate only if it ignores us.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && stray.some(s => alive(s.pid))) sleepSync(200);
    for (const { pid } of stray) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }

  // Stale singletons survive a SIGKILL and are enough on their own to block a
  // launch, so they go whether or not a process was found.
  for (const name of SINGLETONS) {
    const p = path.join(PATHS.chromeProfile, name);
    try { if (fs.lstatSync(p)) fs.rmSync(p, { force: true }); } catch {}
  }
  return stray.length;
}

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

  const launch = () => chromium.launchPersistentContext(PATHS.chromeProfile, {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'en-ZA',
    timezoneId: 'Africa/Johannesburg',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Clear a leftover before trying, so the common case never produces an error
  // at all; retry once after a reclaim in case one appeared in between.
  reclaimProfile();
  try {
    ctx = await launch();
  } catch (err) {
    if (!/existing browser session|ProcessSingleton|SingletonLock/i.test(String(err.message))) throw err;
    reclaimProfile();
    ctx = await launch();
  }

  ctx.on('close', () => { ctx = null; });
  return ctx;
}

export async function closeContext() {
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
}

/**
 * Leaving a browser running past the end of the process is what creates the
 * stale locks in the first place — so every entry point closes on the way out.
 */
let exitHooked = false;
export function closeBrowserOnExit() {
  if (exitHooked) return;
  exitHooked = true;
  const bye = () => { try { reclaimProfile({ quiet: true }); } catch {} };
  process.once('exit', bye);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { bye(); process.exit(0); });
  }
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
