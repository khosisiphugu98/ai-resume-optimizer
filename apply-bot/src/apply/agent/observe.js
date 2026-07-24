// Build a compact, model-ready description of a page the deterministic flow
// could not solve. Reuses Phase 1's snapshot (a11y tree + DOM fields + frames +
// outline) and adds the two structural traps the design doc calls out — a
// landing page whose form is behind an "Apply" button, and a form behind a tab.
//
// Deliberately compact: controls, visible button labels, frame list and a tag
// histogram — never the full HTML. The planner reasons over structure, and a
// smaller payload is cheaper and less noisy.
import { buildSnapshot, fingerprintOf } from './capture.js';

// Buttons that reveal a form rather than submit one — the landing-page tell.
const REVEAL_RE = /\b(apply|start|begin|get started|continue to application|apply now)\b/i;
// Tabs/steps that can hide the fields on a later panel.
const TAB_RE = /\b(tab|step \d|application|details|questions|resume|cv)\b/i;

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Visible button/anchor labels across every frame — what the planner can click. */
async function collectButtons(page) {
  const labels = [];
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="submit"], a'))
        .map(el => (el.getAttribute('aria-label') || el.value || el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(t => t && t.length <= 60)
        .slice(0, 40),
    ).catch(() => []);
    labels.push(...found);
  }
  // Dedupe, keep order — the first occurrence is usually the most prominent.
  return [...new Set(labels)];
}

/**
 * @returns {Promise<{host, url, title, frames, controls, outline, buttons, traps, fingerprint}>}
 */
export async function observePage(page) {
  const url = page.url();
  const host = safeHost(url);
  const title = await page.title().catch(() => '');
  const snapshot = await buildSnapshot(page);
  const buttons = await collectButtons(page);
  const fingerprint = fingerprintOf(host, snapshot.controls);

  const fillable = snapshot.controls.length;
  const traps = {
    // Few/no fillable controls but a prominent reveal button: the form is almost
    // certainly behind that button.
    landingPage: fillable < 2 && buttons.some(b => REVEAL_RE.test(b)),
    // Tab/step labels present alongside a thin control set: fields may be on a
    // panel that is not the active one.
    formBehindTab: fillable < 2 && buttons.some(b => TAB_RE.test(b)),
  };

  return { host, url, title, ...snapshot, buttons, traps, fingerprint };
}
