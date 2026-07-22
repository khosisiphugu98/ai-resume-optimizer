import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// Overridable so tests never touch the real profile. This file is written by
// setProfileValue/confirmSkill; without an override, any profile-writing test hits
// the real (gitignored, un-recoverable) master profile. Mirrors PATHS.db's
// APPLY_BOT_DB override, which exists for exactly the same reason.
const PROFILE_PATH = process.env.APPLY_BOT_PROFILE || path.join(ROOT, 'profile/master-profile.json');
const EXAMPLE_PATH = path.join(ROOT, 'profile.example.json');

let cache = null;

export function loadProfile({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error(
      `No profile at ${PROFILE_PATH}.\n` +
      `  cp ${path.relative(ROOT, EXAMPLE_PATH)} profile/master-profile.json  and fill it in.`
    );
  }
  cache = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  return cache;
}

export function profileExists() {
  return fs.existsSync(PROFILE_PATH);
}

/**
 * Years of experience with a skill — the single most-asked ATS question and the
 * one most likely to be answered dishonestly.
 *
 * Returns null unless the skill is present AND explicitly confirmed. An
 * unconfirmed value parks the application (§1) rather than being guessed at.
 * Never infer from job dates, never round up, never fall back to a total.
 */
export function skillYears(profile, skillName) {
  const skills = profile.skills || {};
  const want = normaliseSkill(skillName);

  for (const [name, meta] of Object.entries(skills)) {
    if (name.startsWith('_') || !meta || typeof meta !== 'object') continue;
    if (normaliseSkill(name) !== want) continue;
    if (!meta.confirmed) return { value: null, reason: `"${name}" is in the profile but not confirmed` };
    if (typeof meta.years !== 'number') return { value: null, reason: `"${name}" has no years value` };
    return { value: meta.years, reason: null };
  }
  return { value: null, reason: `"${skillName}" is not in the profile` };
}

const ALIASES = {
  'google analytics': 'ga4',
  'google analytics 4': 'ga4',
  'gtm': 'google tag manager',
  'ms sql': 'microsoft sql server',
  'powerbi': 'power bi',
  'looker': 'looker studio',
  'js': 'javascript',
};

export function normaliseSkill(s) {
  const k = String(s).toLowerCase().replace(/[^a-z0-9+#. ]/g, ' ').replace(/\s+/g, ' ').trim();
  return ALIASES[k] || k;
}

/**
 * Names of every confirmed skill — the resume-tailoring allowlist. The web
 * optimiser is seeded with these so it only ever weaves a skill into the resume
 * that the candidate has vouched for here. Years are irrelevant for this purpose,
 * so a skill confirmed without a years value still counts.
 */
export function confirmedSkillNames(profile) {
  return Object.entries(profile.skills || {})
    .filter(([n, m]) => !n.startsWith('_') && m && typeof m === 'object' && m.confirmed)
    .map(([n]) => n);
}

/** Work authorisation for a country code. Only ever from the profile. */
export function authorisationFor(profile, countryCode) {
  const auth = profile.authorization || {};
  if (!auth.confirmed) return { known: false, reason: 'authorization block is not confirmed' };
  const entry = (auth.countries || {})[countryCode];
  if (entry) return { known: true, authorized: !!entry.authorized, requiresSponsorship: !!entry.requiresSponsorship };
  if (typeof auth.requiresSponsorshipElsewhere === 'boolean') {
    return { known: true, authorized: false, requiresSponsorship: auth.requiresSponsorshipElsewhere };
  }
  return { known: false, reason: `no authorisation entry for ${countryCode}` };
}

/** Everything still blocking autonomous operation. Surfaced by `npm run profile`. */
export function unconfirmed(profile) {
  const out = [];
  if (!profile.authorization?.confirmed) out.push('authorization — work eligibility and notice period');
  if (!profile.current?.confirmed) out.push('current — employer, title, total years of experience');

  for (const [name, meta] of Object.entries(profile.skills || {})) {
    if (name.startsWith('_') || !meta || typeof meta !== 'object') continue;
    if (!meta.confirmed) out.push(`skills.${name} — years=${meta.years ?? '?'} unconfirmed`);
  }
  for (const f of ['firstName', 'lastName', 'email', 'phone']) {
    if (!profile.identity?.[f]) out.push(`identity.${f} — empty`);
  }
  return out;
}

/** Unconfirmed fields as editable rows for the dashboard. */
export function editableGaps() {
  if (!profileExists()) return [];
  const p = loadProfile({ fresh: true });
  const rows = [];

  if (!p.authorization?.confirmed) {
    rows.push({ path: 'authorization.noticePeriodDays', label: 'Notice period (days)', value: p.authorization?.noticePeriodDays ?? '', type: 'number', group: 'authorization' });
    rows.push({ path: 'authorization.willingToRelocate', label: 'Willing to relocate?', value: String(!!p.authorization?.willingToRelocate), type: 'bool', group: 'authorization' });
  }
  if (!p.current?.confirmed) {
    rows.push({ path: 'current.company', label: 'Current employer', value: p.current?.company ?? '', type: 'text', group: 'current' });
    rows.push({ path: 'current.title', label: 'Current job title', value: p.current?.title ?? '', type: 'text', group: 'current' });
    rows.push({ path: 'current.totalYearsExperience', label: 'Total years of experience', value: p.current?.totalYearsExperience ?? '', type: 'number', group: 'current' });
  }
  for (const [name, meta] of Object.entries(p.skills || {})) {
    if (name.startsWith('_') || !meta || typeof meta !== 'object' || meta.confirmed) continue;
    rows.push({ path: `skills.${name}.years`, label: `${name} — years`, value: meta.years ?? '', type: 'number', group: `skills.${name}` });
  }
  return rows;
}

/**
 * Write a value and mark its group confirmed. Confirming is the whole point —
 * an unconfirmed value is invisible to the resolver.
 */
export function setProfileValue(dotPath, value, { confirm = true } = {}) {
  const p = loadProfile({ fresh: true });
  const parts = dotPath.split('.');
  let node = p;
  for (const k of parts.slice(0, -1)) {
    if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  }
  const leaf = parts.at(-1);
  const raw = String(value).trim();
  node[leaf] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw)
    : /^(true|false)$/i.test(raw) ? /^true$/i.test(raw)
    : raw;

  if (confirm) {
    // Group = the object that carries the confirmed flag.
    if (parts[0] === 'skills') p.skills[parts[1]].confirmed = true;
    else if (p[parts[0]] && typeof p[parts[0]] === 'object') p[parts[0]].confirmed = true;
  }

  fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2) + '\n');
  cache = p;
  return { path: dotPath, value: node[leaf], remaining: unconfirmed(p).length };
}

/**
 * Confirm a skill straight from a dashboard suggestion — creating the entry if it
 * doesn't exist yet. Years are optional: a skill can be true for the resume without
 * the candidate committing to a number, and a null-years skill still parks any
 * years-of-experience question (skillYears requires a number), so this can never
 * make the bot fabricate a duration.
 */
export function confirmSkill(name, years = null) {
  const clean = String(name).trim();
  if (!clean) throw new Error('a skill name is required');
  const p = loadProfile({ fresh: true });
  p.skills = p.skills || {};

  // Reuse an existing entry's casing if this skill is already listed.
  const want = normaliseSkill(clean);
  const existingKey = Object.keys(p.skills).find(k => !k.startsWith('_') && normaliseSkill(k) === want);
  const key = existingKey || clean;

  const yrs = (years === '' || years == null) ? null : Number(years);
  p.skills[key] = { years: Number.isFinite(yrs) ? yrs : null, confirmed: true };

  fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2) + '\n');
  cache = p;
  return { skill: key, years: p.skills[key].years };
}

export function summariseForLLM(profile) {
  const skills = Object.entries(profile.skills || {})
    .filter(([n, m]) => !n.startsWith('_') && m?.confirmed)
    .map(([n, m]) => typeof m.years === 'number' ? `${n} (${m.years}y)` : n);
  return [
    `Name: ${profile.identity?.firstName} ${profile.identity?.lastName}`,
    `Location: ${profile.identity?.city}, ${profile.identity?.country}`,
    `Current: ${profile.current?.title} at ${profile.current?.company}`,
    `Total experience: ${profile.current?.totalYearsExperience ?? 'unspecified'} years`,
    `Confirmed skills: ${skills.join(', ') || 'none'}`,
    `Education: ${(profile.education || []).map(e => `${e.degree} ${e.field} (${e.institution}, ${e.end})`).join('; ')}`,
    `Experience: ${(profile.experience || []).map(e => `${e.title} at ${e.company} (${e.start}–${e.end})`).join('; ')}`,
    `Certifications: ${(profile.certifications || []).map(c => `${c.name} (${c.issuer} ${c.year})`).join('; ')}`,
  ].join('\n');
}
