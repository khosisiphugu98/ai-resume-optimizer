/**
 * End-to-end test of the dashboard pipeline, against the real server and a real
 * locked browser profile.
 *
 * The scenario is the one that used to break everything: a browser left holding
 * the Chrome profile by a process nobody is watching. Every stage that touches
 * Chrome died on it, and the error surfaced as a 40-line Playwright launch
 * command line rather than anything actionable.
 *
 * Run: node scripts/pipeline-e2e.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://localhost:5175';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); fail++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const api = async (p, init) => {
  const res = await fetch(BASE + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

/**
 * Highest event id right now. Every wait is anchored to one of these: the event
 * log is persistent, so without a baseline a "Finished: enrich" from an earlier
 * run satisfies the wait instantly and the assertions race a live stage.
 */
async function eventCursor() {
  const { body } = await api('/api/events');
  return body?.at(-1)?.id ?? 0;
}

/** Wait for a stage started via /api/run to report Finished on the event log. */
async function waitForStage(stage, since, timeoutMs = 180000) {
  const started = Date.now();
  let seen = [];
  while (Date.now() - started < timeoutMs) {
    await sleep(1500);
    const { body } = await api('/api/events');
    seen = (body || []).filter(e => e.id > since && e.stage === stage);
    if (seen.some(e => e.message?.startsWith('Finished: '))) return seen;
  }
  throw new Error(`${stage} did not finish within ${timeoutMs}ms — last: ${seen.at(-1)?.message}`);
}

const children = [];
function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch {} } }
}
process.on('exit', cleanup);

console.log('\n── Setting up the failure condition ──\n');

// An orphan browser on the shared profile, exactly like a crashed run leaves.
const orphan = spawn(process.execPath, ['-e', `
  import('./src/browser.js').then(async ({ getContext }) => {
    await getContext({ headless: true });
    console.log('ORPHAN_READY');
    await new Promise(() => {});          // never exits — that is the point
  });
`], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HEADLESS: '1' } });
children.push(orphan);

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('orphan browser never came up')), 60000);
  orphan.stdout.on('data', d => { if (String(d).includes('ORPHAN_READY')) { clearTimeout(timer); resolve(); } });
  orphan.stderr.on('data', d => process.stderr.write(`  [orphan] ${d}`));
});

const { chromeOnProfile } = await import('../src/browser.js');
const held = chromeOnProfile();
ok('an orphan browser is holding the profile', held.length > 0, `found ${held.length}`);

console.log('\n── Dashboard server ──\n');

const server = spawn(process.execPath, ['src/cli.js', 'serve'], {
  cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HEADLESS: '1' },
});
children.push(server);
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => process.stderr.write(`  [server] ${d}`));

for (let i = 0; i < 40 && !/Dashboard →/.test(serverOut); i++) await sleep(500);
ok('server started', /Dashboard →/.test(serverOut), serverOut.slice(0, 300));

// The behaviour, not the log line: nothing may still be holding the profile.
for (let i = 0; i < 20 && chromeOnProfile().length; i++) await sleep(500);
ok('server reclaimed the leftover browser on startup', chromeOnProfile().length === 0,
  `still held by ${chromeOnProfile().map(p => p.pid).join(',')}`);

for (let i = 0; i < 10 && !/Cleared \d+ leftover browser/.test(serverOut); i++) await sleep(300);
ok('server said so on the way up', /Cleared \d+ leftover browser/.test(serverOut), serverOut.trim());
ok('no stale SingletonLock is left behind',
  !fs.existsSync(path.join(ROOT, 'data/chrome-profile/SingletonLock')));

const board = await api('/api/board');
ok('/api/board responds', board.status === 200 && Array.isArray(board.body?.jobs));

console.log('\n── enrich stage, over HTTP, with no session ──\n');

// Push a few jobs back to `discovered` so the stage has real work to do.
const { db } = await import('../src/db.js');
const victims = db.prepare(
  `SELECT id FROM jobs WHERE jd_text IS NOT NULL ORDER BY id DESC LIMIT 4`).all().map(r => r.id);
db.prepare(`UPDATE jobs SET status='discovered', jd_text=NULL, title=NULL, company=NULL,
            apply_type='unknown', reject_reason=NULL WHERE id IN (${victims.map(() => '?').join(',')})`).run(...victims);
ok('seeded jobs back into "discovered"', victims.length === 4);

const beforeViews = (await api('/api/board')).body.rates.linkedin_pageviews;

const enrichCursor = await eventCursor();
const started = await api('/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'enrich' }),
});
ok('POST /api/run {stage:enrich} accepted', started.status === 200 && started.body.started === 'enrich',
  JSON.stringify(started.body));

const events = await waitForStage('enrich', enrichCursor);
const messages = events.map(e => e.message);
const errors = events.filter(e => e.level === 'error' || e.level === 'critical');

ok('enrich produced no errors', errors.length === 0, errors.map(e => e.message).join('\n      '));
ok('enrich did not hit the browser-profile lock',
  !messages.some(m => /existing browser session|launchPersistentContext/i.test(m)),
  messages.find(m => /existing browser session/i.test(m)));
ok('enrich reported a completion summary',
  messages.some(m => /Enrich complete — \d+ enriched/.test(m)),
  messages.at(-2));
ok('enrich actually enriched jobs',
  messages.some(m => /Enrich complete — [1-9]\d* enriched/.test(m)),
  messages.find(m => m.startsWith('Enrich complete')));

const afterViews = (await api('/api/board')).body.rates.linkedin_pageviews;
ok('enrich spent no signed-in LinkedIn pageviews', afterViews === beforeViews,
  `${beforeViews} → ${afterViews}`);

const rows = db.prepare(
  `SELECT id, title, company, apply_type, jd_text, status FROM jobs WHERE id IN (${victims.map(() => '?').join(',')})`,
).all(...victims);
ok('every seeded job left "discovered"', rows.every(r => r.status !== 'discovered'),
  rows.map(r => `${r.id}:${r.status}`).join(' '));
ok('titles and companies were backfilled',
  rows.every(r => r.title && r.company), rows.map(r => `${r.id}:${r.title}@${r.company}`).join(' '));
ok('descriptions are substantial and tag-free',
  rows.every(r => r.jd_text && r.jd_text.length > 300 && !/<[a-z/]/i.test(r.jd_text)),
  rows.map(r => `${r.id}:${r.jd_text?.length}`).join(' '));
ok('apply routes were resolved',
  rows.every(r => ['easy_apply', 'external', 'email', 'unknown'].includes(r.apply_type)),
  rows.map(r => r.apply_type).join(' '));

console.log('\n── a browser stage still works after all that ──\n');

const checkCursor = await eventCursor();
const check = await api('/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'check' }),
});
ok('POST /api/run {stage:check} accepted', check.status === 200, JSON.stringify(check.body));

// The check stage logs its verdict under the `login` stage but brackets itself
// under `check`, so completion and content are read from different streams.
await waitForStage('check', checkCursor, 120000);
const allEvents = (await api('/api/events')).body
  .filter(e => e.id > checkCursor);
const loginEvents = allEvents.filter(e => e.stage === 'login' || e.stage === 'check');
const loginErrors = loginEvents.filter(e => e.level === 'error' || e.level === 'critical');
ok('the browser launched despite the earlier locked profile',
  !loginErrors.some(e => /existing browser session/i.test(e.message)),
  loginErrors.map(e => e.message.slice(0, 200)).join('\n      '));
ok('session check reported a verdict',
  loginEvents.some(e => /LinkedIn session is live|Not logged in/.test(e.message)),
  loginEvents.map(e => e.message).join(' | ').slice(0, 300));

console.log('\n── one stage at a time is still enforced ──\n');

// Give enrich real work first. With an empty queue it finishes between the two
// requests and the second stage is admitted legitimately, which would make this
// check pass or fail on timing rather than on the lock.
db.prepare(`UPDATE jobs SET status='discovered' WHERE id IN (${victims.map(() => '?').join(',')})`).run(...victims);

const lockCursor = await eventCursor();
await api('/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'enrich' }),
});
const concurrent = await api('/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'discover' }),
});
ok('a second concurrent stage is refused', concurrent.status === 409, JSON.stringify(concurrent.body));
await waitForStage('enrich', lockCursor);

cleanup();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
