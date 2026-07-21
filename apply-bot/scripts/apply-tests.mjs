// Phase 4 tests. The Easy Apply DOM cannot be tested without LinkedIn, so the
// field extractor is exercised against a local fixture that reproduces the shapes
// LinkedIn actually uses (labelled inputs, radio fieldsets, selects, file inputs).
// Rate limiting and mode gating are tested directly.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { collectFieldsInPage, fillField } from '../src/apply/fields.js';
import { canApply, withinHours, capRemaining } from '../src/apply/rate.js';
import { db, bumpRate, setSetting } from '../src/db.js';
import { CAPS } from '../src/config.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

// A fixture mirroring the LinkedIn Easy Apply modal's field shapes.
const FIXTURE = `<!DOCTYPE html><body><div class="jobs-easy-apply-modal">
  <div class="fb-dash-form-element">
    <label for="email">Email address</label>
    <input id="email" type="text" value="pre@filled.com" required>
  </div>
  <div class="fb-dash-form-element">
    <label for="phone">Mobile phone number</label>
    <input id="phone" type="text" required>
  </div>
  <div class="fb-dash-form-element">
    <label for="yrs">How many years of work experience do you have with SQL?</label>
    <input id="yrs" type="text" aria-required="true">
  </div>
  <fieldset>
    <legend>Are you legally authorised to work in South Africa?</legend>
    <label for="auth-y">Yes</label><input id="auth-y" type="radio" name="auth" value="Yes" required>
    <label for="auth-n">No</label><input id="auth-n" type="radio" name="auth" value="No">
  </fieldset>
  <fieldset>
    <legend>Do you require visa sponsorship?</legend>
    <label for="sp-y">Yes</label><input id="sp-y" type="radio" name="sponsor" value="Yes">
    <label for="sp-n">No</label><input id="sp-n" type="radio" name="sponsor" value="No">
  </fieldset>
  <div class="fb-dash-form-element">
    <label for="notice">What is your notice period?</label>
    <select id="notice"><option>Select an option</option><option>Immediately</option><option>30 days</option><option>60 days</option></select>
  </div>
  <div class="fb-dash-form-element">
    <label for="cover">Why do you want this role?</label>
    <textarea id="cover"></textarea>
  </div>
  <input id="cv" type="file" aria-label="Upload resume">
  <input id="hidden-thing" type="hidden" value="x">
  <button id="btn" type="button">Not a field</button>
  <div style="display:none"><label for="invisible">Hidden question</label><input id="invisible" type="text"></div>
</div></body>`;

const tmp = path.resolve('artifacts/_apply-fixture.html');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, FIXTURE);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + tmp);

section('field extraction from an Easy Apply-shaped modal');
const fields = await page.evaluate(collectFieldsInPage, '.jobs-easy-apply-modal');
const byQ = q => fields.find(f => f.question === q);

t('finds every visible field, skips hidden/buttons', fields.length, 8);
t('label[for] resolves the question', !!byQ('Email address'), true);
t('reads the pre-filled value', byQ('Email address').currentValue, 'pre@filled.com');
t('radio group collapses to one field', fields.filter(f => f.name === 'auth').length, 1);
t('radio question comes from the legend', !!byQ('Are you legally authorised to work in South Africa?'), true);
t('radio options extracted', byQ('Are you legally authorised to work in South Africa?').options, ['Yes', 'No']);
t('select strips the placeholder option', byQ('What is your notice period?').options, ['Immediately', '30 days', '60 days']);
t('textarea typed correctly', byQ('Why do you want this role?').fieldType, 'textarea');
t('file input found via aria-label', !!fields.find(f => f.kind === 'file'), true);
t('aria-required counts as required', byQ('How many years of work experience do you have with SQL?').required, true);
t('invisible field excluded', fields.some(f => f.question === 'Hidden question'), false);

section('filling');
t('fills text', await fillField(page, byQ('Mobile phone number'), '+27 82 000 0000'), '+27 82 000 0000');
t('  → landed in DOM', await page.inputValue('#phone'), '+27 82 000 0000');

t('checks the right radio', await fillField(page, byQ('Do you require visa sponsorship?'), 'No'), 'No');
t('  → No checked, Yes not', await page.evaluate(() => [document.getElementById('sp-n').checked, document.getElementById('sp-y').checked]), [true, false]);

t('selects by label', await fillField(page, byQ('What is your notice period?'), '30 days'), '30 days');
t('  → select value set', await page.inputValue('#notice'), '30 days');

let threw = null;
try { await fillField(page, byQ('What is your notice period?'), '45 days'); } catch (e) { threw = e.message; }
t('rejects a value not on offer', /not one of/.test(threw || ''), true);

await browser.close();
fs.rmSync(tmp, { force: true });

section('rate limiting — per-channel, not one shared budget');
db.exec('DELETE FROM rate_ledger');
t('external cap is far higher than easy apply', CAPS.external_ats > CAPS.linkedin_easy * 2, true);
t('fresh day, easy apply allowed', canApply('linkedin_easy', { ignoreHours: true }).ok, true);
t('remaining starts at cap', capRemaining('linkedin_easy'), CAPS.linkedin_easy);

for (let i = 0; i < CAPS.linkedin_easy; i++) bumpRate('linkedin_easy');
t('easy apply blocked at cap', canApply('linkedin_easy', { ignoreHours: true }).ok, false);
t('  → reason names the cap', /daily cap reached/.test(canApply('linkedin_easy', { ignoreHours: true }).reason), true);
t('external channel unaffected by it', canApply('external_ats', { ignoreHours: true }).ok, true);

section('challenge halt is global and sticky');
bumpRate('challenges_hit');
t('easy apply halted', canApply('external_ats', { ignoreHours: true }).ok, false);
t('  → reason mentions the challenge', /challenge/.test(canApply('external_ats', { ignoreHours: true }).reason), true);
db.exec('DELETE FROM rate_ledger');

section('operating hours');
t('Tuesday 10:00 SAST is in hours', withinHours(new Date('2026-07-21T08:00:00Z')).ok, true);
t('Tuesday 03:00 SAST is not', withinHours(new Date('2026-07-21T01:00:00Z')).ok, false);
t('Saturday is not', withinHours(new Date('2026-07-25T10:00:00Z')).ok, false);

section('observe mode applies to nothing');
setSetting('mode', 'observe');
const { runApplications } = await import('../src/apply/run.js');
const r = await runApplications({ mode: 'observe' });
t('no attempts made', r.attempted, 0);
db.exec("DELETE FROM events");

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
