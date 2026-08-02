/**
 * The observability layer: run scoping, the field ledger, the log query, and the
 * two things that were quietly filling the Review column.
 *
 * These are the checks that would have caught the defects they cover. The
 * follow-company case in particular: every field-level test passed while
 * fourteen applications were held, because nothing asserted anything about what
 * the *record* said — only about what the page did.
 */
import './_sandbox.mjs';   // refuses to run against the real database
import { chromium } from 'playwright';
import {
  db, queryEvents, logSummary, logFacets, recordSkillSuggestions, listSkillSuggestions,
  watchedSkills, setSetting, SKILL_SUGGESTION_THRESHOLD,
} from '../src/db.js';
import { emit, withRun, currentRun } from '../src/bus.js';
import { runWizard, sameValue, stepSignature } from '../src/apply/wizard.js';
import { holdKind, ledgerSummary } from '../src/apply/review.js';
import { isFollowCompany } from '../src/apply/linkedin-easy.js';
import { collectFieldsInPage, fromDomField, fillField, readFieldValue } from '../src/apply/fields.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

// ---------------------------------------------------------------------------
section('a run scopes everything logged inside it');

t('no run at the top level', currentRun(), null);

let inner = null;
const out = await withRun('tailor', async run => {
  // Deliberately behind an await and inside a nested call: the whole point of
  // AsyncLocalStorage here is that depth and asynchrony do not lose the scope.
  await new Promise(r => setTimeout(r, 5));
  inner = await (async () => {
    emit({ message: 'something happened deep inside', component: 'tailor/optimiser' });
    return currentRun()?.id;
  })();
  return { tailored: 3 };
}, { trigger: 'test' });

t('the run id is stable across awaits', inner === out ? true : typeof inner, 'string');
t('and the scope closes after it', currentRun(), null);

const runRows = db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY id`).all(inner);
t('start, the inner line, and finish are all grouped', runRows.length, 3);
t('the stage is inherited without being passed', runRows[1].stage, 'tailor');
t('the component is kept as given', runRows[1].component, 'tailor/optimiser');
t('the finish line carries a duration', runRows[2].duration_ms >= 0, true);
t('and the stats it returned', JSON.parse(runRows[2].data_json).stats, { tailored: 3 });

// A stage that throws must still close its run in the log — that is the run
// somebody will go looking for.
let threw = false;
const crashed = await withRun('apply', async run => { throw new Error('the browser went away'); })
  .catch(() => { threw = true; return null; });
t('a crashing stage rethrows', threw, true);
const crashRows = db.prepare(
  `SELECT * FROM events WHERE stage = 'apply' AND level = 'error' ORDER BY id DESC LIMIT 1`).all();
t('and is closed off in the log', /the browser went away/.test(crashRows[0].message), true);
t('with the stack, for the export', /Error|withRun|logging-tests/.test(JSON.parse(crashRows[0].data_json).stack), true);

// ---------------------------------------------------------------------------
section('the log query is one query behind the viewer and the download');

emit({ stage: 'apply', level: 'warn', message: 'a warning about Acme Corp', component: 'apply/hold' });
emit({ stage: 'apply', level: 'debug', message: 'a quiet detail', data: { needle: 'findme' } });
emit({ stage: 'score', level: 'error', message: 'scoring blew up' });

t('minLevel is a floor, not an equality test',
  queryEvents({ days: 1, minLevel: 'warn' }).rows.every(r => r.level !== 'debug' && r.level !== 'info'), true);
t('  → and it keeps the levels above it',
  queryEvents({ days: 1, minLevel: 'warn' }).rows.some(r => r.level === 'error'), true);
t('stage filters', queryEvents({ days: 1, stage: 'score' }).rows.every(r => r.stage === 'score'), true);
t('component filters', queryEvents({ days: 1, component: 'apply/hold' }).rows.length, 1);
t('run filters', queryEvents({ days: 1, runId: inner }).rows.length, 3);
t('search reads the message', queryEvents({ days: 1, search: 'Acme Corp' }).rows.length, 1);
t('and the structured payload too', queryEvents({ days: 1, search: 'findme' }).rows.length, 1);
t('an unknown level does not silently return nothing',
  queryEvents({ days: 1, minLevel: 'shouty' }).rows.length > 0, true);
t('total counts the matches, not the page',
  queryEvents({ days: 1, limit: 1 }).total > 1, true);

const facets = logFacets({ days: 1 });
t('facets list the stages actually present', facets.stages.includes('apply') && facets.stages.includes('score'), true);
const summary = logSummary({ days: 1 });
t('the summary counts errors per stage',
  summary.byStage.find(s => s.stage === 'score').errors >= 1, true);

// ---------------------------------------------------------------------------
section('the field ledger records what did NOT happen, not only what did');

t('a filled control is landed', ledgerSummary([{ disposition: 'filled', required: true, verified: true }]).answered, 1);
const missed = ledgerSummary([
  { disposition: 'filled', required: true, verified: true, question: 'Email' },
  { disposition: 'reverted', required: true, verified: false, question: 'Phone' },
  { disposition: 'not-reached', required: true, question: 'Notice period' },
  { disposition: 'parked', required: false, question: 'Salary' },
]);
t('a reverted field is not an answered one', missed.answered, 1);
t('required-but-empty is counted', missed.requiredMissed, 2);
t('  → and named, because the count alone is not actionable',
  missed.requiredMissedQuestions, ['Phone [reverted]', 'Notice period [not-reached]']);
t('an unreadable control is neither verified nor reverted',
  ledgerSummary([{ disposition: 'filled', verified: null }]),
  { controls: 1, answered: 1, byDisposition: { filled: 1 }, verified: 0, unverified: 1,
    reverted: 0, requiredMissed: 0, requiredMissedQuestions: [] });

section('what counts as the same value coming back out of a control');
t('identical', sameValue('Yes', 'yes'), true);
t('a select fitting the answer onto its own label', sameValue('South Africa +27', 'South Africa'), true);
t('punctuation and spacing', sameValue('+27 82 820 4538', '+27828204538'), true);
t('an empty box where a value was typed is NOT the same', sameValue('', 'Khosi'), false);
t('and neither is a different answer', sameValue('No', 'Yes'), false);

// ---------------------------------------------------------------------------
section('a control that silently reverts is caught by reading the page back');

const browser = await chromium.launch();
const page = await browser.newPage();

// A controlled input that throws away whatever is typed into it — the React
// pattern that made `fill()` report success on an empty box.
await page.setContent(`<!DOCTYPE html><body><form id="f">
  <label for="good">Full name</label><input id="good" type="text">
  <label for="bad">Phone</label><input id="bad" type="text">
  <label for="req">Notice period</label><input id="req" type="text" required>
  <script>
    document.getElementById('bad').addEventListener('input', e => { e.target.value = ''; });
  </script>
</form></body>`);

const specs = await page.evaluate(collectFieldsInPage, '#f');
const nodes = specs.map(fromDomField);

const answers = { 'Full name': 'Khosi Siphugu', 'Phone': '+27828204538' };
const result = await runWizard({
  collect: async () => nodes,
  // "Notice period" comes back with a non-ok status: the resolver looked at it
  // and produced nothing. That is a different fact from a control the loop never
  // got to, and the ledger keeps them apart.
  resolve: async items => ({
    resolved: items.map(i => (answers[i.question] != null
      ? { uid: i.uid, question: i.question, value: answers[i.question], status: 'ok', tier: 'profile' }
      : { uid: i.uid, question: i.question, status: 'unresolved', reason: 'nothing in the profile answers this' })),
    parked: [],
  }),
  fill: (item, value) => fillField(page, item.field, value),
  verify: item => readFieldValue(page, item.field),
  signature: stepSignature,
  findTerminal: async () => null,
  findAdvance: async () => null,
});

const led = result.ledger;
const byQ = Object.fromEntries(led.map(r => [r.question, r]));

t('the honest control is verified', byQ['Full name'].verified, true);
t('  → and recorded as filled', byQ['Full name'].disposition, 'filled');
t('the reverting control is caught', byQ['Phone'].disposition, 'reverted');
t('  → verified is false, not null', byQ['Phone'].verified, false);
t('  → and what the page actually holds is kept', byQ['Phone'].readBack, '');
t('the unanswered required control is in the ledger at all', byQ['Notice period'].disposition, 'no-answer');
t('  → with the resolver\'s reason', byQ['Notice period'].reason, 'nothing in the profile answers this');
t('  → and is flagged required', byQ['Notice period'].required, true);

const s = ledgerSummary(led);
t('so the summary says 1 of 3 answered', [s.answered, s.controls], [1, 3]);
t('and names the required field that went out empty', s.requiredMissed, 1);

// The old record would have shown this as a clean two-field fill.
t('the reverted field is still reported in filled, but marked',
  result.filled.find(f => f.question === 'Phone').verified, false);

await browser.close();

// ---------------------------------------------------------------------------
section("LinkedIn's follow-company box is not one of the employer's questions");

t('matched on its label', isFollowCompany({ question: 'Follow Acme Corp to stay up to date with their page' }), true);
t('matched on its id', isFollowCompany({ uid: '#follow-company-checkbox', question: '' }), true);
t('a real question about following up is not it',
  isFollowCompany({ question: 'How do you follow up with a difficult client?' }), false);
t('nor is a real screening question', isFollowCompany({ question: 'Years of experience with SQL' }), false);

// ---------------------------------------------------------------------------
section('why an application is in the Review column');

t('the pre-send check refusing an answer',
  holdKind('held by the pre-send check: "Follow X" was going to be sent as "Yes" — grants a subscription'), 'preflight');
t('a page that is not an application form',
  holdKind('nowhere to attach a CV, so this is not an application form (0 field(s) filled).'), 'not-an-application');
t('an adapter that never auto-submits',
  holdKind('the greenhouse adapter does not auto-submit — approve this application'), 'adapter-no-autosubmit');
t('the reviewer being unreachable', holdKind('the pre-send reviewer is unavailable (429)'), 'reviewer-down');
t('and the queue working as intended', holdKind('mode is review — awaiting approval'), 'review-mode');

// ---------------------------------------------------------------------------
section('a skill needs more than one job description behind it');

db.prepare('DELETE FROM skill_suggestions').run();
setSetting('skill_suggestion_threshold', String(SKILL_SUGGESTION_THRESHOLD));

recordSkillSuggestions(['Informatica PowerCenter'], { 'Informatica PowerCenter': 'not found in any uploaded document' });
t('one posting does not make a question', listSkillSuggestions().length, 0);
t('  → but it is counted, not discarded', watchedSkills().map(w => [w.display, w.job_count]), [['Informatica PowerCenter', 1]]);

recordSkillSuggestions(['Informatica PowerCenter']);
t('two is still not enough', listSkillSuggestions().length, 0);

recordSkillSuggestions(['Informatica PowerCenter']);
t('three postings asking for the same thing is a signal',
  listSkillSuggestions().map(s => s.display), ['Informatica PowerCenter']);
t('  → and it leaves the watch list', watchedSkills().length, 0);

// Dismissal must survive volume, or "stop asking me" would mean "ask me again
// in three more postings".
db.prepare(`UPDATE skill_suggestions SET status = 'dismissed'`).run();
recordSkillSuggestions(['Informatica PowerCenter']);
recordSkillSuggestions(['Informatica PowerCenter']);
t('a dismissed skill is never resurrected by volume', listSkillSuggestions().length, 0);

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
