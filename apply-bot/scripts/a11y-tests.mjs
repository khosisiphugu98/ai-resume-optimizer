// Phase 7 tests — the accessibility-tree collector, batch field mapping and the
// shared wizard.
//
// The forms this adapter exists for cannot be reproduced by pointing at a real
// site, so the fixtures are the shapes that break the DOM collector: custom
// controls with no native element behind them, labels that are labels only
// visually, and a form sealed inside a shadow root.
//
// The batch-mapping tests matter most. Batching is a convenience layer over the
// resolution ladder, and the whole point is that it is *not* a way around the
// controls — so each of those cases is an assertion that a model answer still
// has to get past guardAnswer(), the offered options, and the profile.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { collectA11yInPage, toFieldSpec } from '../src/apply/a11y.js';
import { collectFieldsInPage } from '../src/apply/fields.js';
import { runWizard, stepSignature, buttonByName, ADVANCE_NAME, TERMINAL_NAME } from '../src/apply/wizard.js';
import { resolveFormBatch } from '../src/answer/resolver.js';
import { applyExternal } from '../src/apply/external.js';
import { getSetting, setSetting } from '../src/db.js';

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

const dir = path.resolve('artifacts');
fs.mkdirSync(dir, { recursive: true });

const ROUTES = new Map();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('**/*', async route => {
  const url = route.request().url();
  const key = [...ROUTES.keys()].find(k => url.startsWith(k));
  if (!key) return route.continue();
  await route.fulfill({ status: 200, contentType: 'text/html', body: `<!DOCTYPE html><body>${ROUTES.get(key)}</body>` });
});
const at = (url, html) => { ROUTES.set(url, html); return url; };
const job = id => ({ id, title: 'Marketing Analyst', company: 'Fixture Co' });

const collectAt = async (url, html) => {
  at(url, html);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page.evaluate(collectA11yInPage, 'body');
};
const named = (nodes, needle) => nodes.find(n => n.name.toLowerCase().includes(needle.toLowerCase()));

// ---------------------------------------------------------------------------
section('accessible name resolution follows spec order');
// Every field below is deliberately labelled two ways at once, so the assertion
// is about precedence rather than about finding a label at all.
const names = await collectAt('https://fixture.test/names', `
  <span id="lb1">Labelled by element</span>
  <input id="f1" aria-labelledby="lb1" aria-label="Aria label loses" type="text">

  <label for="f2">Label-for loses</label>
  <input id="f2" aria-label="Aria label wins" type="text">

  <label for="f3">Label-for wins</label>
  <label>wrapping loses <input id="f3" type="text"></label>

  <label>Wrapping label wins <input id="f4" type="text" title="title loses"></label>

  <input id="f5" title="Title beats placeholder" placeholder="placeholder loses" type="text">
  <input id="f6" placeholder="Placeholder is the last resort" type="text">

  <div><p>What is your greatest strength?</p><div id="f7" role="textbox" contenteditable style="width:300px;height:30px;border:1px solid"></div></div>

  <label for="f8">Notice period</label>
  <input id="f8" type="text" aria-describedby="d8">
  <span id="d8">Numbers only, in days</span>
`);

t('aria-labelledby beats aria-label', named(names, 'Labelled by element')?.name, 'Labelled by element');
t('aria-label beats label[for]', names.find(n => n.uid === names.find(x => x.name === 'Aria label wins')?.uid)?.name, 'Aria label wins');
t('label[for] beats a wrapping label', !!named(names, 'Label-for wins'), true);
t('wrapping label beats title', !!named(names, 'Wrapping label wins'), true);
t('title beats placeholder', !!named(names, 'Title beats placeholder'), true);
// A placeholder vanishes the moment anything is typed, so it is the weakest
// possible evidence of what a field is asking for.
t('placeholder is used only as a last resort', !!named(names, 'Placeholder is the last resort'), true);
t('visual-only label above a custom control is found',
  !!named(names, 'What is your greatest strength?'), true);
t('describedby is captured separately',
  named(names, 'Notice period')?.description, 'Numbers only, in days');
t('describedby is not merged into the name',
  /numbers only/i.test(named(names, 'Notice period')?.name || ''), false);

// ---------------------------------------------------------------------------
section('role detection on controls with no native element behind them');
const roles = await collectAt('https://fixture.test/roles', `
  <p>Cover letter</p>
  <div role="textbox" contenteditable style="width:300px;height:40px;border:1px solid"></div>

  <p>Freeform notes</p>
  <div contenteditable style="width:300px;height:40px;border:1px solid"></div>

  <p>Which office?</p>
  <div role="combobox" aria-controls="lst" style="width:200px;height:24px;border:1px solid">Choose…</div>
  <div id="lst" role="listbox">
    <div role="option">Cape Town</div><div role="option">Johannesburg</div>
  </div>

  <div role="radiogroup" aria-label="Are you legally authorised to work in South Africa?">
    <div role="radio" aria-checked="false" style="width:20px;height:20px">Yes</div>
    <div role="radio" aria-checked="false" style="width:20px;height:20px">No</div>
  </div>
`);

t('div[role=textbox] found as a textbox', named(roles, 'Cover letter')?.role, 'textbox');
t('bare [contenteditable] found as a textbox', named(roles, 'Freeform notes')?.role, 'textbox');
t('custom combobox found', named(roles, 'Which office')?.role, 'combobox');
t('its options are read from the listbox it controls',
  named(roles, 'Which office')?.options, ['Cape Town', 'Johannesburg']);
t('radiogroup collapses to one node', roles.filter(n => n.role === 'radiogroup').length, 1);
t('radiogroup keeps its options',
  roles.find(n => n.role === 'radiogroup')?.options, ['Yes', 'No']);
t('radiogroup named from aria-label',
  /authorised to work/i.test(roles.find(n => n.role === 'radiogroup')?.name || ''), true);
// Each option is tagged individually — a custom radio has no `name` attribute to
// group on and no `.check()` to call, so the filler needs a locator per option.
t('each option carries its own locator',
  roles.find(n => n.role === 'radiogroup')?.optionUids.length, 2);

// ---------------------------------------------------------------------------
section('native controls resolve the same as the DOM collector');
const nativeHtml = `
  <form>
    <label for="fn">First Name</label><input id="fn" type="text" required>
    <label for="em">Email</label><input id="em" type="text" required>
    <label for="ct">Cover letter</label><textarea id="ct"></textarea>
    <label for="of">Office</label>
    <select id="of"><option>Cape Town</option><option>Johannesburg</option></select>
    <fieldset><legend>Are you legally authorized to work in South Africa?</legend>
      <label for="wy">Yes</label><input id="wy" type="radio" name="wa" value="Yes" required>
      <label for="wn">No</label><input id="wn" type="radio" name="wa" value="No">
    </fieldset>
  </form>`;
at('https://fixture.test/native', nativeHtml);
await page.goto('https://fixture.test/native', { waitUntil: 'domcontentloaded' });
const viaDom = await page.evaluate(collectFieldsInPage, 'body');
const viaA11y = await page.evaluate(collectA11yInPage, 'body');
const questions = list => list.map(f => f.question ?? f.name).filter(Boolean).sort();

t('both collectors find the same questions', questions(viaA11y), questions(viaDom));
t('select options match',
  viaA11y.find(n => n.role === 'combobox')?.options,
  viaDom.find(f => f.kind === 'select')?.options);
// The fieldset legend is the group's accessible name. Without that rule the
// radio group takes the label of whatever field sits above it.
t('fieldset legend names the radio group',
  viaA11y.find(n => n.role === 'radiogroup')?.name,
  'Are you legally authorized to work in South Africa?');
t('required flags survive', viaA11y.find(n => n.name === 'First Name')?.required, true);

// ---------------------------------------------------------------------------
// A readonly text input is indistinguishable from an editable one by role, so it
// was collected, answered, and handed to locator.fill() — which waits the full 30s
// for an element that will never accept input, throws, and parks the whole
// application. Seen live on a BambooHR posting with a locked apply-URL field.
section('readonly controls are not collected as fillable');
const ro = await collectAt('https://fixture.test/readonly', `
  <form>
    <label for="a">Application URL</label><input id="a" type="text" readonly value="https://x.test/1">
    <label for="b">Notes</label><textarea id="b" readonly>locked</textarea>
    <label for="c">Reference</label><input id="c" type="text" aria-readonly="true">
    <label for="d">Full name</label><input id="d" type="text">
    <label for="e">Agree to terms</label><input id="e" type="checkbox" readonly>
  </form>`);
const roNames = ro.map(n => n.name).filter(Boolean);
t('readonly input skipped', roNames.includes('Application URL'), false);
t('readonly textarea skipped', roNames.includes('Notes'), false);
t('aria-readonly skipped', roNames.includes('Reference'), false);
t('editable input still collected', roNames.includes('Full name'), true);
// `readonly` has no effect on a checkbox per spec, and browsers honour that — the
// user can still toggle it, so skipping it would lose a real question.
t('readonly checkbox still collected', roNames.includes('Agree to terms'), true);

// ---------------------------------------------------------------------------
section('shadow DOM — invisible to querySelectorAll, found here');
const shadow = await collectAt('https://fixture.test/shadow', `
  <div id="host"></div>
  <script>
    const outer = document.getElementById('host').attachShadow({ mode: 'open' });
    outer.innerHTML = \`
      <label for="s1">Email address</label><input id="s1" type="text">
      <div id="inner"></div>\`;
    const inner = outer.getElementById('inner').attachShadow({ mode: 'open' });
    inner.innerHTML = \`
      <label for="s2">Mobile phone number</label><input id="s2" type="text">\`;
  </script>
`);
t('a form inside an open shadow root is found', !!named(shadow, 'Email address'), true);
t('nested shadow roots are traversed', !!named(shadow, 'Mobile phone number'), true);
// The label lives in the same shadow tree as the input, so resolving it against
// the document would find nothing.
t('labels resolve within their own shadow tree',
  named(shadow, 'Mobile phone number')?.name, 'Mobile phone number');
t('the DOM collector genuinely cannot see them',
  (await page.evaluate(collectFieldsInPage, 'body')).length, 0);

// ---------------------------------------------------------------------------
section('batch mapping — one call for the form, every value still guarded');

// Stub the model at the network boundary, so the real callLLM, its JSON parsing
// and every downstream control run exactly as they do in production.
process.env.OPENAI_API_KEY = 'sk-test-fixture';
const realFetch = globalThis.fetch;
let lastPrompt = null;
const stubLLM = reply => {
  globalThis.fetch = async (url, opts) => {
    lastPrompt = JSON.parse(opts.body).messages.map(m => m.content).join('\n');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
    };
  };
};

const field = (uid, question, extra = {}) => ({ uid, question, fieldType: 'text', required: true, ...extra });

stubLLM({ fills: [{ uid: 'q1', value: 'The adtech work is exactly what I do now.' }], unanswerable: [] });
const b1 = await resolveFormBatch([field('q1', 'Why do you want to work here?')], ctx);
t('a drafted answer comes back ok', b1.resolved[0].status, 'ok');
t('tagged as the llm tier', b1.resolved[0].tier, 'llm');
t('nothing parked', b1.parked.length, 0);
t('the whole form goes in one call', /FORM FIELDS/.test(lastPrompt), true);

// guardAnswer is the control, not the prompt. A model that answers "yes" to a
// credential question still cannot get it onto the form.
stubLLM({ fills: [{ uid: 'q1', value: 'Yes' }], unanswerable: [] });
const b2 = await resolveFormBatch(
  [field('q1', 'Do you hold an active security clearance?', { options: ['Yes', 'No'] })], ctx);
t('an answer failing guardAnswer parks instead of filling', b2.parked.length, 1);
t('parked as llm-rejected', b2.parked[0].tier, 'llm-rejected');
t('the reason says the credential is unevidenced',
  /not evidenced in the profile/.test(b2.parked[0].reason), true);

// The two highest-risk question families never reach the model at all — the
// deterministic tier answers them first, so there is nothing for a model to get
// wrong. The stub is left returning a wrong answer to prove it is never used.
stubLLM({ fills: [{ uid: 'q1', value: '7' }], unanswerable: [] });
const b2a = await resolveFormBatch(
  [field('q1', 'How many years of experience do you have with SQL?')], ctx);
t('years of experience never reaches the model',
  [b2a.resolved[0].tier, b2a.resolved[0].value], ['profile', '3']);

stubLLM({ fills: [{ uid: 'q1', value: 'Yes' }], unanswerable: [] });
const b3 = await resolveFormBatch(
  [field('q1', 'Are you legally authorized to work in South Africa?', { options: ['Yes', 'No'] })], ctx);
t('work authorisation resolves from the profile, not the model', b3.resolved[0].tier, 'profile');

// An unconfirmed skill is invisible to the resolver, and the model is not
// offered a second chance at it.
stubLLM({ fills: [{ uid: 'q1', value: '3' }], unanswerable: [] });
const b3a = await resolveFormBatch(
  [field('q1', 'How many years of experience do you have with Python?')], ctx);
t('an unconfirmed skill parks before the model is asked', b3a.parked[0].tier, 'profile');

stubLLM({ fills: [], unanswerable: [{ uid: 'q1', why: 'the profile does not say which languages they speak' }] });
const b4 = await resolveFormBatch([field('q1', 'Which languages do you speak?')], ctx);
t('unanswerable entries park', b4.parked.length, 1);
t('with the reason attached', /languages/.test(b4.parked[0].reason), true);

stubLLM({ fills: [{ uid: 'q1', value: 'Durban' }], unanswerable: [] });
const b5 = await resolveFormBatch(
  [field('q1', 'Which office would you prefer?', { options: ['Cape Town', 'Johannesburg'] })], ctx);
t('an option not on the list parks rather than being forced', b5.parked.length, 1);
t('the reason shows what was offered', /Cape Town \| Johannesburg/.test(b5.parked[0].reason), true);

// Silence is not consent: a field the model simply omitted is unanswered, and
// filling nothing while reporting success would submit a blank required field.
stubLLM({ fills: [], unanswerable: [] });
const b6 = await resolveFormBatch([field('q1', 'Describe a project you are proud of')], ctx);
t('a field the model ignored still parks', b6.parked.length, 1);
t('and says so plainly', /no answer/.test(b6.parked[0].reason), true);

// The deterministic tiers must keep winning, or a stored human-verified answer
// would be re-drafted by the model on every single form.
stubLLM({ fills: [{ uid: 'q1', value: 'nonsense@wrong.com' }], unanswerable: [] });
const b7 = await resolveFormBatch([field('q1', 'Email address')], ctx);
t('the profile still beats the model', [b7.resolved[0].tier, b7.resolved[0].value], ['profile', 'k@example.com']);

globalThis.fetch = realFetch;
delete process.env.OPENAI_API_KEY;

// ---------------------------------------------------------------------------
section('the wizard');

const step = (n, body, btn) => `
  <div id="s${n}" style="display:none">${body}
    <button type="button" class="nav" data-to="${n + 1}">${btn}</button>
  </div>`;

const WIZ = at('https://careers.wizard.test/apply', `
  <form id="f">
    <div id="s1">
      <label for="w-em">Email</label><input id="w-em" type="text" required>
      <label for="w-ph">Mobile phone number</label><input id="w-ph" type="text" required>
      <button type="button" class="nav" data-to="2">Continue</button>
    </div>
    ${step(2, `
      <label for="w-li">LinkedIn Profile</label><input id="w-li" type="text">
      <label for="w-nt">Notice period</label><input id="w-nt" type="text">`, 'Continue')}
    <div id="s3" style="display:none">
      <p>Review your application</p>
      <button type="button" id="go">Submit application</button>
    </div>
  </form>
  <div id="done" style="display:none">Thank you for applying! Your application has been submitted.</div>
  <script>
    const show = n => { for (const s of [1,2,3]) document.getElementById('s'+s).style.display = (s===n?'block':'none'); };
    for (const b of document.querySelectorAll('.nav')) b.onclick = () => show(+b.dataset.to);
    document.getElementById('go').onclick = () => {
      document.getElementById('f').style.display='none';
      document.getElementById('done').style.display='block';
    };
  </script>`);

const w1 = await applyExternal(page, { ...job(9101), external_apply_url: WIZ }, ctx, { submit: false });
t('walks a three-step form', w1.steps, 3);
t('reaches the submit step', w1.outcome, 'ready');
t('filled fields from every step', w1.filled.length >= 4, true);
t('did not submit in review mode', await page.locator('#done').isVisible(), false);
// A "Continue" button is usually type=submit as well. Treating it as the end of
// the form would file a half-finished application and report it as complete.
t('Continue was not mistaken for Submit', !!w1.filled.find(f => /linkedin/i.test(f.question)), true);

const COND = at('https://careers.conditional.test/apply', `
  <form>
    <fieldset><legend>Do you require visa sponsorship?</legend>
      <label for="c-y">Yes</label><input id="c-y" type="radio" name="spon" value="Yes" required>
      <label for="c-n">No</label><input id="c-n" type="radio" name="spon" value="No" required>
    </fieldset>
    <div id="more" style="display:none">
      <label for="c-em">Email</label><input id="c-em" type="text" required>
      <label for="c-ph">Mobile phone number</label><input id="c-ph" type="text" required>
    </div>
    <button type="button" id="sub">Submit application</button>
  </form>
  <script>
    for (const el of document.querySelectorAll('input[name=spon]'))
      el.onchange = () => { document.getElementById('more').style.display = 'block'; };
  </script>`);

const w2 = await applyExternal(page, { ...job(9102), external_apply_url: COND }, ctx, { submit: false });
t('a conditionally revealed field is collected and filled',
  !!w2.filled.find(f => /mobile phone/i.test(f.question)), true);
t('the field that revealed it was filled too',
  !!w2.filled.find(f => /sponsorship/i.test(f.question)), true);
t('one step, not two', w2.steps, 1);

// formScope took the FIRST root with any input at all, so a narrow wrapper
// holding one control beat the real form further down the selector list. That is
// why Greenhouse applications filled the CV attachment and nothing else across
// eight attempts. It picks the richest root now.
section('the form scope is the richest match, not the first');
const SPLIT = at('https://careers.split.test/apply', `
  <div id="upload-panel"><input type="file" id="cv"></div>
  <form id="application-form">
    <label for="s-em">Email</label><input id="s-em" type="text" required>
    <label for="s-ph">Mobile phone number</label><input id="s-ph" type="text" required>
    <label for="s-li">LinkedIn Profile</label><input id="s-li" type="text" required>
    <button type="button" id="sub">Submit application</button>
  </form>`);
const w5 = await applyExternal(page, { ...job(9106), external_apply_url: SPLIT }, ctx, { submit: false });
t('found the real form, not the upload wrapper', w5.filled.length >= 3, true);
t('email landed', await page.locator('#s-em').inputValue(), 'k@example.com');

// One unanswerable field used to discard the whole application before a single
// character was typed, which is why LinkedIn Easy Apply recorded thirteen attempts
// averaging 0.0 fields filled. The answerable fields are worth keeping: they are
// what the review card shows and what an operator corrects.
const PARTIAL = at('https://careers.partial.test/apply', `
  <form>
    <label for="p-em">Email</label><input id="p-em" type="text" required>
    <label for="p-ph">Mobile phone number</label><input id="p-ph" type="text" required>
    <label for="p-li">LinkedIn Profile</label><input id="p-li" type="text" required>
    <label for="p-x">How did you perform in mathematics at high school?</label>
    <input id="p-x" type="text" required>
    <button type="button" id="sub">Submit application</button>
  </form>`);

// The first thing generic auto-submit ever sent was careerjunction's job-SEARCH
// page: the model typed a keyword salad into the search bar, an email went into
// the job-alert box, the button was pressed, "thank you" matched, and a
// submitted application was recorded. Nothing reached an employer. An
// unrecognised page has to prove it is an application form — by taking a CV —
// before it may be sent.
section('an unknown page without a CV upload is filled and held, never sent');
const priorAuto = getSetting('allow_generic_autosubmit');
setSetting('allow_generic_autosubmit', '1');
const SEARCHPAGE = at('https://www.jobboard.test/a-job-1234.aspx', `
  <form id="jobsearch">
    <label for="q">Job title, skill or company</label><input id="q" type="text">
    <label for="al">EMAIL</label><input id="al" type="text">
    <button type="submit" id="go">Submit</button>
  </form>`);
const w6 = await applyExternal(page, { ...job(9107), external_apply_url: SEARCHPAGE }, ctx,
  { submit: true, resumePath: null });
t('not submitted', w6.outcome, 'ready');
t('and it says why', /not an application form/i.test(w6.heldForReview || ''), true);
t("the site's own search bar was never answered",
  await page.locator('#q').inputValue(), '');
setSetting('allow_generic_autosubmit', priorAuto ?? '');

const w4 = await applyExternal(page, { ...job(9105), external_apply_url: PARTIAL }, ctx, { submit: true });
t('an unanswerable field still parks the run', w4.outcome, 'parked');
t('but the answerable fields were filled', w4.filled.length >= 3, true);
t('the maths question is the one parked',
  /mathematics/i.test(w4.parked.map(p => p.question).join(' ')), true);
t('and nothing was submitted', await page.locator('#sub').isVisible(), true);
// The values must actually be in the controls, not merely reported.
t('email really landed in the DOM',
  await page.locator('#p-em').inputValue(), 'k@example.com');

// A Next button that does nothing puts the loop in a spin that only MAX_STEPS
// ends — eight rounds of LLM calls and screenshots for a form standing still.
const DEAD = at('https://careers.dead.test/apply', `
  <form>
    <label for="d-em">Email</label><input id="d-em" type="text" required>
    <label for="d-ph">Mobile phone number</label><input id="d-ph" type="text" required>
    <button type="button" id="nx">Continue</button>
  </form>`);

// The adaptive agent is pinned off for this one. It is a live operator setting,
// and with it on a stuck page is handed to the agent instead of throwing —
// which is correct behaviour, and made this assertion pass or fail depending on
// which switches happened to be flipped when the suite ran. A test that reads
// production settings is not testing the code.
const agentWas = getSetting('agent_enabled');
setSetting('agent_enabled', '0');
let deadErr = null;
await applyExternal(page, { ...job(9103), external_apply_url: DEAD }, ctx, { submit: false })
  .catch(err => { deadErr = err.message; });
setSetting('agent_enabled', agentWas ?? '');
t('a form that does not advance is abandoned', /did not advance/.test(deadErr || ''), true);
t('and it happens early, not after the step ceiling', /step 1/.test(deadErr || ''), true);

// The invariant that survives every refactor: an unknown form is never
// auto-submitted, whatever the mode says.
const w3 = await applyExternal(page, { ...job(9104), external_apply_url: WIZ }, ctx, { submit: true });
t('generic vendor never auto-submits even with submit:true', w3.outcome, 'ready');
t('and says why it was held', /does not auto-submit/.test(w3.heldForReview || ''), true);
t('nothing was submitted', await page.locator('#done').isVisible(), false);

section('button matching by accessible name');
await page.goto(WIZ, { waitUntil: 'domcontentloaded' });
t('finds Continue as an advance control', !!(await buttonByName(page, ADVANCE_NAME)), true);
t('does not read Continue as terminal', await buttonByName(page, TERMINAL_NAME), null);

section('step signature');
const sig = items => stepSignature(items.map(n => toFieldSpec(n)));
t('identical forms have identical signatures', sig(roles) === sig(roles), true);
t('a different form does not', sig(roles) === sig(shadow), false);
// uid-based comparison would report progress on any SPA that re-renders, so the
// signature is deliberately built from role and name instead.
t('signature ignores uids', /a11y-/.test(sig(roles)), false);

await browser.close();
for (let i = 9101; i <= 9107; i++) fs.rmSync(path.join(dir, 'screenshots', String(i)), { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
