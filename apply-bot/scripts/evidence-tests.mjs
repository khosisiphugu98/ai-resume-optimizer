// The évidence gate. These tests protect the same thing the answer tests do —
// that nothing reaches an employer that the candidate's own CV cannot support —
// so a failure here is a fabrication risk, not a broken build. No network: the
// model tiers run through injected fakes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// profile.js reads APPLY_BOT_PROFILE once, at module load. It must be pointed at
// a throwaway file BEFORE anything imports it — a confirmSkill() test once wrote
// into the real, gitignored master profile and there was no backup. Hence the
// dynamic import below rather than a static one at the top of the file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
process.env.APPLY_BOT_PROFILE = path.join(tmp, 'profile.json');
process.env.APPLY_BOT_EVIDENCE = path.join(tmp, 'evidence');

const {
  classifySkillDeterministic, classifySkills, findEvidence, inferYears, gateSkills, auditConfirmedSkills,
} = await import('../src/evidence/skills.js');

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

// A CV shaped like a real one: a skills list, then dated roles with bullets. The
// distinction matters — §4 credits years only to skills named inside a role.
const CV = `KHOSI SIPHUGU
Marketing Analyst · Johannesburg

SKILLS
SQL, Python, Looker Studio, Power BI, Tableau, TensorFlow

EXPERIENCE

AdOps Operations Assistant — Hyve Mobile
2023 - Present
Built reporting dashboards in Looker Studio for campaign performance.
Wrote SQL queries against the ad server to reconcile delivery.
Ran A/B tests on creative variants and reported lift.

Campaign Coordinator — Zaio
2023 - 2024
Managed Google Ads campaigns and reported on spend.
Wrote SQL to pull weekly performance extracts.

Marketing Intern — Rowdy Bags
2021 - 2021
Scheduled social posts and drafted copy.

E D U C A T I O N & C E R T I F I C A T I O N S
BBusSc Analytics, University of Cape Town, 2020
Google Analytics Certification
`;

const DOCS = [{ id: 'd1', filename: 'CV.pdf', text: CV }];

const PROFILE = {
  identity: { firstName: 'Khosi', lastName: 'Siphugu' },
  current: { company: 'Hyve Mobile', title: 'AdOps Operations Assistant', totalYearsExperience: 4, confirmed: true },
  experience: [
    { title: 'AdOps Operations Assistant', company: 'Hyve Mobile', start: '2023', end: 'Present' },
    { title: 'Campaign Coordinator', company: 'Zaio', start: '2023', end: '2024' },
    { title: 'Marketing Intern', company: 'Rowdy Bags', start: '2021', end: '2021' },
  ],
  skills: {},
};

const noModel = { hasModel: () => false, callModel: async () => { throw new Error('no model in tests'); } };

section('is it a skill? — the queue is fed by a keyword extractor, so most are not');
const cd = term => classifySkillDeterministic(term).verdict;
t('a tool is a skill',              cd('Looker Studio'), 'unknown');   // deterministic rules never say yes
t('a disposition is not',           cd('intellectual curiosity'), 'not-a-skill');
t('a soft skill is not',            cd('numerical reasoning'), 'not-a-skill');
t('a working arrangement is not',   cd('Remote'), 'not-a-skill');
t('a market segment is not',        cd('B2C'), 'not-a-skill');
t('a qualification is not',         cd("Bachelor's degree"), 'not-a-skill');
t('a metric is not',                cd('CTR decay'), 'not-a-skill');
t('a file format is not',           cd('XLSX'), 'not-a-skill');
t('a job title is not',             cd('Data Scientist'), 'not-a-skill');
t('a vague phrase is not',          cd('online visibility'), 'not-a-skill');
t('a sentence fragment is not',     cd('ability to work in a fast paced team'), 'not-a-skill');
// Products whose names end in a title word are still tools.
t('Google Tag Manager survives',    cd('Google Tag Manager'), 'unknown');
t('Meta Ads Manager survives',      cd('Meta Ads Manager'), 'unknown');

section('the stoplist outranks the model — a prompt is not a control');
const yesToEverything = { hasModel: () => true, callModel: async () => ({ verdicts: [{ term: 'intellectual curiosity', skill: true }, { term: 'TensorFlow', skill: true }] }) };
const cls = await classifySkills(['intellectual curiosity', 'TensorFlow'], yesToEverything);
t('model cannot promote a stoplisted term', cls.get('intellectual curiosity').verdict, 'not-a-skill');
t('model may settle an undecided one',      cls.get('TensorFlow').verdict, 'skill');

section('with no model, undecided terms stay undecided (they get asked, as before)');
const clsNoKey = await classifySkills(['TensorFlow', 'Remote'], noModel);
t('undecided without a key', clsNoKey.get('TensorFlow').verdict, 'unknown');
t('rules still apply',       clsNoKey.get('Remote').verdict, 'not-a-skill');

section('does the CV evidence it?');
const ev = await findEvidence(['SQL', 'Looker Studio', 'Kubernetes', 'GA4'], DOCS, noModel);
t('literal match is evidence',      ev.get('SQL').verdict, 'evidenced');
t('  → and quotes where it found it', /SQL/.test(ev.get('SQL').quote), true);
t('  → and names the document',     ev.get('SQL').document, 'CV.pdf');
t('absent skill is unevidenced',    ev.get('Kubernetes').verdict, 'unevidenced');
// The alias map is shared with profile.js, so a CV that says "Google Analytics"
// evidences a profile skill recorded as "GA4".
t('an alias counts as the same skill', ev.get('GA4').verdict, 'evidenced');

// Whole-word matching: "R" as a skill must not match every word containing an r.
const evR = await findEvidence(['R'], [{ id: 'd', filename: 'x.pdf', text: 'Reporting and research.' }], noModel);
t('a one-letter skill does not match inside words', evR.get('R').verdict, 'unevidenced');
const evR2 = await findEvidence(['R'], [{ id: 'd', filename: 'x.pdf', text: 'Modelling in R and Python.' }], noModel);
t('  → but does match standing alone', evR2.get('R').verdict, 'evidenced');

section('a model may not claim evidence it cannot quote');
// "experimentation" is nowhere in the CV literally, so this genuinely reaches the
// semantic tier — which is exactly where a fabricated quote would do damage.
const liar = {
  hasModel: () => true,
  callModel: async () => ({ evidenced: [
    { skill: 'Kubernetes', quote: 'Orchestrated containers at scale' },        // not in the CV
    { skill: 'experimentation', quote: 'Ran A/B tests on creative variants' }, // verbatim
  ] }),
};
const evL = await findEvidence(['Kubernetes', 'experimentation'], DOCS, liar);
t('invented quote is rejected',  evL.get('Kubernetes').verdict, 'unevidenced');
t('verbatim quote is accepted',  evL.get('experimentation').verdict, 'evidenced');
t('  → recorded as semantic',    evL.get('experimentation').tier, 'semantic');
// A stemmed literal hit is found before the model is ever consulted.
const evStem = await findEvidence(['A/B testing'], DOCS, noModel);
t('stemming finds "A/B tests" for "A/B testing"', evStem.get('A/B testing').tier, 'stemmed');

section('for how long? — years come off the CV timeline, and refuse when unclear');
t('spans the roles that mention it', inferYears('SQL', DOCS, PROFILE).years, new Date().getFullYear() - 2023);
t('  → shows its working',           /Hyve Mobile|Zaio/.test(inferYears('SQL', DOCS, PROFILE).derivation), true);
// TensorFlow is in the skills list and nowhere else — presence, but no duration.
t('a skills-list-only mention yields no years', inferYears('TensorFlow', DOCS, PROFILE).years, null);
t('  → and says why', /outside any role/.test(inferYears('TensorFlow', DOCS, PROFILE).why), true);
// Rowdy Bags is a single-year role: under a year is no number, not a rounded-up one.
t('a sub-year span yields no years', inferYears('Scheduled social posts', DOCS, PROFILE).years, null);
t('never exceeds total experience',
  inferYears('SQL', DOCS, { ...PROFILE, current: { ...PROFILE.current, totalYearsExperience: 1 } }).years, 1);
// The last role must not swallow Education & Certifications. "Google Analytics
// Certification" sits below the final job; crediting it there would date the
// skill from that job's start. Note the CV letter-spaces its heading, as real
// ones do — the section boundary has to survive that.
t('a certification below the last role is not credited to it',
  inferYears('Google Analytics', DOCS, PROFILE).years, null);
t('  → and says it sat outside any role',
  /outside any role/.test(inferYears('Google Analytics', DOCS, PROFILE).why), true);

section('the gate end to end');
const gated = await gateSkills(
  ['intellectual curiosity', 'Remote', 'SQL', 'Looker Studio', 'Kubernetes', 'TensorFlow'],
  DOCS, PROFILE, noModel,
);
t('non-skills dropped, never queued', gated.drop.map(d => d.skill).sort(), ['Remote', 'intellectual curiosity']);
t('evidenced skills confirm themselves', gated.confirm.map(c => c.skill).sort(), ['Looker Studio', 'SQL', 'TensorFlow']);
t('unevidenced real skills still ask',   gated.ask.map(a => a.skill), ['Kubernetes']);
t('a skills-list confirm carries no years',
  gated.confirm.find(c => c.skill === 'TensorFlow').years, null);
t('a role-attributed confirm carries years',
  gated.confirm.find(c => c.skill === 'SQL').years, new Date().getFullYear() - 2023);
t('every confirm carries its evidence',
  gated.confirm.every(c => c.evidence?.quote && c.evidence?.document), true);
// The bullet describing the work is better evidence than the skills list at the
// top of the CV, so a role-attributed mention wins the quote.
t('the quote prefers the role bullet over the skills list',
  /Wrote SQL queries/.test(gated.confirm.find(c => c.skill === 'SQL').evidence.quote), true);

section('nothing is asked about when there is nothing to ask about');
const empty = await gateSkills([], DOCS, PROFILE, noModel);
t('empty in, empty out', [empty.drop.length, empty.confirm.length, empty.ask.length], [0, 0, 0]);
// With no documents, everything real is asked — the old behaviour, not a silent yes.
const noDocs = await gateSkills(['SQL', 'Remote'], [], PROFILE, noModel);
t('no corpus → nothing auto-confirms', noDocs.confirm.length, 0);
t('  → real skills are queued',        noDocs.ask.map(a => a.skill), ['SQL']);
t('  → and the reason says so',        /no documents/.test(noDocs.ask[0].why), true);

section('audit — reports, never writes');
const audited = await auditConfirmedSkills({
  ...PROFILE,
  skills: {
    _note: 'ignored',
    SQL: { years: 3, confirmed: true },
    'machine learning': { years: 1, confirmed: true },
    Remote: { years: 4, confirmed: true },
    Unconfirmed: { years: 2, confirmed: false },
  },
}, DOCS, noModel);
t('only confirmed skills are audited', audited.map(a => a.skill).sort(), ['Remote', 'SQL', 'machine learning']);
t('evidenced skill passes',            audited.find(a => a.skill === 'SQL').evidenced, true);
t('unevidenced skill is flagged',      audited.find(a => a.skill === 'machine learning').evidenced, false);
t('  → and keeps its years for the report', audited.find(a => a.skill === 'machine learning').years, 1);
t('a non-skill is flagged as such',    audited.find(a => a.skill === 'Remote').isSkill, false);

// ---------------------------------------------------------------------------
// Profile writes. ALWAYS against a temp profile — a confirmSkill() test once hit
// the real gitignored master profile and overwrote it.
// ---------------------------------------------------------------------------
section('profile provenance');
fs.writeFileSync(process.env.APPLY_BOT_PROFILE, JSON.stringify({ ...PROFILE, skills: { Legacy: { years: 2, confirmed: true } } }));

const { confirmSkill, skillYears, loadProfile, inferredYearsSkills } = await import('../src/profile.js');

confirmSkill('Looker Studio', 3, { source: 'resume-evidence', evidence: { quote: 'Built reporting dashboards in Looker Studio', document: 'CV.pdf' }, derivation: 'Hyve Mobile 2023–Present → 3y' });
let p = loadProfile({ fresh: true });
t('evidence confirm records its source',    p.skills['Looker Studio'].source, 'resume-evidence');
t('  → and stores the quote',               p.skills['Looker Studio'].evidence.document, 'CV.pdf');
t('  → and marks the years inferred',       p.skills['Looker Studio'].yearsSource, 'inferred');
t('an inferred figure answers the question', skillYears(p, 'Looker Studio').value, 3);
t('  → but reports that it was inferred',   skillYears(p, 'Looker Studio').inferred, true);
t('it shows up for review',                 inferredYearsSkills(p).map(s => s.skill), ['Looker Studio']);

confirmSkill('Looker Studio', 5, { source: 'operator' });
p = loadProfile({ fresh: true });
t('an operator correction outranks it',     p.skills['Looker Studio'].years, 5);
t('  → and becomes the candidate\'s own',   p.skills['Looker Studio'].yearsSource, 'operator');
t('  → no longer flagged inferred',         skillYears(p, 'Looker Studio').inferred, false);
t('  → and leaves the review queue',        inferredYearsSkills(p).length, 0);
t('  → while keeping the evidence found',   p.skills['Looker Studio'].evidence.document, 'CV.pdf');

t('a legacy {years, confirmed} entry still resolves', skillYears(p, 'Legacy').value, 2);
t('  → and is not treated as inferred',              skillYears(p, 'Legacy').inferred, false);

// Presence without a number must not become a number.
confirmSkill('TensorFlow', null, { source: 'resume-evidence', evidence: { quote: 'SQL, Python, Looker Studio, Power BI, Tableau, TensorFlow', document: 'CV.pdf' } });
p = loadProfile({ fresh: true });
t('presence-only confirm has no years',  p.skills.TensorFlow.years, null);
t('  → so a years question still parks', skillYears(p, 'TensorFlow').value, null);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
