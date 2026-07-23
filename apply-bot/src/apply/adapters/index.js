/**
 * ATS vendor registry.
 *
 * Greenhouse, Lever, Ashby, Workable and SmartRecruiters are all the same shape:
 * one page, labelled inputs, a file input, a submit button. The generic field
 * extractor already handles the middle of that, so a vendor is a small config —
 * how to recognise it, where the form is, where the file and submit controls are,
 * and what success looks like — not a bespoke adapter that rots on its own.
 *
 * Several of these render behind hashed CSS class names (Ashby, Workable), so
 * selectors here deliberately lean on stable attributes: name, type, data-ui,
 * aria-label, and button text.
 */
export const VENDORS = [
  {
    vendor: 'greenhouse',
    match: url => /(boards|job-boards)\.greenhouse\.io|greenhouse\.io\/embed/i.test(url),
    formRoot: ['#application-form', '#application_form', 'form#application', '[data-testid="application-form"]', 'main form', 'form'],
    fileInput: ['input[type=file][name*="resume" i]', 'input[type=file][id*="resume" i]', 'input[type=file]'],
    submit: ['#submit_app', 'button[type=submit]', 'input[type=submit]'],
    success: [/application (has been )?(successfully )?submitted/i, /thank you for applying/i, /we.{0,3}(ve| have) received your application/i],
  },
  {
    vendor: 'lever',
    match: url => /jobs\.(eu\.)?lever\.co/i.test(url),
    formRoot: ['.application-form', 'form[action*="apply"]', 'form'],
    fileInput: ['input[type=file][name="resume"]', 'input[type=file]'],
    submit: ['#btn-submit', 'button[type=submit].postings-btn', 'button[type=submit]'],
    success: [/thank you for applying/i, /application received/i, /we.{0,3}(ve| have) received your application/i],
  },
  {
    vendor: 'ashby',
    match: url => /jobs\.ashbyhq\.com/i.test(url),
    formRoot: ['form', '[class*="_form"]'],
    fileInput: ['input[type=file]'],
    submit: ['button[type=submit]', 'button:has-text("Submit Application")'],
    success: [/thank you|application (has been )?(received|submitted)|successfully applied/i],
  },
  {
    vendor: 'workable',
    match: url => /apply\.workable\.com|\.workable\.com\/j\//i.test(url),
    formRoot: ['[data-ui="application-form"]', 'form', 'main'],
    fileInput: ['input[type=file]'],
    submit: ['button[data-ui="submit-application"]', 'button[type=submit]'],
    success: [/thank you|application (has been )?(received|submitted)/i],
  },
  {
    vendor: 'smartrecruiters',
    match: url => /jobs\.smartrecruiters\.com|careers\.smartrecruiters\.com/i.test(url),
    formRoot: ['#application-form', 'form[name="applicationForm"]', 'form'],
    fileInput: ['input[type=file]'],
    submit: ['#submit-application', 'button[type=submit]'],
    success: [/thank you|application (has been )?(received|submitted)|we.{0,3}(ve| have) received/i],
  },
];

/** Vendors we deliberately do not automate yet — routed to a manual checklist. */
export const DEFERRED = [
  // myworkdaysite.com is Workday's other tenant domain (verified live: AB InBev's
  // careers site resolves there). Without it the posting fell through to the
  // generic adapter and failed as "no form found" instead of routing to manual.
  { vendor: 'workday', match: url => /myworkdayjobs\.com|myworkdaysite\.com|workday\.com/i.test(url),
    why: 'Workday requires a per-tenant account and a multi-page wizard' },
  { vendor: 'taleo', match: url => /taleo\.net|tbe\.taleo\.net/i.test(url),
    why: 'Taleo requires an account and uses legacy nested frames' },
  { vendor: 'icims', match: url => /\.icims\.com/i.test(url),
    why: 'iCIMS nests the form in cross-origin frames' },
];

/** Generic fallback: same flow, no vendor-specific knowledge. */
export const GENERIC = {
  vendor: 'generic',
  match: () => true,
  formRoot: ['form', 'main', 'body'],
  fileInput: ['input[type=file][name*="resume" i]', 'input[type=file][name*="cv" i]', 'input[type=file]'],
  submit: ['button[type=submit]', 'input[type=submit]', 'button:has-text("Submit")', 'button:has-text("Apply")'],
  success: [/thank you|application (has been )?(received|submitted)|successfully applied/i],
  // An unknown form is the case the accessibility collector exists for: no native
  // controls, a form in a shadow root, or labels that are only labels visually.
  a11y: true,
  requiresReview: true,   // never auto-submit an unknown form
};

export function detectVendor(url, { includeGeneric = true } = {}) {
  const deferred = DEFERRED.find(v => v.match(url));
  if (deferred) return { ...deferred, deferred: true };
  const hit = VENDORS.find(v => v.match(url));
  if (hit) return hit;
  return includeGeneric ? GENERIC : null;
}
