// Phase 1 smoke test. Exercises the pre-filter and the dashboard API without
// touching LinkedIn. Seeds synthetic jobs so the board can be eyeballed.
import { preFilter } from '../src/discover/linkedin.js';
import { upsertJob, updateJob, db, boardSnapshot, bumpRate } from '../src/db.js';
import { emit } from '../src/bus.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

console.log('\npre-filter — seniority band (§2.2)');
t('Senior rejected',        preFilter({ title: 'Senior Marketing Analyst', location: 'Cape Town' }), 'seniority: above band');
t('Head of rejected',       preFilter({ title: 'Head of Growth', location: 'Johannesburg' }), 'seniority: above band');
t('Lead rejected',          preFilter({ title: 'Lead Data Analyst', location: 'Durban' }), 'seniority: above band');
t('Analyst kept',           preFilter({ title: 'Marketing Analyst', location: 'Cape Town' }), null);
t('Associate kept',         preFilter({ title: 'Growth Marketing Associate', location: 'Sandton' }), null);
t('GTM Engineer kept',      preFilter({ title: 'GTM Engineer', location: 'Remote - EMEA' }), null);

console.log('\npre-filter — work authorisation (§2.3, the highest-leverage filter)');
const AUTH = 'work authorisation: not open to South Africa';
t('US-only remote rejected',
  preFilter({ title: 'Marketing Analyst', location: 'United States (Remote)', jd: 'Must be legally authorized to work in the United States.' }), AUTH);
t('no-sponsorship rejected',
  preFilter({ title: 'Growth Analyst', location: 'London, UK', jd: 'We are unable to sponsor visas for this role.' }), AUTH);
t('US-based only rejected',
  preFilter({ title: 'Marketing Analyst', location: 'Remote', jd: 'US-based candidates only please.' }), AUTH);
t('ZA role with US boilerplate kept',
  preFilter({ title: 'Marketing Analyst', location: 'Johannesburg, Gauteng', jd: 'No visa sponsorship available.' }), null);
t('EMEA-open remote kept',
  preFilter({ title: 'Marketing Analyst', location: 'Remote', jd: 'Open to candidates anywhere in EMEA. No sponsorship in the US.' }), null);
t('worldwide remote kept',
  preFilter({ title: 'Marketing Data Analyst', location: 'Remote', jd: 'We hire worldwide.' }), null);
t('plain remote, no blocker, kept',
  preFilter({ title: 'Marketing Analyst', location: 'Remote', jd: 'Join our distributed team.' }), null);

console.log('\ndb + board');
db.exec(`DELETE FROM jobs WHERE external_id LIKE 'smoke-%'`);
const fixtures = [
  ['smoke-1', 'Marketing Data Analyst', 'Takealot', 'Cape Town', 'A', 'discovered', null, 'easy_apply'],
  ['smoke-2', 'GTM Engineer', 'Yoco', 'Remote - EMEA', 'C', 'enriched', null, 'external'],
  ['smoke-3', 'Ad Operations Specialist', 'Hyve', 'Johannesburg', 'B', 'enriched', null, 'email'],
  ['smoke-4', 'Senior Growth Lead', 'Luno', 'Cape Town', 'A', 'rejected', 'seniority: above band', 'unknown'],
  ['smoke-5', 'Marketing Analyst', 'Stripe', 'US (Remote)', 'A', 'rejected', AUTH, 'unknown'],
];
for (const [ext, title, company, location, tier, status, reason, applyType] of fixtures) {
  const id = upsertJob({ external_id: ext, title, company, location, tier, url: `https://linkedin.com/jobs/view/${ext}` });
  if (id) updateJob(id, { status, reject_reason: reason, apply_type: applyType, jd_text: `Synthetic fixture for ${title}.` });
}
bumpRate('linkedin_pageviews', 12);
emit({ stage: 'smoke', message: 'Smoke fixtures seeded — dashboard has data to render' });

const snap = boardSnapshot();
const smokeJobs = snap.jobs.filter(j => j.title && fixtures.some(f => f[1] === j.title));
t('5 fixtures on board', smokeJobs.length >= 5, true);
t('rejected carry a reason', smokeJobs.filter(j => j.status === 'rejected').every(j => !!j.reject_reason), true);
t('rates recorded', snap.rates.linkedin_pageviews >= 12, true);

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
