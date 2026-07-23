import fs from 'node:fs';
import path from 'node:path';
import { PATHS, SELECTORS } from '../config.js';
import { assertNoChallenge, ChallengeDetected } from '../browser.js';
import { collectFieldsInPage, fillField, fromDomField } from './fields.js';
import { runWizard, stepSignature, firstVisible, waitForFirstVisible, captureFailureContext, buttonByName, ADVANCE_NAME, TERMINAL_NAME } from './wizard.js';
import { resolveFormBatch } from '../answer/resolver.js';
import { normaliseQuestion } from '../answer/bank.js';

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
  await assertNoChallenge(page);

  // Poll: the top card (and its Apply button) hydrates after first paint, so a
  // single check a fixed moment after navigation loses the race on an open
  // posting and reports it closed.
  const applyBtn = await waitForFirstVisible(page, BTN.apply, { timeout: 10_000 });
  if (!applyBtn) {
    const ctx = await captureFailureContext(page, shot, job.id, 'no-apply-button');
    throw new Error(
      `No apply button after 10s — posting may have closed, or the selector broke. ` +
      `url=${ctx.url} title="${ctx.title}" buttons=[${ctx.buttons.join(' | ')}]`);
  }

  const label = (await applyBtn.innerText().catch(() => '')) || '';
  if (!/easy apply/i.test(label)) throw new Error(`Not an Easy Apply posting (button reads "${label.trim()}")`);

  await applyBtn.click();

  const opened = await waitForModal(page, 8000);
  if (!opened) {
    const ctx = await captureFailureContext(page, shot, job.id, 'modal-did-not-open');
    throw new Error(
      `Easy Apply modal did not open within 8s after clicking Apply. ` +
      `url=${ctx.url} title="${ctx.title}" buttons=[${ctx.buttons.join(' | ')}]`);
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
    const collect = async () => {
      await assertNoChallenge(page);
      const sel = await modalSelector(page);
      if (!sel) return [];

      const fields = await page.evaluate(collectFieldsInPage, sel);

      // The resume upload is handled directly, not through the answer resolver.
      for (const f of fields.filter(x => x.kind === 'file')) {
        if (!resumePath || uploadedUids.has(f.selector)) continue;
        uploadedUids.add(f.selector);
        try {
          await fillField(page, f, resumePath);
          uploaded.push({
            uid: f.selector, question: f.question,
            value: path.basename(resumePath), tier: 'resume', kind: 'file',
          });
          await page.waitForTimeout(1500);
        } catch { /* LinkedIn often pre-selects a stored resume; upload is optional */ }
      }

      return fields.filter(f => f.kind !== 'file' && f.question).map(fromDomField);
    };

    const result = await runWizard({
      submit,
      collect,
      resolve: items => resolveFormBatch(items, ctx),
      fill: (item, value) => fillField(page, item.field, value),
      // Verified live: the Next button is just <button>Next</button> — no
      // aria-label, no data attribute — so the aria-label selectors in BTN.next
      // match nothing. Find the footer controls by accessible name (text), the
      // way the external adapter does, and keep the old selectors as a fallback
      // for accounts still on the classic UI.
      findTerminal: async () => (await buttonByName(page, TERMINAL_NAME)) || firstVisible(page, BTN.submit),
      findAdvance: async () => (await buttonByName(page, ADVANCE_NAME))
        || (await firstVisible(page, BTN.next)) || firstVisible(page, BTN.review),
      signature: stepSignature,
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
      await abandon(page);
      throw new Error(result.reason);
    }

    if (result.outcome === 'ready') {
      await abandon(page);
      return { outcome: 'ready', filled, screenshots, steps: result.steps };
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
