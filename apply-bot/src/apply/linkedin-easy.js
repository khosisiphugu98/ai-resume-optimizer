import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { assertNoChallenge, humanDelay, ChallengeDetected } from '../browser.js';
import { collectFieldsInPage, fillField } from './fields.js';
import { resolveForm } from '../answer/resolver.js';
import { normaliseQuestion } from '../answer/bank.js';
import { emit } from '../bus.js';

const MODAL = [
  '.jobs-easy-apply-modal',
  'div[data-test-modal][role="dialog"]',
  '.artdeco-modal--layer-default',
];

const BTN = {
  apply: ['.jobs-apply-button', 'button.jobs-apply-button--top-card'],
  next: ['button[aria-label="Continue to next step"]', 'button[data-easy-apply-next-button]'],
  review: ['button[aria-label="Review your application"]'],
  submit: ['button[aria-label="Submit application"]'],
  dismiss: ['button[aria-label="Dismiss"]', '.artdeco-modal__dismiss'],
  discard: ['button[data-test-dialog-secondary-btn]', 'button[data-control-name="discard_application_confirm_btn"]'],
  followCompany: ['#follow-company-checkbox'],
};

const MAX_STEPS = 8;

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function modalSelector(page) {
  for (const sel of MODAL) {
    const loc = page.locator(sel).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return sel;
  }
  return null;
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
 * `submit: false` fills every step and captures what would be sent, then
 * abandons. Review mode uses that; approving re-runs the whole flow with
 * submit:true rather than trying to resume a modal that has long since closed.
 */
export async function applyEasy(page, job, ctx, { submit = false, resumePath = null } = {}) {
  const screenshots = [];
  const filled = [];
  let steps = 0;

  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await assertNoChallenge(page);

  const applyBtn = await firstVisible(page, BTN.apply);
  if (!applyBtn) throw new Error('No apply button on the job page — posting may have closed');

  const label = (await applyBtn.innerText().catch(() => '')) || '';
  if (!/easy apply/i.test(label)) throw new Error(`Not an Easy Apply posting (button reads "${label.trim()}")`);

  await applyBtn.click();
  await page.waitForTimeout(2000);

  const modalSel = await modalSelector(page);
  if (!modalSel) throw new Error('Easy Apply modal did not open');
  screenshots.push(await shot(page, job.id, 'step-0-open'));

  try {
    while (steps < MAX_STEPS) {
      steps++;
      await assertNoChallenge(page);

      const sel = await modalSelector(page);
      if (!sel) break;

      const fields = await page.evaluate(collectFieldsInPage, sel);

      // The resume upload is handled directly, not through the answer resolver.
      const fileFields = fields.filter(f => f.kind === 'file');
      const formFields = fields.filter(f => f.kind !== 'file' && f.question);

      for (const f of fileFields) {
        if (!resumePath) continue;
        try {
          await fillField(page, f, resumePath);
          filled.push({ question: f.question, value: path.basename(resumePath), tier: 'resume', kind: 'file' });
          await page.waitForTimeout(1500);
        } catch { /* LinkedIn often pre-selects a stored resume; upload is optional */ }
      }

      if (formFields.length) {
        const { resolved, parked } = await resolveForm(formFields, ctx);

        if (parked.length) {
          await abandon(page);
          return {
            outcome: 'parked',
            parked: parked.map(p => ({
              question: p.question,
              questionNorm: normaliseQuestion(p.question),
              fieldType: p.fieldType,
              options: p.options,
              reason: p.reason,
              tier: p.tier,
            })),
            filled, screenshots, steps,
          };
        }

        for (const r of resolved) {
          if (r.status !== 'ok') continue;
          const field = formFields.find(f => f.question === r.question);
          if (!field) continue;
          try {
            const landed = await fillField(page, field, r.value);
            filled.push({ question: r.question, value: landed, tier: r.tier, kind: field.kind, probable: !!r.probable });
          } catch (err) {
            await abandon(page);
            return {
              outcome: 'parked',
              parked: [{
                question: r.question, questionNorm: normaliseQuestion(r.question),
                fieldType: r.fieldType, options: field.options,
                reason: `could not apply "${r.value}": ${err.message}`, tier: 'fill-error',
              }],
              filled, screenshots, steps,
            };
          }
        }
      }

      // Don't silently start following companies.
      const follow = await firstVisible(page, BTN.followCompany);
      if (follow) await follow.uncheck({ force: true }).catch(() => {});

      screenshots.push(await shot(page, job.id, `step-${steps}`));

      const submitBtn = await firstVisible(page, BTN.submit);
      if (submitBtn) {
        if (!submit) {
          await abandon(page);
          return { outcome: 'ready', filled, screenshots, steps };
        }
        await submitBtn.click();
        await page.waitForTimeout(3500);
        const evidence = await shot(page, job.id, 'submitted');
        screenshots.push(evidence);

        const stillOpen = await modalSelector(page);
        const confirmed = !stillOpen || await page.locator('text=/application sent|your application was sent|applied/i')
          .first().isVisible().catch(() => false);
        if (!confirmed) throw new Error('Clicked submit but saw no confirmation');

        return { outcome: 'submitted', filled, screenshots, steps, evidence };
      }

      const nextBtn = (await firstVisible(page, BTN.next)) || (await firstVisible(page, BTN.review));
      if (!nextBtn) {
        await abandon(page);
        throw new Error(`Stuck on step ${steps}: no Next, Review or Submit button`);
      }

      await nextBtn.click();
      await page.waitForTimeout(1800);
    }

    await abandon(page);
    throw new Error(`Exceeded ${MAX_STEPS} steps — flow did not reach Submit`);
  } catch (err) {
    if (err instanceof ChallengeDetected) throw err;
    await abandon(page).catch(() => {});
    throw err;
  }
}

export { abandon as abandonEasyApply };
