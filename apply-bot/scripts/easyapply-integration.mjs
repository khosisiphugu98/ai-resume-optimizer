// Integration test for the Easy Apply step machine against a local fixture that
// reproduces LinkedIn's multi-step modal: Next → Review → Submit, with the same
// aria-labels the real flow uses.
//
// This cannot prove the real selectors are right — only a live run can. It does
// prove the loop advances, resolves, fills, parks correctly and never submits in
// review mode.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { applyEasy } from '../src/apply/linkedin-easy.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const PROFILE = {
  identity: { firstName: 'Khosi', lastName: 'Siphugu', email: 'k@example.com', phone: '+27 82 000 0000', city: 'Johannesburg', country: 'South Africa' },
  links: { linkedin: 'https://linkedin.com/in/khosi', github: '', portfolio: '' },
  authorization: { countries: { ZA: { authorized: true, requiresSponsorship: false } }, requiresSponsorshipElsewhere: true, willingToRelocate: false, noticePeriodDays: 30, confirmed: true },
  current: { company: 'Hyve Mobile', title: 'AdOps Operations Assistant', totalYearsExperience: 3, confirmed: true },
  education: [], certifications: [],
  skills: { SQL: { years: 3, confirmed: true }, Python: { years: 3, confirmed: false } },
  compensation: { fallbackText: 'Negotiable' }, eeo: {}, misc: { howDidYouHear: 'LinkedIn' },
};

function fixture({ askUnanswerable }) {
  return `<!DOCTYPE html><body>
<button class="jobs-apply-button">Easy Apply</button>
<div id="modal" style="display:none" class="jobs-easy-apply-modal">
  <button aria-label="Dismiss">×</button>
  <div id="s1">
    <label for="email">Email address</label><input id="email" type="text">
    <label for="phone">Mobile phone number</label><input id="phone" type="text" required>
    <input id="cv" type="file" aria-label="Upload resume">
    <button aria-label="Continue to next step">Next</button>
  </div>
  <div id="s2" style="display:none">
    <label for="yrs">How many years of work experience do you have with SQL?</label>
    <input id="yrs" type="text" aria-required="true">
    ${askUnanswerable ? `<label for="py">How many years of work experience do you have with Python?</label><input id="py" type="text" aria-required="true">` : ''}
    <fieldset><legend>Are you legally authorised to work in South Africa?</legend>
      <label for="a-y">Yes</label><input id="a-y" type="radio" name="auth" value="Yes" required>
      <label for="a-n">No</label><input id="a-n" type="radio" name="auth" value="No">
    </fieldset>
    <input id="follow-company-checkbox" type="checkbox" checked>
    <button aria-label="Review your application">Review</button>
  </div>
  <div id="s3" style="display:none">
    <p>Review your application</p>
    <button aria-label="Submit application">Submit application</button>
  </div>
</div>
<div id="sent" style="display:none">Application sent</div>
<script>
  const show = id => { for (const s of ['s1','s2','s3']) document.getElementById(s).style.display = s === id ? 'block' : 'none'; };
  document.querySelector('.jobs-apply-button').onclick = () => { document.getElementById('modal').style.display='block'; show('s1'); };
  document.querySelector('[aria-label="Continue to next step"]').onclick = () => show('s2');
  document.querySelector('[aria-label="Review your application"]').onclick = () => show('s3');
  document.querySelector('[aria-label="Submit application"]').onclick = () => {
    document.getElementById('modal').style.display='none';
    document.getElementById('sent').style.display='block';
  };
  document.querySelector('[aria-label="Dismiss"]').onclick = () => { document.getElementById('modal').style.display='none'; };
</script></body>`;
}

const dir = path.resolve('artifacts');
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
const ctx = { profile: PROFILE, countryCode: 'ZA', company: 'Fixture Co', ats: 'linkedin', jobTitle: 'Marketing Analyst' };

// --- review mode: fills everything, captures it, never submits -------------
const f1 = path.join(dir, '_ea-ok.html');
fs.writeFileSync(f1, fixture({ askUnanswerable: false }));
const job1 = { id: 9001, url: 'file://' + f1, title: 'Marketing Analyst', company: 'Fixture Co' };

console.log('\nreview mode — fills every step, submits nothing');
const r1 = await applyEasy(page, job1, ctx, { submit: false });
t('reaches the submit step', r1.outcome, 'ready');
t('walked all three steps', r1.steps, 3);
t('did NOT submit', await page.locator('#sent').isVisible(), false);
const q = k => r1.filled.find(f => f.question.includes(k));
t('filled email from profile', q('Email').value, 'k@example.com');
t('filled phone from profile', q('Mobile').value, '+27 82 000 0000');
t('answered years from confirmed skill', q('SQL').value, '3');
t('answered authorisation', q('authorised').value, 'Yes');
t('every value traced to a tier', r1.filled.every(f => !!f.tier), true);
t('captured a screenshot per step', r1.screenshots.length >= 3, true);

// --- auto mode: submits ----------------------------------------------------
console.log('\nauto mode — submits and confirms');
const r2 = await applyEasy(page, job1, ctx, { submit: true });
t('outcome is submitted', r2.outcome, 'submitted');
t('confirmation visible', await page.locator('#sent').isVisible(), true);
t('evidence screenshot captured', !!r2.evidence, true);

// --- parking: an unconfirmed skill stops the whole application -------------
console.log('\nparking — an unanswerable question abandons rather than guessing');
const f2 = path.join(dir, '_ea-park.html');
fs.writeFileSync(f2, fixture({ askUnanswerable: true }));
const job2 = { id: 9002, url: 'file://' + f2, title: 'Marketing Analyst', company: 'Fixture Co' };
const r3 = await applyEasy(page, job2, ctx, { submit: true });
t('outcome is parked', r3.outcome, 'parked');
t('parked on the Python question', /python/i.test(r3.parked[0].question), true);
t('reason names the unconfirmed skill', /not confirmed/.test(r3.parked[0].reason), true);
t('did NOT submit despite auto mode', await page.locator('#sent').isVisible(), false);
t('modal was closed', await page.locator('#modal').isVisible(), false);

// --- follow-company is never left on ---------------------------------------
console.log('\nhygiene');
await page.goto('file://' + f1);
await applyEasy(page, job1, ctx, { submit: false });
t('follow-company unchecked', await page.evaluate(() => document.getElementById('follow-company-checkbox').checked), false);

await browser.close();
fs.rmSync(f1, { force: true });
fs.rmSync(f2, { force: true });
fs.rmSync(path.join(dir, 'screenshots/9001'), { recursive: true, force: true });
fs.rmSync(path.join(dir, 'screenshots/9002'), { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
