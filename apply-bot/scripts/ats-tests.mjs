// Phase 5 tests. Vendor detection is pure and fully testable. The apply flow is
// exercised against fixtures shaped like each board's real form — including an
// iframe-embedded one, which is how these boards usually appear on a company's
// own careers domain.
//
// This cannot prove the live selectors still match. It proves the routing,
// frame resolution, prefill handling, parking and never-auto-submit-a-generic-
// form rules hold.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { detectVendor, VENDORS, DEFERRED } from '../src/apply/adapters/index.js';
import { applyExternal } from '../src/apply/external.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

const PROFILE = {
  identity: { firstName: 'Khosi', lastName: 'Siphugu', email: 'k@example.com', phone: '+27 82 000 0000', city: 'Johannesburg', country: 'South Africa' },
  links: { linkedin: 'https://linkedin.com/in/khosi', github: '', portfolio: 'https://khosi.dev' },
  authorization: { countries: { ZA: { authorized: true, requiresSponsorship: false } }, requiresSponsorshipElsewhere: true, willingToRelocate: false, noticePeriodDays: 30, confirmed: true },
  current: { company: 'Hyve Mobile', title: 'AdOps Operations Assistant', totalYearsExperience: 3, confirmed: true },
  education: [], certifications: [],
  skills: { SQL: { years: 3, confirmed: true }, Python: { years: 3, confirmed: false } },
  compensation: { fallbackText: 'Negotiable' }, eeo: {}, misc: { howDidYouHear: 'LinkedIn' },
};
const ctx = { profile: PROFILE, countryCode: 'ZA', company: 'Fixture Co', jobTitle: 'Marketing Analyst' };

section('vendor detection');
t('greenhouse (boards)',      detectVendor('https://boards.greenhouse.io/acme/jobs/123').vendor, 'greenhouse');
t('greenhouse (job-boards)',  detectVendor('https://job-boards.greenhouse.io/acme/jobs/9').vendor, 'greenhouse');
t('lever',                    detectVendor('https://jobs.lever.co/acme/abc-123/apply').vendor, 'lever');
t('lever EU',                 detectVendor('https://jobs.eu.lever.co/acme/x').vendor, 'lever');
t('ashby',                    detectVendor('https://jobs.ashbyhq.com/acme/uuid').vendor, 'ashby');
t('workable',                 detectVendor('https://apply.workable.com/acme/j/ABC/').vendor, 'workable');
t('smartrecruiters',          detectVendor('https://jobs.smartrecruiters.com/Acme/74400').vendor, 'smartrecruiters');
t('unknown falls back',       detectVendor('https://careers.randomco.com/apply').vendor, 'generic');

section('deferred vendors route to manual, never to the generic adapter');
t('workday deferred',  detectVendor('https://acme.wd1.myworkdayjobs.com/en-US/careers/job/x').deferred, true);
t('taleo deferred',    detectVendor('https://acme.taleo.net/careersection/x').deferred, true);
t('icims deferred',    detectVendor('https://careers-acme.icims.com/jobs/123').deferred, true);
t('workday not generic', detectVendor('https://acme.wd1.myworkdayjobs.com/x').vendor, 'workday');
t('every deferred explains why', DEFERRED.every(v => !!v.why), true);
t('every vendor has success patterns', VENDORS.every(v => v.success?.length > 0), true);

// --- fixtures --------------------------------------------------------------
const dir = path.resolve('artifacts');
fs.mkdirSync(dir, { recursive: true });

const greenhouseForm = ({ extraQuestion = '', prefillEmail = '' } = {}) => `
<form id="application-form">
  <label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required>
  <label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required>
  <label for="email">Email *</label><input id="email" name="email" type="text" value="${prefillEmail}" required>
  <label for="phone">Phone</label><input id="phone" name="phone" type="text">
  <label for="resume">Resume/CV</label><input id="resume" name="resume" type="file">
  <label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="linkedin" type="text">
  <fieldset><legend>Are you legally authorized to work in South Africa?</legend>
    <label for="w-y">Yes</label><input id="w-y" type="radio" name="work_auth" value="Yes" required>
    <label for="w-n">No</label><input id="w-n" type="radio" name="work_auth" value="No">
  </fieldset>
  <label for="yrs">How many years of experience do you have with SQL?</label>
  <input id="yrs" name="yrs" type="text" required>
  ${extraQuestion}
  <button id="submit_app" type="submit">Submit Application</button>
</form>
<div id="done" style="display:none">Thank you for applying! Your application has been submitted.</div>
<script>
  document.getElementById('application-form').onsubmit = e => {
    e.preventDefault();
    document.getElementById('application-form').style.display='none';
    document.getElementById('done').style.display='block';
  };
</script>`;

// Serve fixtures at the real vendor URLs via route interception, so vendor
// detection, navigation and frame resolution all behave as they would live.
const ROUTES = new Map();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('**/*', async route => {
  const url = route.request().url();
  const key = [...ROUTES.keys()].find(k => url.startsWith(k));
  if (!key) return route.continue();
  await route.fulfill({ status: 200, contentType: 'text/html', body: `<!DOCTYPE html><body>${ROUTES.get(key)}</body>` });
});

const job = id => ({ id, title: 'Marketing Analyst', company: 'Fixture Co' });
const at = (url, html) => { ROUTES.set(url, html); return url; };

section('greenhouse — review mode fills but does not submit');
const GH = at('https://boards.greenhouse.io/fixture/jobs/1', greenhouseForm());
const r2 = await applyExternal(page, { ...job(8002), external_apply_url: GH }, ctx, { submit: false });
t('detects greenhouse', r2.vendor, 'greenhouse');
t('outcome ready', r2.outcome, 'ready');
t('did not submit', await page.locator('#done').isVisible(), false);
const q = k => r2.filled.find(f => f.question.toLowerCase().includes(k));
t('first name from profile', q('first name').value, 'Khosi');
t('email from profile', q('email').value, 'k@example.com');
t('linkedin from profile', q('linkedin').value, 'https://linkedin.com/in/khosi');
t('authorisation answered', q('authorized').value, 'Yes');
t('years from confirmed skill', q('years of experience').value, '3');
t('every value carries a tier', r2.filled.every(f => !!f.tier), true);

section('greenhouse — auto mode submits and confirms');
const r3 = await applyExternal(page, { ...job(8003), external_apply_url: GH }, ctx, { submit: true });
t('outcome submitted', r3.outcome, 'submitted');
t('confirmation shown', await page.locator('#done').isVisible(), true);
t('evidence captured', !!r3.evidence, true);

section('lever and ashby route through the same flow');
const LV = at('https://jobs.lever.co/fixture/abc/apply', greenhouseForm().replace('id="application-form"', 'class="application-form"').replace('id="submit_app"', 'id="btn-submit"'));
const r3b = await applyExternal(page, { ...job(8009), external_apply_url: LV }, ctx, { submit: true });
t('lever submitted', [r3b.vendor, r3b.outcome], ['lever', 'submitted']);
const AS = at('https://jobs.ashbyhq.com/fixture/uuid', greenhouseForm().replace('id="application-form"', 'class="_form_x1"').replace('id="submit_app"', 'data-x="1"'));
const r3c = await applyExternal(page, { ...job(8010), external_apply_url: AS }, ctx, { submit: true });
t('ashby submitted', [r3c.vendor, r3c.outcome], ['ashby', 'submitted']);

section('parking — an unconfirmed skill stops an external application too');
const GHP = at('https://boards.greenhouse.io/fixture/jobs/2', greenhouseForm({
  extraQuestion: '<label for="py">How many years of experience do you have with Python?</label><input id="py" name="py" type="text" required>',
}));
const r4 = await applyExternal(page, { ...job(8004), external_apply_url: GHP }, ctx, { submit: true });
t('outcome parked', r4.outcome, 'parked');
t('parked on Python', /python/i.test(r4.parked[0].question), true);
t('did not submit despite auto', await page.locator('#done').isVisible(), false);

section('prefilled values are not clobbered');
const GHPRE = at('https://boards.greenhouse.io/fixture/jobs/3', greenhouseForm({ prefillEmail: 'k@example.com' }));
const r5 = await applyExternal(page, { ...job(8005), external_apply_url: GHPRE }, ctx, { submit: false });
t('email marked prefilled', r5.filled.find(f => f.question.toLowerCase().includes('email')).tier, 'prefilled');

section('iframe-embedded board — the form is not in the main frame');
at('https://boards.greenhouse.io/embed/job_app', greenhouseForm());
const EMB = at('https://careers.fixture.com/jobs/1',
  '<h1>Careers at Fixture Co</h1><iframe src="https://boards.greenhouse.io/embed/job_app" width="900" height="700"></iframe>');
const r6 = await applyExternal(page, { ...job(8006), external_apply_url: EMB }, ctx, { submit: false });
t('finds the form inside the iframe', r6.outcome, 'ready');
t('filled fields in the iframe', r6.filled.length > 4, true);

section('generic adapter never auto-submits an unknown form');
const GEN = at('https://careers.randomco.com/apply/1', greenhouseForm().replace('id="application-form"', 'id="custom-form"'));
const r7 = await applyExternal(page, { ...job(8007), external_apply_url: GEN }, ctx, { submit: true });
t('vendor is generic', r7.vendor, 'generic');
t('held for review despite submit:true', r7.outcome, 'ready');
t('explains why it was held', /never auto-submits/.test(r7.heldForReview || ''), true);
t('nothing submitted', await page.locator('#done').isVisible(), false);

section('deferred vendor short-circuits to manual');
const r8 = await applyExternal(page, { ...job(8008), external_apply_url: 'https://acme.wd1.myworkdayjobs.com/careers/job/1' },
  ctx, { submit: true });
t('outcome manual', r8.outcome, 'manual');
t('vendor workday', r8.vendor, 'workday');
t('gives a reason', /per-tenant account/.test(r8.reason), true);

await browser.close();
for (let i = 8001; i <= 8010; i++) fs.rmSync(path.join(dir, 'screenshots', String(i)), { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
