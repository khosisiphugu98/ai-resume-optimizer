import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(ROOT, '..');

export const PATHS = {
  // Overridable so the tests never touch the real pipeline. They seed jobs and
  // clear the rate ledger, and that ledger is the daily cap that keeps LinkedIn
  // from flagging the account — running the suite must not reset it.
  db: process.env.APPLY_BOT_DB || path.join(ROOT, 'data/pipeline.sqlite'),
  chromeProfile: path.join(ROOT, 'data/chrome-profile'),
  artifacts: path.join(ROOT, 'artifacts'),
  // Overridable for the same reason as the db: with the real kill switch on,
  // every canApply test fails for a reason that has nothing to do with the code.
  stop: process.env.APPLY_BOT_STOP || path.join(ROOT, 'STOP'),
  optimiser: 'https://khosisiphugu98.github.io/ai-resume-optimizer/',
};

// Overridable for the same reason as the db path: a verification run must not
// have to take the port from a dashboard that is already open and working.
export const SERVER = { port: Number(process.env.APPLY_BOT_PORT) || 5175 };

// Run mode — see docs/APPLY_BOT_PLAN.md §7.5. Phase 1 ships observe only.
export const MODES = ['observe', 'review', 'auto'];

// Per-channel daily caps. Only linkedin_easy carries LinkedIn ban risk (§8.1).
export const CAPS = {
  linkedin_easy: 15,
  external_ats: 35,
  email: 15,
  linkedin_pageviews: 250,
};

// Operating window, SAST. Discovery outside this is deferred, not dropped.
export const HOURS = { start: 8, end: 19, weekdaysOnly: true };

// Saved searches — plan §2.1. `tier` weights scoring; `easyApplyOnly` splits the
// risky channel from the free one.
export const SEARCHES = [
  // Tier A — core analytics
  { tier: 'A', keywords: 'Marketing Analyst', location: 'South Africa' },
  { tier: 'A', keywords: 'Marketing Data Analyst', location: 'South Africa' },
  { tier: 'A', keywords: 'Digital Marketing Analyst', location: 'South Africa' },
  { tier: 'A', keywords: 'Growth Analyst', location: 'South Africa' },
  { tier: 'A', keywords: 'Performance Marketing Analyst', location: 'South Africa' },
  { tier: 'A', keywords: 'Marketing Analytics', location: 'European Union', remote: true },

  // Tier B — adtech / adops, the differentiator
  { tier: 'B', keywords: 'Ad Operations', location: 'South Africa' },
  { tier: 'B', keywords: 'AdOps Analyst', location: 'South Africa' },
  { tier: 'B', keywords: 'Programmatic', location: 'South Africa' },
  { tier: 'B', keywords: 'Campaign Manager', location: 'South Africa' },

  // Tier C — GTM / martech, weighted up
  { tier: 'C', keywords: 'GTM Engineer', location: 'European Union', remote: true },
  { tier: 'C', keywords: 'Marketing Operations Analyst', location: 'South Africa' },
  { tier: 'C', keywords: 'Marketing Technologist', location: 'South Africa' },
  { tier: 'C', keywords: 'Revenue Operations Analyst', location: 'South Africa' },
  { tier: 'C', keywords: 'Lifecycle Marketing', location: 'South Africa' },

  // Tier D — analytics implementation
  { tier: 'D', keywords: 'Analytics Implementation', location: 'South Africa' },
  { tier: 'D', keywords: 'Web Analyst GA4', location: 'South Africa' },
];

// Seniority band: analyst/associate/mid. Above-band applications waste budget.
export const REJECT_TITLE = /\b(senior|snr|lead|principal|staff|head of|director|vp|chief|manager of|c[teofm]o)\b/i;

// §2.3 — the highest-leverage filter. Applied before any LLM spend.
export const AUTH_BLOCKERS = [
  /must be (legally )?(authorized|authorised|eligible) to work in the (us|u\.s\.|united states|uk|united kingdom|eu)/i,
  /no (visa )?sponsorship/i,
  /(we are )?unable to sponsor/i,
  /without (the need for )?sponsorship/i,
  /must (be|reside|live) (based )?in the (us|united states|uk|united kingdom)/i,
  /us[- ]based (candidates )?only/i,
  /work authorization in the (us|united states) is required/i,
];

export const ZA_LOCATIONS = /south africa|johannesburg|cape town|durban|pretoria|sandton|gauteng|western cape|midrand|centurion/i;
export const OPEN_REMOTE = /\b(emea|africa|worldwide|anywhere|globally|remote[- ]first|any (time)?zone)\b/i;

// LinkedIn DOM changes often. Every selector lives here with fallbacks so a break
// is a one-file fix, and discovery alerts loudly rather than silently finding zero.
export const SELECTORS = {
  jobCard: ['li[data-occludable-job-id]', '.scaffold-layout__list-item', '.job-card-container'],
  jobCardId: ['data-occludable-job-id', 'data-job-id'],
  jobCardTitle: ['.job-card-list__title--link', '.job-card-list__title', 'a.job-card-container__link'],
  jobCardCompany: ['.artdeco-entity-lockup__subtitle', '.job-card-container__primary-description'],
  jobCardLocation: ['.job-card-container__metadata-wrapper', '.job-card-container__metadata-item'],
  resultsList: ['.scaffold-layout__list', '.jobs-search-results-list'],

  // LinkedIn's new server-driven UI ships hashed class names (._7e3b9f11) that
  // change every deploy, so nothing here may depend on a class. What is stable:
  // ids of the form JobDetails_AboutTheJob_<jobId>, data-sdui-component, and
  // aria-labels. Old-UI selectors stay as fallbacks — the rollout is partial.
  detailDescription: [
    '[data-sdui-component*="aboutTheJob"]',
    '#job-details', '.jobs-description__content', '.jobs-box__html-content',
  ],
  detailApplyBtn: [
    'button[aria-label*="Apply to this job" i]',
    'button[aria-label*="Apply on company website" i]',
    '[aria-label*="pply"][role="button"]',
    '.jobs-apply-button', 'button.jobs-apply-button--top-card',
  ],
  detailTitle: ['.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title'],
  // Any of these visible means stop everything (§8.2).
  challenge: ['#captcha-internal', '.challenge-dialog', 'iframe[title*="challenge" i]', '[data-id="checkpoint"]'],
};

export const LINKEDIN = {
  loginProbe: 'https://www.linkedin.com/feed/',
  searchBase: 'https://www.linkedin.com/jobs/search/',
};
