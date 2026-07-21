import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const PROFILE_PATH = path.join(ROOT, 'profile/master-profile.json');
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

export function summariseForLLM(profile) {
  const skills = Object.entries(profile.skills || {})
    .filter(([n, m]) => !n.startsWith('_') && m?.confirmed)
    .map(([n, m]) => `${n} (${m.years}y)`);
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
