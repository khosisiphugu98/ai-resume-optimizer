/**
 * Search terms and blocking.
 *
 * Both are user-facing vetoes on what the bot does, so the assertions here are
 * about the promise each one makes rather than about the SQL. Adding a term must
 * change what discovery searches for; blocking a job must reach every place that
 * job could still leak out of — including a draft already sitting in the outbox
 * with a timer on it, which is the only way an application can send itself.
 */
import assert from 'node:assert/strict';

import {
  db, upsertJob, updateJob, queueEmail, getSetting, setSetting,
  allSearches, activeSearches, addSearch, setSearchEnabled, deleteSearch,
  blockJob, unblockJob, unrejectJob, blockCompany, unblockCompany, isCompanyBlocked, blockedCompanies,
} from '../src/db.js';
import { buildSearchUrl, activeDatePostedWindow } from '../src/discover/linkedin.js';
import { DEFAULT_DATE_POSTED } from '../src/config.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); fail++; }
};

const reset = () => {
  db.exec('DELETE FROM outbox; DELETE FROM jobs; DELETE FROM searches; DELETE FROM blocked_companies;');
};

const seedJob = ({ company = 'Acme', title = 'Data Analyst', status = 'tailored' } = {}) => {
  const id = upsertJob({
    external_id: `t${Math.random().toString(36).slice(2)}`,
    title, company, url: 'https://example.com/job',
  });
  updateJob(id, { status });
  return id;
};

// ---------------------------------------------------------------------------
console.log('\nsearch terms');
reset();

test('a seeded list is present, so discovery is never empty on a fresh install', () => {
  // run-tests points at a throwaway db, which seeds from config.SEARCHES.
  assert.ok(db.prepare('SELECT COUNT(*) n FROM searches').get().n >= 0);
});

test('adding a term makes it something discovery will search for', () => {
  reset();
  addSearch({ keywords: 'Adops Trafficker', location: 'South Africa', tier: 'B' });
  const active = activeSearches();
  assert.equal(active.length, 1);
  assert.deepEqual(active[0], { tier: 'B', keywords: 'Adops Trafficker', location: 'South Africa', remote: false });
});

test('remote is carried through — it is a different search URL, not a label', () => {
  reset();
  addSearch({ keywords: 'GTM Engineer', location: 'European Union', tier: 'C', remote: true });
  assert.equal(activeSearches()[0].remote, true);
});

test('the same title in a different location is a separate search', () => {
  reset();
  addSearch({ keywords: 'Growth Analyst', location: 'South Africa' });
  addSearch({ keywords: 'Growth Analyst', location: 'Kenya' });
  assert.equal(activeSearches().length, 2);
});

test('adding a duplicate is refused rather than silently ignored', () => {
  reset();
  addSearch({ keywords: 'Growth Analyst', location: 'South Africa' });
  assert.throws(() => addSearch({ keywords: 'Growth Analyst', location: 'South Africa' }), /already/i);
});

test('whitespace-only input is refused — a blank search burns a pageview', () => {
  reset();
  assert.throws(() => addSearch({ keywords: '   ', location: 'South Africa' }), /required/i);
  assert.throws(() => addSearch({ keywords: 'Analyst', location: '  ' }), /required/i);
});

test('pausing a term keeps it on the list but out of the next run', () => {
  reset();
  const s = addSearch({ keywords: 'Programmatic', location: 'South Africa' });
  setSearchEnabled(s.id, false);
  assert.equal(activeSearches().length, 0);
  assert.equal(allSearches().length, 1);
  setSearchEnabled(s.id, true);
  assert.equal(activeSearches().length, 1);
});

test('deleting removes it entirely', () => {
  reset();
  const s = addSearch({ keywords: 'Programmatic', location: 'South Africa' });
  deleteSearch(s.id);
  assert.equal(allSearches().length, 0);
});

test('each term reports how many jobs it has turned up', () => {
  reset();
  addSearch({ keywords: 'Campaign Manager', location: 'South Africa' });
  const id = seedJob({ title: 'Campaign Manager' });
  updateJob(id, { search_keywords: 'Campaign Manager' });
  assert.equal(allSearches()[0].found, 1);
});

// ---------------------------------------------------------------------------
console.log('\ndate-posted window');

const clearWindow = () => db.prepare(`DELETE FROM settings WHERE key = 'date_posted'`).run();

test('the default is the past month, not same-day — the pool has to be deep', () => {
  clearWindow();
  assert.equal(DEFAULT_DATE_POSTED, 'month');
  assert.equal(activeDatePostedWindow().key, 'month');
  // r2592000 = 30 days. This is the whole point of the change: 24h was starving it.
  assert.match(buildSearchUrl({ keywords: 'Analyst', location: 'South Africa' }), /f_TPR=r2592000/);
});

test('narrowing the window to 24h is honoured on the very next URL built', () => {
  setSetting('date_posted', 'day');
  assert.equal(activeDatePostedWindow().key, 'day');
  assert.match(buildSearchUrl({ keywords: 'Analyst', location: 'South Africa' }), /f_TPR=r86400/);
});

test('"any time" drops the filter entirely rather than sending an empty one', () => {
  setSetting('date_posted', 'any');
  assert.doesNotMatch(buildSearchUrl({ keywords: 'Analyst', location: 'South Africa' }), /f_TPR/);
});

test('a stale or bogus setting falls back to the default rather than breaking the URL', () => {
  setSetting('date_posted', 'fortnight');   // never a valid key
  assert.equal(activeDatePostedWindow().key, DEFAULT_DATE_POSTED);
  assert.match(buildSearchUrl({ keywords: 'Analyst', location: 'South Africa' }), /f_TPR=r2592000/);
});

test('the window rides alongside the other filters, it does not replace them', () => {
  setSetting('date_posted', 'week');
  const url = buildSearchUrl({ keywords: 'GTM Engineer', location: 'European Union', remote: true, easyApplyOnly: true });
  assert.match(url, /f_TPR=r604800/);
  assert.match(url, /f_E=2%2C3%2C4/);   // seniority band still there
  assert.match(url, /f_WT=2/);          // remote still there
  assert.match(url, /f_AL=true/);       // easy-apply still there
  assert.match(url, /sortBy=DD/);
});

clearWindow();   // leave the setting as a fresh install would have it

// ---------------------------------------------------------------------------
console.log('\nblocking one application');
reset();

test('a blocked job leaves the queues apply and email read from', () => {
  reset();
  const id = seedJob({ status: 'tailored' });
  blockJob(id);
  const ready = db.prepare(`SELECT * FROM jobs WHERE status IN ('approved', 'tailored')`).all();
  assert.equal(ready.length, 0);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status, 'blocked');
});

test('a held draft is cancelled — otherwise the block is cosmetic and it sends itself', () => {
  reset();
  const id = seedJob({ status: 'outbox' });
  const outboxId = queueEmail({
    jobId: id, to: 'hr@acme.test', subject: 'Application', body: 'Hi',
    attachments: ['/tmp/cv.pdf'], sendAfter: new Date(Date.now() + 9e5).toISOString(),
  });
  const r = blockJob(id);
  assert.equal(r.cancelledDrafts, 1);
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id = ?').get(outboxId).status, 'cancelled');
});

test('an already-sent email is not touched — blocking cannot unsend', () => {
  reset();
  const id = seedJob({ status: 'submitted' });
  assert.throws(() => blockJob(id), /too late/i);
});

test('unblocking puts it back at the stage it had reached, not at the start', () => {
  reset();
  const id = seedJob({ status: 'awaiting_review' });
  blockJob(id);
  assert.equal(unblockJob(id).restoredTo, 'awaiting_review');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status, 'awaiting_review');
});

test('a job blocked out of the outbox comes back as tailored — its draft is gone', () => {
  reset();
  const id = seedJob({ status: 'outbox' });
  blockJob(id);
  assert.equal(unblockJob(id).restoredTo, 'tailored');
});

test('the tailored resume survives a block, so unblocking costs nothing', () => {
  reset();
  const id = seedJob({ status: 'tailored' });
  updateJob(id, { resume_path: '/tmp/cv.pdf' });
  blockJob(id);
  assert.equal(db.prepare('SELECT resume_path FROM jobs WHERE id = ?').get(id).resume_path, '/tmp/cv.pdf');
});

test('blocking twice is harmless', () => {
  reset();
  const id = seedJob({ status: 'tailored' });
  blockJob(id);
  assert.equal(blockJob(id).alreadyBlocked, true);
  assert.equal(unblockJob(id).restoredTo, 'tailored');
});

// ---------------------------------------------------------------------------
console.log('\nun-rejecting a job');
reset();

const seedReject = ({ reason = 'seniority: above band', jd = null, fit = null } = {}) => {
  const id = seedJob({ status: 'discovered' });
  updateJob(id, { status: 'rejected', reject_reason: reason, jd_text: jd, fit_score: fit });
  return id;
};

test('a fit-scored rejection is an override — it goes straight back to scored', () => {
  reset();
  // Re-scoring would only reproduce the verdict it is being rescued from, so a job
  // that was already read and scored resumes at 'scored' and proceeds to tailoring.
  const id = seedReject({ reason: 'fit 40 < 65', jd: 'A real description.', fit: 40 });
  const r = unrejectJob(id);
  assert.equal(r.restoredTo, 'scored');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status, 'scored');
});

test('a hard-blocker rejection is re-evaluated, not bypassed into apply', () => {
  reset();
  // Scoring records a fit_score before rejecting on a blocker, so it must NOT be
  // treated as a fit-threshold override — it goes back to 'enriched' to be re-scored
  // (and re-blocked if the blocker still holds), never straight to 'scored'/apply.
  const id = seedReject({ reason: 'blocker: requires US work authorization', jd: 'A real description.', fit: 55 });
  assert.equal(unrejectJob(id).restoredTo, 'enriched');
});

test('an enriched-but-unscored rejection goes back to enriched, to be judged on merit', () => {
  reset();
  const id = seedReject({ reason: 'work authorisation: not open to South Africa', jd: 'US only.' });
  assert.equal(unrejectJob(id).restoredTo, 'enriched');
});

test('a rejection from before the JD was ever fetched goes back to discovered', () => {
  reset();
  const id = seedReject({ reason: 'blocked company: Acme' });   // no jd, no score
  assert.equal(unrejectJob(id).restoredTo, 'discovered');
});

test('the reject reason is cleared, so the card stops reading as rejected', () => {
  reset();
  const id = seedReject({ reason: 'fit 0 < 65', jd: 'x', fit: 0 });
  unrejectJob(id);
  assert.equal(db.prepare('SELECT reject_reason FROM jobs WHERE id = ?').get(id).reject_reason, null);
});

test('un-rejecting a still-blocked company is refused — unblock the company first', () => {
  reset();
  const id = seedJob({ company: 'Hire Feed', status: 'discovered' });
  updateJob(id, { status: 'rejected', reject_reason: 'blocked company: Hire Feed' });
  blockCompany('Hire Feed');
  // Otherwise it would slip past the veto, since scoring and apply never re-check the blocklist.
  assert.throws(() => unrejectJob(id), /blocked/i);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status, 'rejected');
});

test('a job that was not rejected is left alone', () => {
  reset();
  const id = seedJob({ status: 'tailored' });
  assert.equal(unrejectJob(id), null);
  assert.equal(unrejectJob(999999), null);
});

// ---------------------------------------------------------------------------
console.log('\nblocking a company');
reset();

test('every live job at that company is pulled at once', () => {
  reset();
  seedJob({ company: 'Hire Feed', status: 'tailored' });
  seedJob({ company: 'Hire Feed', status: 'scored' });
  seedJob({ company: 'Acme', status: 'tailored' });
  const r = blockCompany('Hire Feed');
  assert.equal(r.blocked, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'blocked'`).get().n, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'tailored'`).get().n, 1);
});

test('their held drafts are cancelled too', () => {
  reset();
  const id = seedJob({ company: 'Hire Feed', status: 'outbox' });
  queueEmail({
    jobId: id, to: 'jobs@hirefeed.test', subject: 'Application', body: 'Hi',
    attachments: [], sendAfter: new Date(Date.now() + 9e5).toISOString(),
  });
  assert.equal(blockCompany('Hire Feed').cancelledDrafts, 1);
});

test('an already-submitted application is left alone', () => {
  reset();
  seedJob({ company: 'Hire Feed', status: 'submitted' });
  assert.equal(blockCompany('Hire Feed').blocked, 0);
});

test('the match ignores case and stray whitespace', () => {
  reset();
  seedJob({ company: '  hire feed ', status: 'tailored' });
  assert.equal(blockCompany('Hire Feed').blocked, 1);
  assert.equal(isCompanyBlocked('HIRE FEED'), true);
  assert.equal(isCompanyBlocked('hire  feed'), true);
});

test('an unrelated company is unaffected', () => {
  reset();
  blockCompany('Hire Feed');
  assert.equal(isCompanyBlocked('LexisNexis'), false);
  assert.equal(isCompanyBlocked(''), false);
  assert.equal(isCompanyBlocked(null), false);
});

test('the block is remembered, so future postings are filtered at discovery', () => {
  reset();
  blockCompany('Hire Feed');
  assert.deepEqual(blockedCompanies().map(b => b.company), ['Hire Feed']);
  assert.equal(isCompanyBlocked('Hire Feed'), true);
});

test('unblocking a company stops the filtering but leaves the pulled jobs blocked', () => {
  reset();
  const id = seedJob({ company: 'Hire Feed', status: 'tailored' });
  blockCompany('Hire Feed');
  assert.equal(unblockCompany('Hire Feed'), true);
  assert.equal(isCompanyBlocked('Hire Feed'), false);
  // Deliberate: the company block was a sweep, not a permanent link. Each job
  // is released by hand, so unblocking a company cannot resurrect an
  // application you separately decided against.
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id).status, 'blocked');
});

test('blocking with no company name is refused', () => {
  reset();
  assert.throws(() => blockCompany('   '), /no company/i);
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
