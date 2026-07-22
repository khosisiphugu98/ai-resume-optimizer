import { getSetting, setSetting } from './db.js';
import {
  SENIORITY_TERMS, ROLE_FAMILY_TERMS, AUTH_BLOCKER_DEFS,
} from './config.js';

/**
 * Why the criteria live here rather than as constants.
 *
 * Every rejection reason on the board traces back to one of a handful of gates,
 * and which gate is too tight is only knowable after watching the pipeline run.
 * Hard-coding the gates means retuning is a code edit and a restart; putting them
 * behind the settings store lets the operator add and drop terms from the
 * dashboard as they learn what the filter is wrongly throwing away.
 *
 * The defaults stay in config.js so there is always a known-good baseline. This
 * module records only the operator's *edits* — terms they added, and defaults
 * they switched off — so a later change to a default is inherited rather than
 * frozen at whatever it was the day they first opened the widget.
 */

// term = the string the matcher keys on. For word gates that is the word itself;
// for auth blockers it is the regex source (stable id), with a friendly label.
const GROUPS = {
  seniorityTitles: {
    label: 'Seniority — above the target band',
    hint: 'A title containing any of these is rejected before scoring. These produced the "seniority: above band" rejections.',
    defaults: SENIORITY_TERMS.map(t => ({ term: t, label: t })),
  },
  roleFamilies: {
    label: 'Target role families',
    hint: 'A posting whose title contains none of these is off-target and scored 0 without an LLM call. Removing all of them stops this gate.',
    defaults: ROLE_FAMILY_TERMS.map(t => ({ term: t, label: t })),
  },
  authBlockers: {
    label: 'Work-authorisation blockers',
    hint: 'A phrase here in a non-South-African posting marks it as impossible to apply to. Added terms are matched as plain text.',
    defaults: AUTH_BLOCKER_DEFS.map(d => ({ term: d.source, label: d.label })),
  },
};

export const CRITERIA_KEY = 'reject_criteria';

function loadOverrides() {
  try {
    const parsed = JSON.parse(getSetting(CRITERIA_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function groupOverride(overrides, group) {
  const g = overrides[group] || {};
  return {
    add: Array.isArray(g.add) ? g.add : [],
    remove: Array.isArray(g.remove) ? g.remove : [],
  };
}

function assertGroup(group) {
  if (!GROUPS[group]) throw new Error(`unknown criteria group "${group}"`);
}

/** The active terms for one group: defaults minus what was switched off, plus what was added. */
export function effectiveTerms(group) {
  assertGroup(group);
  const { add, remove } = groupOverride(loadOverrides(), group);
  const removed = new Set(remove);
  const base = GROUPS[group].defaults.map(d => d.term).filter(t => !removed.has(t));
  for (const t of add) if (!base.includes(t)) base.push(t);
  return base;
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A word-boundary alternation over the seniority terms — the title gate. */
export function titleRejectRe() {
  const terms = effectiveTerms('seniorityTitles');
  if (!terms.length) return /(?!)/; // nothing to reject on
  return new RegExp(`\\b(${terms.map(escapeRe).join('|')})\\b`, 'i');
}

/** Alternation over role families — no word boundaries so "ad operations" matches. */
export function roleFamiliesRe() {
  const terms = effectiveTerms('roleFamilies');
  // Emptied on purpose means "don't gate on title relevance" — match everything
  // rather than nothing, so the operator can't silently zero out the pipeline.
  if (!terms.length) return /(?:)/;
  return new RegExp(`(${terms.map(escapeRe).join('|')})`, 'i');
}

/**
 * Defaults are regex sources; operator additions are plain phrases. Compile each
 * as a regex, falling back to an escaped literal if it isn't valid on its own.
 */
export function authBlockerRes() {
  return effectiveTerms('authBlockers').map(term => {
    try {
      return new RegExp(term, 'i');
    } catch {
      return new RegExp(escapeRe(term), 'i');
    }
  });
}

/** True if any active work-authorisation blocker matches the text. */
export function authBlockerMatch(hay) {
  return authBlockerRes().some(re => re.test(hay));
}

/**
 * The criteria groups shaped for the widget — one call, no logic in the UI. The
 * fit threshold is owned by score/index.js and merged in by the server route, so
 * this module stays free of that import (and the cycle it would create).
 */
export function criteriaForUi() {
  const overrides = loadOverrides();
  return Object.entries(GROUPS).map(([key, def]) => {
    const { add, remove } = groupOverride(overrides, key);
    const removed = new Set(remove);
    const defaults = def.defaults.map(d => ({
      term: d.term, label: d.label, source: 'default', active: !removed.has(d.term),
    }));
    const custom = add
      .filter(term => !def.defaults.some(d => d.term === term))
      .map(term => ({ term, label: term, source: 'custom', active: true }));
    return {
      key, label: def.label, hint: def.hint,
      edited: add.length > 0 || remove.length > 0,
      entries: [...defaults, ...custom],
    };
  });
}

function save(overrides) {
  setSetting(CRITERIA_KEY, JSON.stringify(overrides));
}

/** Turn a criterion on: re-enable a switched-off default, or add a new custom term. */
export function addCriterion(group, term) {
  assertGroup(group);
  const t = String(term || '').trim();
  if (!t) throw new Error('nothing to add');
  const overrides = loadOverrides();
  const g = groupOverride(overrides, group);
  const isDefault = GROUPS[group].defaults.some(d => d.term === t);
  if (isDefault) {
    g.remove = g.remove.filter(x => x !== t); // un-remove the default
  } else if (!g.add.includes(t)) {
    g.add.push(t);
  }
  overrides[group] = g;
  save(overrides);
  return t;
}

/** Turn a criterion off: switch off a default, or drop a custom term entirely. */
export function removeCriterion(group, term) {
  assertGroup(group);
  const t = String(term || '');
  const overrides = loadOverrides();
  const g = groupOverride(overrides, group);
  const isDefault = GROUPS[group].defaults.some(d => d.term === t);
  if (isDefault) {
    if (!g.remove.includes(t)) g.remove.push(t);
  } else {
    g.add = g.add.filter(x => x !== t);
  }
  overrides[group] = g;
  save(overrides);
  return t;
}

/** Drop every edit for one group, restoring the shipped defaults. */
export function resetGroup(group) {
  assertGroup(group);
  const overrides = loadOverrides();
  delete overrides[group];
  save(overrides);
}
