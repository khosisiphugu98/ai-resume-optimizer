/**
 * Enrichment tests.
 *
 * The parsing half runs against saved fixtures so it keeps working with no
 * network and catches a LinkedIn markup change as a diff rather than as an
 * empty pipeline. The browser half runs against the real process table, since
 * the bug it exists to prevent — a stale profile lock — only ever shows up
 * there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  parseGuestPosting, htmlToText, decodeEntities, seniorityReject,
} from '../src/discover/jd-fetch.js';
import { classifyApply, preFilter, parseDocTitle } from '../src/discover/linkedin.js';
import { chromeOnProfile, reclaimProfile } from '../src/browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = id => fs.readFileSync(path.join(HERE, 'fixtures', `guest-${id}.html`), 'utf8');

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); fail++; }
};

console.log('\nhtmlToText');

test('turns list items into bullets on their own lines', () => {
  const out = htmlToText('<p>We need:</p><ul><li>SQL</li><li>GA4</li></ul>');
  assert.equal(out, 'We need:\n\n• SQL\n• GA4');
});

test('keeps <br> as a line break', () => {
  assert.equal(htmlToText('Cape Town<br>South Africa'), 'Cape Town\nSouth Africa');
});

test('drops tags but not the words between them', () => {
  assert.equal(htmlToText('<p><strong>5 years</strong> of <em>experience</em></p>'), '5 years of experience');
});

test('collapses runaway blank lines', () => {
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
});

test('decodes named, decimal and hex entities', () => {
  assert.equal(decodeEntities('R&amp;D &#8212; caf&#xe9; &nbsp;x'), 'R&D — café  x');
});

test('strips scripts rather than inlining their source', () => {
  assert.equal(htmlToText('<p>hi</p><script>var x = "buy now";</script>'), 'hi');
});

console.log('\nparseGuestPosting — real LinkedIn markup');

test('extracts title, company, location and description', () => {
  const p = parseGuestPosting(fixture('4443502015'), '4443502015');
  assert.equal(p.title, 'IT Problem Analyst');
  assert.equal(p.company, 'RCL FOODS');
  assert.match(p.location, /Durban/);
  assert.ok(p.jd.length > 1000, `description was ${p.jd?.length} chars`);
  assert.match(p.jd, /RCL FOODS/);
});

test('reads the structured criteria block', () => {
  const p = parseGuestPosting(fixture('4443502015'), '4443502015');
  assert.equal(p.criteria.employment_type, 'Full-time');
  assert.equal(p.criteria.seniority_level, 'Not Applicable');
});

test('detects an offsite apply route', () => {
  assert.equal(parseGuestPosting(fixture('4443502015'), '4443502015').applyRoute, 'external');
});

test('detects an onsite (Easy Apply) route', () => {
  const p = parseGuestPosting(fixture('4440471574'), '4440471574');
  assert.equal(p.applyRoute, 'easy_apply');
  assert.ok(p.jd.length > 1000);
});

test('a posting with no apply CTA is unknown, not a crash', () => {
  const p = parseGuestPosting(fixture('4440480630'), '4440480630');
  assert.equal(p.applyRoute, 'unknown');
  assert.ok(p.title, 'title should still parse');
  assert.ok(p.jd.length > 500, 'description should still parse');
});

test('description text is clean prose, not markup', () => {
  const p = parseGuestPosting(fixture('4443502015'), '4443502015');
  assert.doesNotMatch(p.jd, /<[a-z/]/i, 'tags leaked into the JD');
  assert.doesNotMatch(p.jd, /&[a-z]+;/i, 'entities left undecoded');
});

test('missing fields come back null instead of throwing', () => {
  const p = parseGuestPosting('<html><body>nothing here</body></html>', '1');
  assert.equal(p.title, null);
  assert.equal(p.jd, null);
  assert.equal(p.applyRoute, 'unknown');
  assert.deepEqual(p.criteria, {});
});

test('flags a posting that has closed', () => {
  const p = parseGuestPosting('<p>No longer accepting applications</p>', '1');
  assert.equal(p.closed, true);
});

console.log('\nclassifyApply');

test('an email instruction in the body beats the apply button', () => {
  const r = classifyApply({
    jd: 'Send your CV to careers@example.co.za before Friday.',
    applyRoute: 'external',
  });
  assert.equal(r.applyType, 'email');
  assert.equal(r.applyEmail, 'careers@example.co.za');
});

test('an address with no instruction to email is not an email application', () => {
  const r = classifyApply({
    jd: 'Questions? Reach the team at info@example.com. Apply via the button.',
    applyRoute: 'external',
  });
  assert.equal(r.applyType, 'external');
  assert.equal(r.applyEmail, null);
});

test('falls through to the parsed route', () => {
  assert.equal(classifyApply({ jd: 'Great role.', applyRoute: 'easy_apply' }).applyType, 'easy_apply');
  assert.equal(classifyApply({ jd: null, applyRoute: 'unknown' }).applyType, 'unknown');
});

console.log('\nfilters');

test('seniority criteria rejects only the unambiguous bands', () => {
  assert.ok(seniorityReject({ seniority_level: 'Director' }));
  assert.ok(seniorityReject({ seniority_level: 'Executive' }));
  assert.equal(seniorityReject({ seniority_level: 'Mid-Senior level' }), null);
  assert.equal(seniorityReject({ seniority_level: 'Entry level' }), null);
  assert.equal(seniorityReject({}), null);
});

test('work-authorisation filter still fires on full JD text', () => {
  const reason = preFilter({
    title: 'Marketing Analyst',
    location: 'United States (Remote)',
    jd: 'You must be legally authorized to work in the United States. No sponsorship.',
  });
  assert.match(reason, /work authorisation/);
});

test('a South African posting survives the authorisation filter', () => {
  assert.equal(preFilter({
    title: 'Marketing Analyst',
    location: 'Johannesburg, Gauteng, South Africa',
    jd: 'Hybrid role in Sandton.',
  }), null);
});

test('parseDocTitle keeps pipes that belong to the title', () => {
  assert.deepEqual(
    parseDocTitle('Visual Content Analyst | $70/hr Remote | Acme | LinkedIn'),
    { title: 'Visual Content Analyst | $70/hr Remote', company: 'Acme' },
  );
});

console.log('\nbrowser profile lock');

test('chromeOnProfile ignores helper processes and unrelated profiles', () => {
  const found = chromeOnProfile('/tmp/definitely-not-a-real-profile-dir');
  assert.deepEqual(found, []);
});

test('reclaimProfile removes stale singleton locks', async () => {
  const { PATHS } = await import('../src/config.js');
  fs.mkdirSync(PATHS.chromeProfile, { recursive: true });
  const lock = path.join(PATHS.chromeProfile, 'SingletonLock');
  fs.rmSync(lock, { force: true });
  fs.symlinkSync('some-host-999999', lock);      // exactly what a crashed Chrome leaves
  assert.ok(fs.lstatSync(lock), 'fixture lock should exist');
  reclaimProfile({ quiet: true });
  assert.equal(fs.existsSync(lock), false, 'stale lock survived reclaim');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
