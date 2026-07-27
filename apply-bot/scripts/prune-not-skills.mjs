/**
 * One-off: take the audit's "not a skill" verdicts out of profile.skills.
 *
 * The auto-confirm loop had grown the confirmed list to 188 entries, including
 * metrics (CTR, CPA), job titles (Data AI Engineer), languages and personal
 * qualities. That list is the allowlist deciding what the optimiser may write into
 * a tailored CV, so junk in it is a licence to claim things.
 *
 * They are moved to `skills._notSkills` rather than deleted: every consumer already
 * skips `_`-prefixed keys, so they stop counting as skills without the audit's work
 * being thrown away — and without turning into 131 "unconfirmed" dashboard rows,
 * which is what plain unconfirming would do.
 *
 * Unevidenced-but-real skills are left exactly as they are. Only one CV is in the
 * evidence corpus, so "no evidence" says as much about the corpus as the claim.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { loadProfile } from '../src/profile.js';
import { corpus } from '../src/evidence/store.js';
import { auditConfirmedSkills } from '../src/evidence/skills.js';

const PROFILE_PATH = path.join(ROOT, 'profile/master-profile.json');
const apply = process.argv.includes('--apply');

const docs = corpus();
if (!docs.length) { console.error('No evidence documents — nothing to audit against.'); process.exit(1); }

const profile = loadProfile({ fresh: true });
const rows = await auditConfirmedSkills(profile, docs);
const notSkills = rows.filter(r => !r.isSkill);

console.log(`\n  ${rows.length} confirmed skill(s) checked against ${docs.length} document(s).`);
console.log(`  ${notSkills.length} are not skills and will be moved out of profile.skills.\n`);

if (!apply) {
  for (const r of notSkills.slice(0, 12)) console.log(`   · ${r.skill} — ${r.notSkillWhy}`);
  if (notSkills.length > 12) console.log(`   … and ${notSkills.length - 12} more`);
  console.log('\n  Dry run. Re-run with --apply to write.\n');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
fs.copyFileSync(PROFILE_PATH, path.join(ROOT, `profile/master-profile.backup-${stamp}.json`));

const p = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
const norm = s => String(s).toLowerCase().trim();
const verdicts = new Map(notSkills.map(r => [norm(r.skill), r.notSkillWhy || 'not a skill']));

const moved = {};
for (const key of Object.keys(p.skills || {})) {
  if (key.startsWith('_')) continue;
  const why = verdicts.get(norm(key));
  if (!why) continue;
  moved[key] = why;
  delete p.skills[key];
}

p.skills._notSkills = {
  _note: 'Audited as not verifiable skills and excluded from the optimiser allowlist. '
    + 'Kept for the record; nothing reads this map.',
  ...moved,
};

fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2) + '\n');

const left = Object.keys(p.skills).filter(k => !k.startsWith('_')).length;
console.log(`  Moved ${Object.keys(moved).length} entries to skills._notSkills.`);
console.log(`  ${left} skill(s) remain in profile.skills.\n`);
