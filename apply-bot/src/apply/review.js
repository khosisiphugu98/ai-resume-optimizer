/**
 * Reading an attempt back.
 *
 * Two questions an operator asks about an application that did not go out — why
 * is it waiting for me, and what did the form actually get — and the answers to
 * both are derivable from what was already recorded. They live here, apart from
 * the code that applies, because the dashboard needs them and the dashboard
 * deliberately does not load the apply stage: every stage module in server.js is
 * imported lazily so that opening the board does not start Playwright.
 *
 * Nothing in this file imports anything.
 */

/**
 * Why an application is sitting in Review, in one word.
 *
 * "I see a lot of applications in review while we are in auto mode" is a fair
 * reading of a column that shows fifty cards and no reason on any of them, and
 * the honest answer turned out to be that exactly one of the fifty was there
 * because the mode said so. The rest were a safety check refusing to send, an
 * adapter that will not auto-submit, or a page that was never an application
 * form. Four different problems with four different fixes, and the column could
 * not tell them apart.
 */
export function holdKind(why = '') {
  const s = String(why);
  if (/^held by the pre-send check/i.test(s)) return 'preflight';
  if (/pre-send reviewer is unavailable/i.test(s)) return 'reviewer-down';
  if (/not an application form|nowhere to attach a CV/i.test(s)) return 'not-an-application';
  if (/does not auto-submit|generic auto-submit/i.test(s)) return 'adapter-no-autosubmit';
  if (/adaptive agent filled this form/i.test(s)) return 'agent-fill';
  if (/CV upload did not take/i.test(s)) return 'no-cv';
  if (/mode is review/i.test(s)) return 'review-mode';
  return 'other';
}

/** What each hold kind means, and what an operator can do about it. */
export const HOLD_KINDS = {
  'preflight': 'the pre-send check refused a specific answer',
  'reviewer-down': 'the pre-send reviewer was unreachable — retries on its own',
  'not-an-application': 'the page has no way to attach a CV',
  'adapter-no-autosubmit': 'this vendor is never auto-submitted without approval',
  'agent-fill': 'the adaptive agent filled it, so a person confirms it',
  'no-cv': 'the CV upload did not take',
  'review-mode': 'the run mode is review — this is the queue working as intended',
  'other': 'held for a reason the board does not recognise',
};

/**
 * What the field ledger says about an attempt, in numbers.
 *
 * The counts an operator actually asks for: how much of the form was answered,
 * how much of it was verified to have landed in the page, and — the one that
 * matters most — how many *required* controls were left empty. A submitted
 * application with a non-zero `requiredMissed` is a defect whatever the outcome
 * column says about it.
 */
export function ledgerSummary(ledger = []) {
  const by = {};
  for (const row of ledger) by[row.disposition] = (by[row.disposition] || 0) + 1;
  const landed = new Set(['filled', 'prefilled']);
  const missed = ledger.filter(r => r.required && !landed.has(r.disposition));
  return {
    controls: ledger.length,
    answered: (by.filled || 0) + (by.prefilled || 0),
    byDisposition: by,
    verified: ledger.filter(r => r.verified === true).length,
    // Answered, but the control could not be read back — a custom combobox, a
    // file input. Not a failure and not a success; counted apart from both so it
    // never inflates either.
    unverified: ledger.filter(r => landed.has(r.disposition) && r.verified == null).length,
    reverted: by.reverted || 0,
    requiredMissed: missed.length,
    requiredMissedQuestions: missed.slice(0, 10).map(r => `${r.question} [${r.disposition}]`),
  };
}
