import fs from 'node:fs';
import path from 'node:path';
import { PATHS, SELECTORS } from '../config.js';
import { assertNoChallenge, ChallengeDetected, postingClosedReason } from '../browser.js';
import { bumpRate } from '../db.js';
import { isSiteSearch } from './fields.js';
import { collectFields, fillCollected } from './external.js';
import { runWizard, stepSignature, firstVisible, waitForFirstVisible, captureFailureContext, buttonByName, ADVANCE_NAME, TERMINAL_NAME } from './wizard.js';
import { resolveFormBatch } from '../answer/resolver.js';
import { normaliseQuestion } from '../answer/bank.js';
import { captureUnsolvedPage } from './agent/capture.js';
import { runAgent } from './agent/index.js';
import { preflightGate } from './preflight.js';

const MODAL = [
  // Verified live on the server-driven UI: the Easy Apply modal is a native
  // <dialog> element with a hashed class and NO role attribute. `[role="dialog"]`
  // is an attribute selector, so it misses it entirely — a native <dialog> has an
  // *implicit* dialog role but no role *attribute*. Match the tag. This is why the
  // run kept dying as "modal did not open" on a modal that was right there.
  'dialog',
  '.jobs-easy-apply-modal',
  'div[data-test-modal][role="dialog"]',
  '.artdeco-modal--layer-default',
  'div[role="dialog"][aria-label*="apply" i]',
];

const BTN = {
  // The class-only selectors match nothing on a server-driven (rolled-out) LinkedIn
  // account — see the SELECTORS.detailApplyBtn comment in config.js. The external
  // channel already uses this; Easy Apply is the ban-exposed one, so it must too.
  apply: SELECTORS.detailApplyBtn,
  next: ['button[aria-label="Continue to next step"]', 'button[data-easy-apply-next-button]'],
  review: ['button[aria-label="Review your application"]'],
  submit: ['button[aria-label="Submit application"]'],
  dismiss: ['button[aria-label="Dismiss"]', '.artdeco-modal__dismiss'],
  discard: ['button[data-test-dialog-secondary-btn]', 'button[data-control-name="discard_application_confirm_btn"]'],
  followCompany: ['#follow-company-checkbox'],
};

async function modalSelector(page) {
  for (const sel of MODAL) {
    const loc = page.locator(sel).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return sel;
  }
  return null;
}

/** Poll for the Easy Apply modal — it animates in and can take a beat to mount. */
async function waitForModal(page, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const sel = await modalSelector(page);
    if (sel) return sel;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(300);
  }
}

/**
 * A short, stable description of what the modal is currently showing.
 *
 * Exists because the fields alone cannot identify an Easy Apply step. The later
 * screens review the imported work history and the résumé: read-only cards with
 * an edit pencil, and not one fillable control between them. Every such screen
 * signs as the empty string, so the no-progress detector compared two different
 * screens, found them equal, and abandoned job 453 as "form did not advance past
 * step 3" — after it had advanced correctly to step 4.
 *
 * The leading text is enough to tell them apart and still identical when the
 * same screen is re-rendered by a click that achieved nothing, which is the case
 * the detector is for. Capped because this is compared, not read.
 */
async function modalDigest(page, limit = 400) {
  const sel = await modalSelector(page);
  if (!sel) return '';
  const text = await page.locator(sel).first().innerText().catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function shot(page, jobId, label) {
  const dir = path.join(PATHS.artifacts, 'screenshots', String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: p }).catch(() => {});
  return p;
}

/** Close the modal without applying. Handles the "discard application?" prompt. */
async function abandon(page) {
  const dismiss = await firstVisible(page, BTN.dismiss);
  if (dismiss) {
    await dismiss.click().catch(() => {});
    await page.waitForTimeout(700);
    const discard = await firstVisible(page, BTN.discard);
    if (discard) await discard.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

/**
 * Map an adaptive-agent result into the shape applyEasy returns.
 *
 * The agent runs `deterministicOnly` on this channel, so anything it could not
 * settle from the profile or the answer bank comes back parked rather than
 * written by a model — which is why a solved page here is `ready` or `parked`
 * far more often than `submitted`. That is the intended trade: the deterministic
 * tiers got 44 of 45 values right on 28 July, and every accuracy defect that run
 * produced came from the model choosing a value.
 */
function agentResult(a, { screenshots = [], filled = [] } = {}) {
  const base = {
    filled: [...filled, ...(a.filled || [])],
    screenshots,
    steps: a.steps || 0,
    agent: { kind: a.planKind, fingerprint: a.fingerprint },
  };
  if (a.outcome === 'submitted') return { outcome: 'submitted', ...base, evidence: a.evidence || null };
  if (a.outcome === 'parked') {
    return {
      outcome: 'parked', ...base,
      parked: (a.parked || []).map(p => ({
        question: p.question, questionNorm: normaliseQuestion(p.question),
        fieldType: p.fieldType, options: p.options, reason: p.reason, tier: p.tier,
      })),
    };
  }
  return {
    outcome: 'ready', ...base,
    heldForReview: 'the adaptive agent filled this form — approve it to submit',
  };
}

/**
 * Drive one LinkedIn Easy Apply application.
 *
 * The step machine itself lives in `wizard.js` — this file is now the LinkedIn
 * half: which button means next, where the modal is, and how to close it without
 * applying. That split is what lets an unknown ATS reuse the same loop.
 *
 * `submit: false` fills every step and captures what would be sent, then
 * abandons. Review mode uses that; approving re-runs the whole flow with
 * submit:true rather than trying to resume a modal that has long since closed.
 */
export async function applyEasy(page, job, ctx, { submit = false, resumePath = null } = {}) {
  const screenshots = [];
  const uploaded = [];
  const uploadedUids = new Set();

  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  // A signed-in posting view, exactly like the one resolveExternalUrl charges for.
  // This channel never counted its own, so the budget that exists to keep LinkedIn
  // browsing under a ceiling was blind to the channel that carries the ban risk:
  // fifteen Easy Apply attempts a day cost fifteen pageviews and recorded none.
  bumpRate('linkedin_pageviews');
  await assertNoChallenge(page);

  // Poll: the top card (and its Apply button) hydrates after first paint, so a
  // single check a fixed moment after navigation loses the race on an open
  // posting and reports it closed.
  const applyBtn = await waitForFirstVisible(page, BTN.apply, { timeout: 10_000 });
  if (!applyBtn) {
    // Ask the page why before blaming the selector. A closed posting has no
    // apply control and says so in red; reporting that as "the selector broke"
    // spends three retries proving a vacancy is still closed.
    const closed = await postingClosedReason(page);
    if (closed) return { outcome: 'closed', reason: closed };

    const failure = await captureFailureContext(page, shot, job.id, 'no-apply-button');
    const why =
      `No apply button after 10s — posting may have closed, or the selector broke. ` +
      `url=${failure.url} title="${failure.title}" buttons=[${failure.buttons.join(' | ')}]`;

    // Three of fourteen attempts died here on 28 July, on postings that were
    // open. The apply control is the one thing on this page a hand-written
    // selector must find, and LinkedIn changes it; a page whose form sits behind
    // a button it cannot name is precisely what the planner's `landing` kind is
    // for. It reads the page and says which control opens the application.
    const agent = await runAgent(page, {
      job, ctx: { ...ctx, ats: 'linkedin' }, resumePath, submit,
      stage: 'no-apply-button', reason: why, deterministicOnly: true,
    });
    if (agent) return agentResult(agent, { screenshots });

    throw new Error(why);
  }

  const label = (await applyBtn.innerText().catch(() => '')) || '';
  if (!/easy apply/i.test(label)) throw new Error(`Not an Easy Apply posting (button reads "${label.trim()}")`);

  await applyBtn.click();

  const opened = await waitForModal(page, 8000);
  if (!opened) {
    const failure = await captureFailureContext(page, shot, job.id, 'modal-did-not-open');
    const why =
      `Easy Apply modal did not open within 8s after clicking Apply. ` +
      `url=${failure.url} title="${failure.title}" buttons=[${failure.buttons.join(' | ')}]`;

    const agent = await runAgent(page, {
      job, ctx: { ...ctx, ats: 'linkedin' }, resumePath, submit,
      stage: 'modal-did-not-open', reason: why, deterministicOnly: true,
    });
    if (agent) return agentResult(agent, { screenshots });

    throw new Error(why);
  }

  // The modal's first step renders progressively — the <dialog> mounts before its
  // footer button does. Verified live: the wizard's first findAdvance would race
  // that render and abandon a perfectly good form as "step 1 has no next control".
  // Wait for a footer control (or, failing that, an input) to actually be there.
  for (let i = 0; i < 16; i++) {
    if ((await buttonByName(page, ADVANCE_NAME)) || (await buttonByName(page, TERMINAL_NAME))) break;
    await page.waitForTimeout(500);
  }
  screenshots.push(await shot(page, job.id, 'step-0-open'));

  try {
    // DOM first, accessibility tree when the DOM comes up short — the same rule
    // and the same code the external adapter has used since it was written.
    //
    // Easy Apply was the one adapter with no fallback, so a control shape the
    // DOM extractor cannot read was simply not there as far as this channel was
    // concerned. That is how three required radio groups on job 280 came to be
    // submitted blank. The immediate cause of that one is fixed in fields.js;
    // this is so the next shape LinkedIn ships fails visibly rather than
    // silently, which is what the external path already gets.
    const easyApplyVendor = { formRoot: MODAL, a11y: false };

    const collect = async () => {
      await assertNoChallenge(page);
      const sel = await modalSelector(page);
      if (!sel) return [];

      const { items } = await collectFields(page, sel, easyApplyVendor);

      // The resume upload is handled directly, not through the answer resolver.
      for (const item of items) {
        if (item.role !== 'file' || !resumePath || uploadedUids.has(item.uid)) continue;
        uploadedUids.add(item.uid);
        try {
          await fillCollected(page, item, resumePath);
          uploaded.push({
            uid: item.uid, question: item.question || 'Resume',
            value: path.basename(resumePath), tier: 'resume', kind: 'file',
          });
          await page.waitForTimeout(1500);
        } catch { /* LinkedIn often pre-selects a stored resume; upload is optional */ }
      }

      // LinkedIn's own header is not a screening question. When the modal closes
      // under the collector this is the second line of defence — the first is
      // collectFieldsInPage refusing to widen to the document when its root has
      // gone. Job 453 captured a "Search" textbox and a "Select language"
      // combobox as the application form; nothing was typed into them only
      // because the run was already stuck.
      return items.filter(i => i.role !== 'file' && i.question && !isSiteSearch(i.question));
    };

    const result = await runWizard({
      submit,
      collect,
      resolve: items => resolveFormBatch(items, ctx),
      fill: (item, value) => fillCollected(page, item, value),
      // Read the whole application back before pressing submit. Easy Apply had
      // no such check: whatever the ladder produced went to the employer.
      mayFinish: preflightGate({
        profile: ctx.profile, job, channel: 'linkedin_easy', ats: 'linkedin',
        countryCode: ctx.countryCode,
      }),
      // Verified live: the Next button is just <button>Next</button> — no
      // aria-label, no data attribute — so the aria-label selectors in BTN.next
      // match nothing. Find the footer controls by accessible name (text), the
      // way the external adapter does, and keep the old selectors as a fallback
      // for accounts still on the classic UI.
      // A step this adapter can describe even when it has nothing to fill.
      //
      // The fields alone are not enough on this channel: Easy Apply's later
      // screens review the imported work history and the résumé, and carry no
      // fillable control, so every one of them signs as "" and compares equal to
      // the next. Adding what the modal actually says distinguishes them, and
      // still compares equal when the same screen is re-rendered after a click
      // that did nothing — which is the case the check exists for.
      signature: async nodes => `${stepSignature(nodes)}\n--\n${await modalDigest(page)}`,
      findTerminal: async () => (await buttonByName(page, TERMINAL_NAME)) || firstVisible(page, BTN.submit),
      findAdvance: async () => (await buttonByName(page, ADVANCE_NAME))
        || (await firstVisible(page, BTN.next)) || firstVisible(page, BTN.review),
      onStep: async ({ step }) => {
        // Don't silently start following companies.
        const follow = await firstVisible(page, BTN.followCompany);
        if (follow) await follow.uncheck({ force: true }).catch(() => {});
        screenshots.push(await shot(page, job.id, `step-${step}`));
      },
    });

    const filled = [...uploaded, ...result.filled];

    if (result.outcome === 'parked') {
      await abandon(page);
      return {
        outcome: 'parked',
        parked: result.parked.map(p => ({
          question: p.question,
          questionNorm: normaliseQuestion(p.question),
          fieldType: p.fieldType,
          options: p.options,
          reason: p.reason,
          tier: p.tier,
        })),
        filled, screenshots, steps: result.steps,
      };
    }

    if (result.outcome === 'stuck') {
      // Eight of fourteen attempts on 28 July ended here — "form did not advance
      // past step 2", "step 1 has no next/submit control" — and this channel had
      // no agent coverage at all, so every one of them was simply thrown away.
      // A modal whose footer control the hand-written selectors cannot name is
      // the same problem the planner already solves on unknown ATS pages.
      //
      // Scoped to the modal, which matters twice over: the planner sees the
      // application rather than the LinkedIn page it sits on, and the plan is
      // cached against the shape of a form rather than the shape of a website.
      const modal = await modalSelector(page);
      const agent = await runAgent(page, {
        job, ctx: { ...ctx, ats: 'linkedin' }, resumePath, submit,
        stage: 'stuck', reason: result.reason,
        rootSelector: modal || 'body', deterministicOnly: true,
      });
      if (agent) {
        await abandon(page).catch(() => {});
        return agentResult(agent, { screenshots, filled });
      }

      // Capture before abandoning — abandon() closes the modal, after which the
      // stuck form is gone.
      await captureUnsolvedPage(page, {
        job, vendor: 'linkedin_easy', stage: 'stuck', reason: result.reason,
        rootSelector: modal || 'body',
      });
      await abandon(page);
      throw new Error(result.reason);
    }

    if (result.outcome === 'ready') {
      await abandon(page);
      return { outcome: 'ready', filled, screenshots, steps: result.steps, heldForReview: result.reason || null };
    }

    await result.terminal.click();
    await page.waitForTimeout(3500);
    const evidence = await shot(page, job.id, 'submitted');
    screenshots.push(evidence);

    const stillOpen = await modalSelector(page);
    const confirmed = !stillOpen || await page.locator('text=/application sent|your application was sent|applied/i')
      .first().isVisible().catch(() => false);
    if (!confirmed) throw new Error('Clicked submit but saw no confirmation');

    return { outcome: 'submitted', filled, screenshots, steps: result.steps, evidence };
  } catch (err) {
    if (err instanceof ChallengeDetected) throw err;
    await abandon(page).catch(() => {});
    throw err;
  }
}

export { abandon as abandonEasyApply };
