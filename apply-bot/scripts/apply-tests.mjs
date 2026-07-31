// Phase 4 tests. The Easy Apply DOM cannot be tested without LinkedIn, so the
// field extractor is exercised against a local fixture that reproduces the shapes
// LinkedIn actually uses (labelled inputs, radio fieldsets, selects, file inputs).
// Rate limiting and mode gating are tested directly.
import './_sandbox.mjs';   // refuses to run against the real database
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { collectFieldsInPage, fillField, isSiteSearch } from '../src/apply/fields.js';
import { canApply, withinHours, capRemaining, pageviewBudget, pageviewsRemaining } from '../src/apply/rate.js';
import { HOURS } from '../src/config.js';
import { db, bumpRate, setSetting, getSetting, appliedUrlOwner, normaliseApplyUrl } from '../src/db.js';
import { runWizard, stepSignature } from '../src/apply/wizard.js';
import { contextLost, lostContextBreaker } from '../src/browser.js';
import { CAPS, PAGEVIEW_FLOORS } from '../src/config.js';

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
  <!--
    LinkedIn's current form builder, verified live on job 280 (JMR Software).
    The radio inputs carry NO name attribute — the group is expressed by the
    fieldset's role=radiogroup and by a shared urn:li: id prefix. Grouping on
    the name attribute alone skipped these entirely, so three required questions
    were invisible, the step was submitted with them blank, LinkedIn showed
    "This field is required" and re-rendered, and the wizard reported "form did
    not advance". That gap is the largest single cause of Easy Apply's 0/14.
  -->
  <fieldset role="radiogroup" data-test-form-builder-radio-button-form-component>
    <div data-test-form-builder-radio-button-form-component__title>Do you have experience developing or working with Power BI semantic models?</div>
    <input id="urn:li:fs-1-0" type="radio" value="Yes"><label for="urn:li:fs-1-0">Yes</label>
    <input id="urn:li:fs-1-1" type="radio" value="No"><label for="urn:li:fs-1-1">No</label>
  </fieldset>
  <fieldset role="radiogroup" data-test-form-builder-radio-button-form-component>
    <div data-test-form-builder-radio-button-form-component__title>Do you have experience contributing to data modelling or the design of data models?</div>
    <input id="urn:li:fs-2-0" type="radio" value="Yes"><label for="urn:li:fs-2-0">Yes</label>
    <input id="urn:li:fs-2-1" type="radio" value="No"><label for="urn:li:fs-2-1">No</label>
  </fieldset>
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

t('finds every visible field, skips hidden/buttons', fields.length, 10);

// The live failure: three required radio groups with no name attribute were
// never collected, so the step was submitted blank and LinkedIn refused to
// advance. The group is the fieldset, whether or not the inputs are named.
section('a radio group LinkedIn did not give a name to');
{
  const q = 'Do you have experience developing or working with Power BI semantic models?';
  const rg = byQ(q);
  t('is collected at all', !!rg, true);
  t('as one field, not two', fields.filter(f => f.question === q).length, 1);
  t('with its options', rg?.options, ['Yes', 'No']);
  t('and its title as the question', rg?.kind, 'radio');
  t('both nameless groups are distinct',
    new Set(fields.filter(f => f.kind === 'radio').map(f => f.selector)).size, 4);
  t('a named group still groups on its name', !!byQ('Are you legally authorised to work in South Africa?'), true);
}
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

// The group has no name, so the selector is the tagged fieldset. Filling one
// must not reach into the other — they offer identical Yes/No options and are
// told apart only by their container.
t('checks a radio in a nameless group',
  await fillField(page, byQ('Do you have experience developing or working with Power BI semantic models?'), 'Yes'), 'Yes');
t('  → the right group, and only that group',
  await page.evaluate(() => [
    document.getElementById('urn:li:fs-1-0').checked,
    document.getElementById('urn:li:fs-2-0').checked,
    document.getElementById('urn:li:fs-2-1').checked,
  ]), [true, false, false]);
t('and the second group answers independently',
  await fillField(page, byQ('Do you have experience contributing to data modelling or the design of data models?'), 'No'), 'No');
t('  → without disturbing the first',
  await page.evaluate(() => [
    document.getElementById('urn:li:fs-1-0').checked,
    document.getElementById('urn:li:fs-2-1').checked,
  ]), [true, true]);

t('selects by label', await fillField(page, byQ('What is your notice period?'), '30 days'), '30 days');
t('  → select value set', await page.inputValue('#notice'), '30 days');

let threw = null;
try { await fillField(page, byQ('What is your notice period?'), '45 days'); } catch (e) { threw = e.message; }
t('rejects a value not on offer', /not one of/.test(threw || ''), true);

// Job 453 got stuck at step 3 and reported LinkedIn's own navigation as the
// application form — a "Search" textbox, a "Select language" combobox, another
// "Search". The modal had closed under the collector, and `|| document.body`
// quietly widened the root to the whole site.
section('a root that has gone away yields nothing, not the whole page (D4)');
t('a missing root collects no fields',
  (await page.evaluate(collectFieldsInPage, '.no-such-modal')).length, 0);
t('an explicit body root still works',
  (await page.evaluate(collectFieldsInPage, 'body')).length > 0, true);
t('the modal root is unaffected',
  (await page.evaluate(collectFieldsInPage, '.jobs-easy-apply-modal')).length, 10);

section('the site\'s own chrome is not a screening question');
t('LinkedIn\'s header search', isSiteSearch('Search'), true);
t('and its language picker', isSiteSearch('Select language'), true);
t('CareerJunction\'s search bar', isSiteSearch('Job title, skill or company'), true);
t('a real question is untouched', isSiteSearch('How many years of SQL experience?'), false);
t('and so is one that merely mentions searching',
  isSiteSearch('Describe your approach to keyword search'), false);

await browser.close();
fs.rmSync(tmp, { force: true });

// The Agoda submission recorded 31 fields for 18 unique questions — 13 asked
// twice and answered twice, identically, because the form root held two copies
// of the control set. That doubled the model spend on every such application and
// made every field count in the system wrong.
section('one question, however many controls carry it (D12)');
{
  const nodes = [
    { uid: 'email-desktop', role: 'input', question: 'Email address', options: null },
    { uid: 'email-mobile', role: 'input', question: 'Email address', options: null },
    { uid: 'name', role: 'input', question: 'Full name', options: null },
    // Same label, different choices — two questions, however alike they read.
    { uid: 'country-a', role: 'select', question: 'Country', options: ['South Africa', 'Kenya'] },
    { uid: 'country-b', role: 'select', question: 'Country', options: ['ZA', 'KE'] },
  ];
  const asked = [];
  const typed = [];

  const r = await runWizard({
    submit: false,
    collect: async () => nodes,
    resolve: async items => {
      asked.push(...items.map(i => i.uid));
      return {
        resolved: items.map(i => ({
          status: 'ok', uid: i.uid, question: i.question, fieldType: 'text',
          options: i.options, value: `v:${i.question}`, tier: 'profile',
        })),
        parked: [],
      };
    },
    fill: async (node, value) => { typed.push(node.uid); return value; },
    findAdvance: async () => null,
    findTerminal: async () => ({ click: async () => {} }),
    signature: stepSignature,
  });

  t('the duplicate control is never asked about', asked.includes('email-mobile'), false);
  t('four questions asked, not five', asked.length, 4);
  t('but every control is still typed into', typed.length, 5);
  t('and the answer is recorded once', r.filled.length, 4);
  t('carrying how many controls took it', r.filled.find(f => f.uid === 'email-desktop').copies, 2);
  t('a single control records no copy count', r.filled.find(f => f.uid === 'name').copies, undefined);
  t('two option lists are two questions', asked.filter(u => u.startsWith('country')).length, 2);
}

// One live attempt screenshotted the Easy Apply modal 152ms after it opened,
// still showing its loading spinner, and a single check concluded "step 1 has no
// next, review or submit control" on a form that rendered fine a moment later.
// That reason accounts for 18 failures on the board.
section('a step still rendering is not a step with no way forward');
{
  const drive = async ({ appearsAfter }) => {
    let looks = 0;
    return runWizard({
      submit: false,
      collect: async () => [{ uid: 'a', role: 'input', question: 'Email', options: null }],
      resolve: async items => ({
        resolved: items.map(i => ({ status: 'ok', uid: i.uid, question: i.question, value: 'v', tier: 'profile' })),
        parked: [],
      }),
      fill: async () => 'v',
      // The footer arrives after the body, so the first N looks find nothing.
      findTerminal: async () => (++looks > appearsAfter ? { click: async () => {} } : null),
      findAdvance: async () => null,
      signature: stepSignature,
    });
  };

  const late = await drive({ appearsAfter: 3 });
  t('a footer that arrives late is still found', late.outcome, 'ready');

  const never = await drive({ appearsAfter: 10_000 });
  t('a step that genuinely has none is still abandoned', never.outcome, 'stuck');
  t('and says it waited', /still none after/.test(never.reason || ''), true);
}

// Easy Apply's later screens review the imported work history and the résumé:
// read-only cards, not one fillable control between them. Every such screen
// signs as "" and compares equal to the next, so job 453 advanced correctly from
// step 3 to step 4 and was abandoned as "form did not advance past step 3".
section('a step with nothing to fill is not a step that did not move');
{
  const review = [];                                    // a review screen: no fields
  const form = [{ uid: 'a', role: 'input', question: 'Email', options: null }];

  const drive = async ({ signature, steps = 3 }) => {
    let step = 0;
    return runWizard({
      submit: false,
      collect: async () => (++step > 1 && step <= steps ? review : (step === 1 ? form : review)),
      resolve: async items => ({
        resolved: items.map(i => ({ status: 'ok', uid: i.uid, question: i.question, value: 'v', tier: 'profile' })),
        parked: [],
      }),
      fill: async () => 'v',
      findAdvance: async () => ({ click: async () => {}, page: () => ({ waitForTimeout: async () => {} }) }),
      findTerminal: async () => null,
      signature,
    });
  };

  // The old behaviour: two field-less screens in a row read as a stuck form.
  const bare = await drive({ signature: stepSignature });
  t('an empty signature no longer means stuck', bare.outcome === 'stuck' && /did not advance/.test(bare.reason || ''), false);
  t('it runs to the step ceiling instead, which costs nothing', /exceeded \d+ steps/.test(bare.reason || ''), true);

  // An adapter that can describe the screen keeps the detector working: two
  // renders of the same screen are still caught on the first repeat.
  const same = await drive({ signature: async () => 'the same screen every time' });
  t('a repeated described screen is still caught', /did not advance/.test(same.reason || ''), true);

  // And a genuinely advancing form is never mistaken for a stuck one.
  let n = 0;
  const moving = await drive({ signature: async () => `screen ${n++}` });
  t('a moving form is not', /did not advance/.test(moving.reason || ''), false);
}

// Two LinkedIn cards for the same Agoda posting differed only by a tracking
// token, so the duplicate guard did not fire: one was submitted and the other
// filled the same posting again, stopped only by an unrelated park.
section('the same posting, two tracking tokens (D13)');
{
  const GH = 'https://job-boards.greenhouse.io/agoda/jobs/5794753';
  t('a tracking parameter is not part of the identity',
    normaliseApplyUrl(`${GH}?gh_src=ec760f9d1`), normaliseApplyUrl(`${GH}?gh_src=e13c735b1`));
  t('nor is utm, a fragment, a trailing slash or the www',
    normaliseApplyUrl('https://www.acme.com/apply/?utm_source=li#form'),
    normaliseApplyUrl('https://acme.com/apply'));
  t('but a different job id still is',
    normaliseApplyUrl(`${GH}?gh_src=a`) === normaliseApplyUrl('https://job-boards.greenhouse.io/agoda/jobs/1?gh_src=a'), false);
  t('and a real query parameter is kept',
    normaliseApplyUrl('https://acme.com/apply?jobId=42') === normaliseApplyUrl('https://acme.com/apply'), false);

  db.prepare(`INSERT INTO jobs (id, external_id, url, title, company, discovered_at, apply_type, external_apply_url, status)
              VALUES (9101, 'dup-a', 'x', 'Data Analyst', 'Agoda', datetime('now'), 'external', ?, 'submitted')`)
    .run(`${GH}?gh_src=ec760f9d1`);
  db.prepare(`INSERT INTO applications (job_id, channel, outcome) VALUES (9101, 'external_ats', 'submitted_unconfirmed')`).run();

  t('a second card for the same posting finds its twin',
    appliedUrlOwner(`${GH}?gh_src=e13c735b1`, 9102), 9101);
  t('the job that sent it is not its own twin',
    appliedUrlOwner(`${GH}?gh_src=ec760f9d1`, 9101), null);
  t('a genuinely different posting is not blocked',
    appliedUrlOwner('https://job-boards.greenhouse.io/agoda/jobs/999', 9102), null);

  // Every suite shares one throwaway database, and a later one clears `jobs`.
  // Leaving an application row behind would fail that delete on the foreign key.
  db.prepare('DELETE FROM applications WHERE job_id = 9101').run();
  db.prepare('DELETE FROM jobs WHERE id = 9101').run();
}

// `npm run score` was started while `npm run tailor` was working, and score's
// exit handler SIGKILLed the browser tailor was driving. Tailor did not notice:
// it kept selecting jobs and marking each one failed, burning twelve in forty
// seconds on an error that had nothing to do with any of them.
section('a lost browser is not the posting\'s fault (D6)');
{
  const LOST = new Error('page.goto: Target page, context or browser has been closed');

  t('a lost context is recognised', contextLost(LOST), true);
  t('and so is the bare form', contextLost(new Error('Session closed. Most likely the page has been closed.')), true);
  t('a real page failure is not', contextLost(new Error('No apply button after 10s')), false);
  t('nor is a selector timeout', contextLost(new Error('locator.fill: Timeout 30000ms exceeded')), false);

  const b = lostContextBreaker();
  t('one is survivable', [b.record(LOST), b.tripped], [true, false]);
  t('two is survivable', [b.record(LOST), b.tripped], [true, false]);
  t('three stops the stage', [b.record(LOST), b.tripped], [true, true]);

  const c = lostContextBreaker();
  c.record(LOST); c.record(LOST);
  t('an ordinary failure resets the streak', [c.record(new Error('nope')), c.streak], [false, 0]);
  t('so an intermittent one never trips it', [c.record(LOST), c.tripped], [true, false]);
}

section('rate limiting — per-channel, not one shared budget');
db.exec('DELETE FROM rate_ledger');
t('external cap is far higher than easy apply', CAPS.external_ats > CAPS.linkedin_easy * 2, true);
t('fresh day, easy apply allowed', canApply('linkedin_easy', { ignoreHours: true }).ok, true);
t('remaining starts at cap', capRemaining('linkedin_easy'), CAPS.linkedin_easy);

for (let i = 0; i < CAPS.linkedin_easy; i++) bumpRate('linkedin_easy');
t('easy apply blocked at cap', canApply('linkedin_easy', { ignoreHours: true }).ok, false);
t('  → reason names the cap', /daily cap reached/.test(canApply('linkedin_easy', { ignoreHours: true }).reason), true);
t('external channel unaffected by it', canApply('external_ats', { ignoreHours: true }).ok, true);

// A LinkedIn checkpoint is a LinkedIn problem. It used to halt every channel,
// including emailed CVs and third-party ATS forms that LinkedIn cannot see — a
// blast radius three times larger than the thing being protected, and with no
// auto-recovery short of the day rolling over.
section('a challenge halts LinkedIn, and only LinkedIn');
bumpRate('challenges_hit');
t('easy apply halted', canApply('linkedin_easy', { ignoreHours: true }).ok, false);
t('  → reason mentions the challenge', /challenge/.test(canApply('linkedin_easy', { ignoreHours: true }).reason), true);
t('external keeps going', canApply('external_ats', { ignoreHours: true }).ok, true);
t('email keeps going', canApply('email', { ignoreHours: true }).ok, true);
db.exec('DELETE FROM rate_ledger');

// One budget, three consumers, three floors. Discovery gives way to apply, and
// within apply external gives way to Easy Apply. Before the floors existed the
// budget was first-come-first-served and discovery always came first: it spent
// all 250 by mid-morning for three days running while apply got nothing.
section('the pageview budget is spent in priority order');
const spendTo = left => {
  db.exec('DELETE FROM rate_ledger');
  for (let i = 0; i < CAPS.linkedin_pageviews - left; i++) bumpRate('linkedin_pageviews');
};

spendTo(PAGEVIEW_FLOORS.browse + 1);
t('browsing runs while above its floor', pageviewBudget('browse').ok, true);
spendTo(PAGEVIEW_FLOORS.browse);
t('browsing stops at its floor', pageviewBudget('browse').ok, false);
t('  → reason names the reserve', /reserved for higher-priority work/.test(pageviewBudget('browse').reason), true);
t('external still has budget', canApply('external_ats', { ignoreHours: true }).ok, true);
t('easy apply still has budget', canApply('linkedin_easy', { ignoreHours: true }).ok, true);

spendTo(PAGEVIEW_FLOORS.external_ats);
t('external stops at its floor', canApply('external_ats', { ignoreHours: true }).ok, false);
t('  → easy apply keeps what external left', canApply('linkedin_easy', { ignoreHours: true }).ok, true);

spendTo(0);
t('easy apply may spend the last one, then stops', canApply('linkedin_easy', { ignoreHours: true }).ok, false);
t('  → reason names the budget', /pageview budget exhausted/.test(canApply('linkedin_easy', { ignoreHours: true }).reason), true);

// The floors must actually order the consumers, or they reserve nothing.
t('floors are strictly ordered browse > external > easy',
  PAGEVIEW_FLOORS.browse > PAGEVIEW_FLOORS.external_ats
    && PAGEVIEW_FLOORS.external_ats > PAGEVIEW_FLOORS.linkedin_easy, true);
// A floor below the Easy Apply cap would let discovery starve it again.
t('the reserve covers a full day of Easy Apply', PAGEVIEW_FLOORS.browse >= CAPS.linkedin_easy, true);
db.exec('DELETE FROM rate_ledger');

// HOURS is deliberately 24/7 (config.js:42) — the operator opened external and
// email to round-the-clock volume, and the LinkedIn account is protected by the
// daily caps and channel-aware pacing rather than by the clock. These assert that
// policy; narrowing HOURS again should fail them and be a conscious change.
section('operating hours — 24/7 by policy');
t('Tuesday 10:00 SAST is in hours', withinHours(new Date('2026-07-21T08:00:00Z')).ok, true);
t('Tuesday 03:00 SAST is too', withinHours(new Date('2026-07-21T01:00:00Z')).ok, true);
t('Saturday is too', withinHours(new Date('2026-07-25T10:00:00Z')).ok, true);
t('the window is genuinely open', [HOURS.start, HOURS.end, HOURS.weekdaysOnly], [0, 24, false]);

// This suite runs against the live database (see the header), so a setting it
// writes is a setting the operator is left with. Flipping mode to observe and
// walking away silently halted every application until someone noticed the
// dashboard was idle — a test that stops the system it is testing. Put it back.
section('observe mode applies to nothing');
const modeBefore = getSetting('mode', 'observe');
setSetting('mode', 'observe');
const { runApplications, isDeterministic } = await import('../src/apply/run.js');
const r = await runApplications({ mode: 'observe' });
t('no attempts made', r.attempted, 0);
setSetting('mode', modeBefore);
t('the operator\'s run mode survived the suite', getSetting('mode', null), modeBefore);
db.exec("DELETE FROM events");

// The retry budget is for transient trouble. Spending it on a posting whose
// form does not exist proves the same thing three times and costs three
// pageviews doing it.
section('retries are only spent where a retry could help');
t('missing form is terminal',    isDeterministic('No application form found'), true);
t('unfillable page is terminal', isDeterministic('no fillable fields on this page'), true);
t('login wall is terminal',      isDeterministic('This posting requires an account'), true);
t('a timeout is not terminal',   isDeterministic('Timeout 30000ms exceeded waiting for selector'), false);
t('a lost popup is not terminal', isDeterministic('Target page, context or browser has been closed'), false);
t('a missing selector is not terminal', isDeterministic('locator.click: Element not found'), false);
t('a real 404 is terminal',      isDeterministic('page.goto: 404 Not Found'), true);
t('no message is not terminal',  isDeterministic(''), false);

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
