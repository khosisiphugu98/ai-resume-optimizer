/**
 * Read-only empirical audit of the answer/fill layer.
 *
 * Replays the field shapes that actually parked in production (taken from the
 * parked_questions table) plus a representative full ATS form, through the real
 * resolver with the real profile. Prints tier/value/park per field so the fill
 * decision for each is visible.
 *
 * Points APPLY_BOT_DB at a scratch copy so the live pipeline ledger and answer
 * bank are untouched.
 */
import { loadProfile } from '../src/profile.js';
import { resolveFormBatch } from '../src/answer/resolver.js';
import { matchOption } from '../src/answer/options.js';
import { extractSkill } from '../src/answer/matchers.js';

const COUNTRY_CODES = [
  'Andorra (+376)', 'United Arab Emirates (+971)', 'Afghanistan (+93)', 'Albania (+355)',
  'Argentina (+54)', 'Austria (+43)', 'Australia (+61)', 'Belgium (+32)', 'Brazil (+55)',
  'Canada (+1)', 'Switzerland (+41)', 'China (+86)', 'Germany (+49)', 'Denmark (+45)',
  'Spain (+34)', 'France (+33)', 'United Kingdom (+44)', 'India (+91)', 'Ireland (+353)',
  'Italy (+39)', 'Kenya (+254)', 'Netherlands (+31)', 'Nigeria (+234)', 'Portugal (+351)',
  'Sweden (+46)', 'Singapore (+65)', 'United States (+1)', 'South Africa (+27)',
  'Zambia (+260)', 'Zimbabwe (+263)',
];

const FORM = [
  // ---- the exact shapes that parked in production ----
  { uid: 'f1', question: 'Email address', fieldType: 'select', required: true,
    options: ['ksiphugu@icloud.com', 'hpmnwp4zwn@privaterelay.appleid.com'] },
  { uid: 'f2', question: 'Phone country code', fieldType: 'select', required: true,
    options: COUNTRY_CODES },
  { uid: 'f3', question: 'What is your notice period?', fieldType: 'select', required: true,
    options: ['Immediately', 'Less than 2 weeks', '1 month', '2 months', '3 months or more'] },
  { uid: 'f4', question: 'How many years of relevant full-time experience do you have?',
    fieldType: 'number', required: true },
  { uid: 'f5', question: 'Do you have 4–5 years of experience in digital marketing?',
    fieldType: 'select', required: true, options: ['Yes', 'No'] },
  { uid: 'f6', question: 'What is your expected annual salary (ZAR)?', fieldType: 'number', required: true },
  { uid: 'f7', question: 'What excites you about working at Acme Analytics?', fieldType: 'textarea', required: true },
  { uid: 'f8', question: 'What is your preferred location for this opportunity?', fieldType: 'text', required: true },

  // ---- standard ATS fields that should all be trivially answerable ----
  { uid: 'g1', question: 'First name', fieldType: 'text', required: true },
  { uid: 'g2', question: 'Last name', fieldType: 'text', required: true },
  { uid: 'g3', question: 'Email', fieldType: 'text', required: true },
  { uid: 'g4', question: 'Mobile phone number', fieldType: 'tel', required: true },
  { uid: 'g5', question: 'City', fieldType: 'text', required: true },
  { uid: 'g6', question: 'Country', fieldType: 'select', required: true,
    options: ['South Africa', 'Nigeria', 'Kenya', 'United States', 'United Kingdom'] },
  { uid: 'g7', question: 'LinkedIn profile URL', fieldType: 'url', required: true },
  { uid: 'g8', question: 'Portfolio or personal website', fieldType: 'url', required: false },
  { uid: 'g9', question: 'Are you legally authorised to work in South Africa?', fieldType: 'select',
    required: true, options: ['Yes', 'No'] },
  { uid: 'g10', question: 'Will you now or in the future require visa sponsorship?', fieldType: 'select',
    required: true, options: ['Yes', 'No'] },
  { uid: 'g11', question: 'How many years of experience do you have with SQL?', fieldType: 'number', required: true },
  { uid: 'g12', question: 'How many years of experience do you have with Google Analytics 4?', fieldType: 'number', required: true },
  { uid: 'g13', question: 'Do you have a valid driver’s licence?', fieldType: 'select', required: true,
    options: ['Yes', 'No'] },
  { uid: 'g14', question: 'When are you available to start?', fieldType: 'text', required: true },
  { uid: 'g15', question: 'How did you hear about this role?', fieldType: 'select', required: false,
    options: ['LinkedIn', 'Referral', 'Company website', 'Job board', 'Other'] },
  { uid: 'g16', question: 'Gender', fieldType: 'select', required: false,
    options: ['Male', 'Female', 'Non-binary', 'Prefer not to say'] },
  { uid: 'g17', question: 'Race / ethnicity', fieldType: 'select', required: false,
    options: ['African', 'Coloured', 'Indian', 'White', 'Prefer not to say'] },
  { uid: 'g18', question: 'Highest level of education completed', fieldType: 'select', required: true,
    options: ['High school', 'Diploma', 'Bachelor’s degree', 'Master’s degree', 'Doctorate'] },
  { uid: 'g19', question: 'Current employer', fieldType: 'text', required: true },
  { uid: 'g20', question: 'Current job title', fieldType: 'text', required: true },
  { uid: 'g21', question: 'Are you willing to relocate?', fieldType: 'select', required: true,
    options: ['Yes', 'No'] },
  { uid: 'g22', question: 'Years of professional experience', fieldType: 'select', required: true,
    options: ['0-1', '2-3', '4-6', '7-10', '10+'] },
];

const ctx = {
  profile: loadProfile(),
  countryCode: 'ZA',
  company: 'Acme Analytics',
  jobTitle: 'Marketing Analyst',
  jd: 'We are looking for a Marketing Analyst with SQL, GA4 and paid-media reporting experience. Based in Johannesburg, South Africa. Hybrid.',
  resumeText: '',
  ats: 'greenhouse',
};

console.log('\n=== extractSkill() on the questions that produced garbage nouns ===');
for (const q of [
  'How many years of relevant full-time experience do you have?',
  'Do you have 4–5 years of experience in digital marketing?',
  'How many years of experience do you have with SQL?',
  'Years of experience with Google Analytics 4',
  'How many years of paid media experience do you have?',
]) console.log(`  ${JSON.stringify(extractSkill(q))}  <-  "${q}"`);

console.log('\n=== matchOption() on the option lists that parked ===');
const cases = [
  ['+27 82 820 4538', COUNTRY_CODES, 'raw phone into country-code select'],
  ['South Africa (+27)', COUNTRY_CODES, 'correct option, exact'],
  ['+27', COUNTRY_CODES, 'dialling code only'],
  ['South Africa', COUNTRY_CODES, 'country name only'],
  ['mksiphugu@gmail.com', ['ksiphugu@icloud.com', 'hpmnwp4zwn@privaterelay.appleid.com'], 'profile email vs LinkedIn verified list'],
  ['30 days', ['Immediately', 'Less than 2 weeks', '1 month', '2 months', '3 months or more'], 'notice period days->bucket'],
  ['1 month', ['Immediately', 'Less than 2 weeks', '1 month', '2 months', '3 months or more'], 'notice period exact'],
  ['3', ['0-1', '2-3', '4-6', '7-10', '10+'], 'numeric years into a range select'],
];
for (const [val, opts, label] of cases) {
  for (const semantic of [false, true]) {
    const m = matchOption(val, opts, { semantic });
    console.log(`  semantic=${String(semantic).padEnd(5)} ${JSON.stringify(val).padEnd(24)} -> ${m ? `${JSON.stringify(m.option)} (rule=${m.rule}, confident=${m.confident})` : 'NO MATCH'}   [${label}]`);
  }
}

console.log('\n=== resolveFormBatch() over the full form ===');
const t0 = Date.now();
const out = await resolveFormBatch(FORM, ctx);
const ms = Date.now() - t0;

const byUid = new Map(out.resolved.map(r => [r.uid, r]));
let ok = 0, park = 0;
for (const f of FORM) {
  const r = byUid.get(f.uid);
  const req = f.required === false ? 'opt' : 'REQ';
  if (!r) { console.log(`  ${req} ${f.uid.padEnd(4)} ${'(no result)'.padEnd(30)} ${f.question}`); continue; }
  if (r.status === 'ok') {
    ok++;
    const flags = [r.probable ? 'PROBABLE' : '', r.optionRule && r.optionRule !== 'exact' ? `rule=${r.optionRule}` : ''].filter(Boolean).join(' ');
    console.log(`  ${req} ${f.uid.padEnd(4)} OK   [${String(r.tier).padEnd(12)}] ${JSON.stringify(String(r.value).slice(0, 60)).padEnd(50)} ${flags}  <- ${f.question.slice(0, 60)}`);
  } else {
    park++;
    console.log(`  ${req} ${f.uid.padEnd(4)} PARK [${String(r.tier).padEnd(12)}] ${String(r.reason).slice(0, 110)}  <- ${f.question.slice(0, 60)}`);
  }
}

console.log(`\n  ${ok} filled / ${park} parked of ${FORM.length} fields in ${ms}ms`);
console.log(`  required parked (blocks submission): ${out.parked.length}`);
console.log(`  tiers: ${JSON.stringify(out.tiers)}`);
console.log(`  form ok (nothing parked): ${out.ok}\n`);
