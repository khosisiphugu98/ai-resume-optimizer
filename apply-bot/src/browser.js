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

/**
 * Which process launched the browser now holding the profile.
 *
 * Reclaiming is safe when the browser is an orphan and catastrophic when it is
 * not. On 28 July `npm run score` was started while `npm run tailor` was still
 * working; score's exit handler ran reclaimProfile(), which SIGKILLed the Chrome
 * that tailor was driving. Tailor did not abort — it kept selecting jobs and
 * marking each one failed, burning twelve in forty seconds on
 * "Target page, context or browser has been closed" until it was stopped by hand.
 *
 * A file naming the owning pid is enough to tell the two cases apart. A stale
 * one is harmless: the pid is checked against the live process table, and a
 * dead owner means the browser really is an orphan.
 */
const OWNER_FILE = () => path.join(PATHS.chromeProfile, '.apply-bot-owner');

function readOwner() {
  try {
    const pid = Number(fs.readFileSync(OWNER_FILE(), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

const writeOwner = () => { try { fs.writeFileSync(OWNER_FILE(), String(process.pid)); } catch {} };
const clearOwner = () => { try { fs.rmSync(OWNER_FILE(), { force: true }); } catch {} };

/**
 * The pid of another live process that owns this profile, or null.
 *
 * Null covers every case where taking the profile is fine: nobody claimed it,
 * the claimant is gone, or the claimant is us.
 */
export function profileOwner() {
  const pid = readOwner();
  if (!pid || pid === process.pid || !alive(pid)) return null;
  return pid;
}

/** Raised rather than killing a browser another live stage is driving. */
export class ProfileBusy extends Error {
  constructor(pid) {
    super(
      `The browser profile is in use by process ${pid} — another apply-bot stage is running.\n` +
      `  Only one stage may drive the browser at a time (§8.2: one LinkedIn session, ever).\n` +
      `  Wait for it to finish, or stop it, then run this again.`);
    this.name = 'ProfileBusy';
    this.pid = pid;
  }
}

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
export function reclaimProfile({ quiet = false, force = false } = {}) {
  const owner = profileOwner();
  if (owner && !force) throw new ProfileBusy(owner);

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
  clearOwner();
  return stray.length;
}

/**
 * Give up the profile on the way out — but only if it is ours to give up.
 *
 * This runs from an exit handler registered by every CLI command, which is how
 * one stage came to kill another's browser: `npm run score` exiting called
 * reclaimProfile() unconditionally while `npm run tailor` was mid-pass.
 */
export function releaseProfile() {
  try {
    if (profileOwner()) return 0;      // someone else is driving; leave it alone
    return reclaimProfile({ quiet: true });
  } catch { return 0; }
}

/**
 * A failure that means the browser went away underneath us, rather than
 * anything about the page.
 *
 * Worth telling apart because the response is different: a posting that failed
 * is a posting to retry or give up on, while a lost context says nothing about
 * the posting at all and will say the same thing about every job left in the
 * queue.
 */
const LOST_CONTEXT =
  /Target (page, context or browser|closed)|browser has been closed|Session closed|Execution context was destroyed|has been closed/i;

export const contextLost = err => LOST_CONTEXT.test(String(err?.message ?? err ?? ''));

/** Consecutive lost-context failures after which a stage stops rather than burning its backlog. */
export const LOST_CONTEXT_LIMIT = 3;

/**
 * Counts consecutive lost-context failures and says when to stop.
 *
 * Without this, a stage whose browser is killed does not notice: it keeps
 * selecting jobs and marking each one failed against an error that has nothing
 * to do with them. That is how twelve jobs were burned in forty seconds.
 */
export function lostContextBreaker({ limit = LOST_CONTEXT_LIMIT } = {}) {
  let streak = 0;
  return {
    /** @returns true when this failure was a lost context. */
    record(err) {
      if (contextLost(err)) { streak++; return true; }
      streak = 0;
      return false;
    },
    get tripped() { return streak >= limit; },
    get streak() { return streak; },
  };
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
  // at all; retry once after a reclaim in case one appeared in between. This
  // throws ProfileBusy rather than reclaiming when another live process has
  // claimed the profile — a browser somebody is driving is not a leftover.
  reclaimProfile();
  try {
    ctx = await launch();
  } catch (err) {
    if (!/existing browser session|ProcessSingleton|SingletonLock/i.test(String(err.message))) throw err;
    reclaimProfile();
    ctx = await launch();
  }

  writeOwner();
  ctx.on('close', () => { ctx = null; clearOwner(); });
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
  const bye = () => { releaseProfile(); };
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
  // Visibility matters. `page.$()` matches a hidden node just as happily as a
  // shown one, and these pages ship challenge markup as inert templates — so a
  // `display:none` skeleton would trip the kill switch and, until this was scoped
  // to LinkedIn in rate.js, halt every channel for the rest of the day on a
  // checkpoint that was never actually presented.
  for (const sel of SELECTORS.challenge) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      throw new ChallengeDetected(sel);
    }
  }
}

/**
 * What LinkedIn says when a posting has stopped taking applications.
 *
 * The same wording jd-fetch.js already looks for on the guest page at enrich
 * time — but a posting closes when it closes, which is routinely after it was
 * enriched, scored and tailored. Job 2344 reached step 3 of its Easy Apply modal
 * on 28 July and showed "No longer accepting applications" on 29 July.
 */
const CLOSED_POSTING = /no longer accepting applications|job is no longer available|this job is closed|applications are closed/i;

/**
 * Why this posting cannot be applied to, or null.
 *
 * Worth its own check because the alternative is a lie that costs real budget.
 * A closed posting has no apply control, so it surfaced as "No apply button
 * after 10s — posting may have closed, or the selector broke" — a message that
 * cannot tell the two apart, on a page that says which one it is in red. It was
 * then retried three times, and at 55 postings across the board that is roughly
 * 165 signed-in pageviews spent re-reading vacancies that had already closed,
 * against a daily budget of 250 that exists to keep the account unflagged.
 */
export async function postingClosedReason(page) {
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText().catch(() => '');
    const hit = text.match(CLOSED_POSTING);
    if (hit) return `the posting is closed — LinkedIn says "${hit[0]}"`;
  }
  return null;
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
