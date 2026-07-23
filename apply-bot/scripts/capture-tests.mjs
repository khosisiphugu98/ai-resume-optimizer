/**
 * Adaptive agent, Phase 1 — capture tests.
 *
 * No browser, no network: the Playwright page/frame is faked down to the few
 * methods buildSnapshot touches. What matters is the contract — the fingerprint
 * groups shapes stably, the upsert dedupes rather than appends, and capture is
 * best-effort (it can never throw or change the apply outcome).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fingerprintOf, captureUnsolvedPage } from '../src/apply/agent/capture.js';
import { db, upsertPageCapture, listPageCaptures } from '../src/db.js';

// Sequential runner — the async bodies must finish before the next test reads
// the database, so we await each one in turn rather than firing microtasks.
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const snapshotPathOf = id =>
  db.prepare('SELECT snapshot_path FROM page_captures WHERE id = ?').get(id)?.snapshot_path;

// Capture emits an info event carrying the job id, and the events table has a
// real foreign key to jobs — so, exactly as in production, the referenced job
// must exist. Seed a minimal one.
const seedJob = id => db.prepare(
  `INSERT OR IGNORE INTO jobs (id, source, external_id, discovered_at, status)
   VALUES (?, 'linkedin', ?, ?, 'tailored')`,
).run(id, `ext-${id}`, new Date().toISOString());

// A frame yields its a11y controls on the first evaluate() (collectA11yInPage)
// and an empty DOM field list on the second (collectFieldsInPage).
const fakeFrame = (controls = [], url = 'https://boards.greenhouse.io/acme') => {
  let n = 0;
  return { url: () => url, evaluate: async () => (n++ === 0 ? controls : []) };
};
const fakePage = ({ frames = [], url = 'https://boards.greenhouse.io/acme/jobs/1',
                    title = 'Apply', throwOnUrl = false } = {}) => ({
  url: () => { if (throwOnUrl) throw new Error('detached'); return url; },
  title: async () => title,
  frames: () => frames,
  evaluate: async () => ({ tags: { div: 3 }, landmarks: ['form'], bodyChars: 42 }),
  screenshot: async () => {},
});

// --- fingerprint -----------------------------------------------------------

test('control order does not change the fingerprint', () => {
  const a = fingerprintOf('x.com', [{ role: 'textbox', name: 'Email' }, { role: 'textbox', name: 'Name' }]);
  const b = fingerprintOf('x.com', [{ role: 'textbox', name: 'Name' }, { role: 'textbox', name: 'Email' }]);
  assert.equal(a, b);
});

test('accessible-name whitespace/case is normalised', () => {
  const a = fingerprintOf('x.com', [{ role: 'textbox', name: 'Email  Address' }]);
  const b = fingerprintOf('x.com', [{ role: 'textbox', name: 'email address' }]);
  assert.equal(a, b);
});

test('a different host is a different shape', () => {
  const a = fingerprintOf('a.com', [{ role: 'textbox', name: 'Email' }]);
  const b = fingerprintOf('b.com', [{ role: 'textbox', name: 'Email' }]);
  assert.notEqual(a, b);
});

test('a no-form page collapses to a host-only fingerprint', () => {
  // The same empty shape on one host groups together; on another host it does not.
  assert.equal(fingerprintOf('a.com', []), fingerprintOf('a.com', []));
  assert.notEqual(fingerprintOf('a.com', []), fingerprintOf('b.com', []));
});

// --- upsert ----------------------------------------------------------------

test('a repeat fingerprint bumps seen_count instead of adding a row', () => {
  const fp = fingerprintOf('upsert.test', [{ role: 'textbox', name: 'Email' }]);
  const before = listPageCaptures().length;
  const id1 = upsertPageCapture({ fingerprint: fp, host: 'upsert.test', failureStage: 'stuck', controlCount: 1 });
  const id2 = upsertPageCapture({ fingerprint: fp, host: 'upsert.test', failureStage: 'stuck', controlCount: 1 });
  assert.equal(id1, id2, 'the second upsert should reuse the same row');
  assert.equal(listPageCaptures().length, before + 1, 'only one new row');
  assert.equal(listPageCaptures().find(r => r.id === id1).seen_count, 2);
});

// --- captureUnsolvedPage ---------------------------------------------------

test('captures a stuck page, recording control count and a snapshot file', async () => {
  seedJob(7);
  const page = fakePage({ frames: [fakeFrame([{ role: 'textbox', name: 'Full name' }, { role: 'file', name: '' }])] });
  const id = await captureUnsolvedPage(page, { job: { id: 7 }, vendor: 'greenhouse', stage: 'stuck', reason: 'no progress' });
  assert.ok(Number.isInteger(id), 'should return a row id');
  const row = listPageCaptures().find(r => r.id === id);
  assert.equal(row.control_count, 2);
  assert.equal(row.failure_stage, 'stuck');
  assert.equal(row.vendor, 'greenhouse');
  assert.ok(fs.existsSync(snapshotPathOf(id)), 'snapshot JSON should be on disk');
});

test('a no-form page records zero controls', async () => {
  seedJob(8);
  const page = fakePage({ frames: [fakeFrame([])], url: 'https://noform.example/apply' });
  const id = await captureUnsolvedPage(page, { job: { id: 8 }, vendor: 'generic', stage: 'no-form', reason: 'no form' });
  assert.equal(listPageCaptures().find(r => r.id === id).control_count, 0);
});

test('capture is best-effort — a broken page returns null and never throws', async () => {
  const page = fakePage({ throwOnUrl: true });
  const before = listPageCaptures().length;
  const id = await captureUnsolvedPage(page, { job: { id: 9 }, stage: 'stuck', reason: 'x' });
  assert.equal(id, null);
  assert.equal(listPageCaptures().length, before, 'nothing recorded on failure');
});

// --- run -------------------------------------------------------------------

let pass = 0, fail = 0;
console.log('\ncapture');
for (const { name, fn } of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
