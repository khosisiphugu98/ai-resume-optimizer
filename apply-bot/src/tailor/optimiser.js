import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT } from '../config.js';
import { getContext, attachScreencast, stopRequested, humanDelay } from '../browser.js';
import { db, updateJob } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { extractPdfText, validateResumePdf } from '../../scripts/extract-text.mjs';
import { loadProfile } from '../profile.js';

export const SEED_RESUME = path.join(ROOT, 'seed/Khosi_Siphugu_Resume (Marketing Analyst) (1).pdf');

const SEL = {
  upload: '#resume-upload',
  uploadBtn: '#upload-resume-btn',
  saveDefault: '#save-default-btn',
  uploadStatus: '#upload-status',
  jd: '#job-description',
  optimise: '#optimize-btn',
  diffPanel: '#diff-view-panel',
  acceptAll: '#diff-accept-all',
  matchScore: '#match-score-value',
  message: '#message',
};

async function pdfPageCount(file) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
  return pdf.numPages;
}

/** Filenames a recruiter sorts by. Never ship "resume(11).pdf". */
export function outputName(job, profile) {
  const slug = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  const who = `${profile.identity.firstName}_${profile.identity.lastName}`;
  return `${who}_CV_${slug(job.company)}_${slug(job.title)}.pdf`;
}

async function optimiserError(page) {
  const el = await page.$(`${SEL.message}.error`);
  if (!el) return null;
  if (!await el.isVisible()) return null;
  return (await el.textContent())?.trim() || 'unknown optimiser error';
}

/** True when the saved default resume decrypted and rendered on load. */
async function defaultLoaded(page) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    return !!el && /saved default resume/i.test(el.textContent || '');
  }, SEL.uploadStatus);
}

/**
 * Upload the base resume once and persist it. resume.js encrypts it into
 * localStorage keyed against a non-extractable IndexedDB key, both of which live
 * in the persistent Chrome profile — so every later run skips upload and
 * AI-parsing entirely.
 *
 * Note it expires after 30 days (resume.js loadDefaultOnStartup), so this is
 * called automatically whenever the default is missing, not just on first run.
 */
export async function seedDefaultResume(page, { force = false } = {}) {
  if (!fs.existsSync(SEED_RESUME)) {
    throw new Error(`Seed resume not found at ${SEED_RESUME}`);
  }

  await page.goto(PATHS.optimiser, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  if (!force && await defaultLoaded(page)) {
    emit({ stage: 'tailor', message: 'Saved default resume already loaded — no re-seed needed' });
    return { seeded: false };
  }

  emit({ stage: 'tailor', message: 'Seeding base resume into the optimiser (one-time, ~30s)' });

  // saveCurrentAsDefault() puts up a native confirm() about storing PII.
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.setInputFiles(SEL.upload, SEED_RESUME);
  await page.click(SEL.uploadBtn);

  // Parsing runs pdf.js then an AI structuring call — allow real time.
  await page.waitForFunction(
    sel => {
      const t = document.querySelector(sel)?.textContent || '';
      return /✓|complete|loaded|imported/i.test(t) && !/reading|extracting|parsing|vision/i.test(t);
    },
    SEL.uploadStatus,
    { timeout: 180_000 },
  ).catch(() => {});

  const err = await optimiserError(page);
  if (err) throw new Error(`Optimiser rejected the upload: ${err}`);

  await page.click(SEL.saveDefault);
  await page.waitForTimeout(1500);

  // Prove it round-trips through encryption rather than trusting the click.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  if (!await defaultLoaded(page)) {
    throw new Error('Saved default did not survive a reload — check the IndexedDB encryption key in this profile');
  }

  emit({ stage: 'tailor', message: 'Base resume seeded and verified across a reload' });
  return { seeded: true };
}

/**
 * Tailor for one job and export a PDF.
 *
 * Uses page.pdf() rather than the site's own download button: that button
 * rasterises via html2canvas, producing a PDF with no text layer that ATS
 * parsers read as empty (measured: 2 characters vs ~7,000). Same DOM, same CSS,
 * real text.
 */
export async function tailorForJob(page, job, profile) {
  await page.goto(PATHS.optimiser, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  if (!await defaultLoaded(page)) {
    await seedDefaultResume(page, { force: true });
    await page.goto(PATHS.optimiser, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  }

  await page.fill(SEL.jd, job.jd_text || '');
  await page.click(SEL.optimise);

  // The optimiser fires parallel per-section AI calls; 3 minutes is generous but
  // a stall here otherwise wedges the whole pipeline.
  const appeared = await page.waitForSelector(SEL.diffPanel, { state: 'visible', timeout: 180_000 })
    .then(() => true).catch(() => false);

  if (!appeared) {
    const err = await optimiserError(page);
    throw new Error(err ? `Optimisation failed: ${err}` : 'Optimisation timed out with no diff panel');
  }

  await page.click(SEL.acceptAll);
  await page.waitForSelector(SEL.diffPanel, { state: 'hidden', timeout: 60_000 }).catch(() => {});

  const matchScore = await page.textContent(SEL.matchScore).catch(() => null);

  // Highlights are a review aid, never something to send to an employer.
  //
  // hideHighlights() alone is not enough: finaliseDiffs() re-applies highlights
  // after "Accept All" and then awaits an async keyword-integration call, so a
  // click-then-hide sequence races it. The deployed print CSS now neutralises
  // .highlight-skill unconditionally; this injects the same rule so the bot is
  // correct regardless of which build is live.
  await page.addStyleTag({ content: `
    @media print {
      .highlight-skill {
        background-color: transparent !important;
        padding: 0 !important;
        border-radius: 0 !important;
        font-weight: inherit !important;
      }
    }` });
  await page.evaluate(() => { try { hideHighlights(); } catch {} });
  await page.waitForTimeout(600);

  const outDir = path.join(PATHS.artifacts, 'resumes');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, outputName(job, profile));

  // Size the page to the resume instead of forcing A4.
  //
  // The design is a two-column layout with a full-height dark sidebar, and
  // resume.js's own PDF export already uses a custom single-page format for this
  // reason. Printing to A4 splits it mid-section and leaves the sidebar behind on
  // page 2, producing a near-empty second sheet. One tall page keeps the visual
  // output identical to what the optimiser produces today — the only difference
  // from the html2canvas export is that the text stays real text.
  const box = await page.evaluate(() => {
    const el = document.getElementById('resume-content');
    const rect = el.getBoundingClientRect();
    // measureActualContentHeight() accounts for overflowing children; it is what
    // resume.js uses for the same job.
    let h;
    try { h = measureActualContentHeight(el); } catch { h = 0; }
    return { w: Math.ceil(rect.width), h: Math.ceil(Math.max(h, el.scrollHeight, rect.height)) };
  });

  if (!box.w || !box.h || box.h > 20000) {
    throw new Error(`Implausible resume dimensions ${box.w}x${box.h} — refusing to export`);
  }

  await page.pdf({
    path: outPath,
    width: `${box.w}px`,
    height: `${box.h}px`,
    printBackground: true,
    pageRanges: '1',
  });

  // Never let an unreadable or mis-paginated PDF reach an ATS.
  const pageCount = await pdfPageCount(outPath);
  if (pageCount !== 1) {
    fs.rmSync(outPath, { force: true });
    throw new Error(`Export produced ${pageCount} pages; this layout must be a single page`);
  }

  const text = await extractPdfText(outPath);
  const check = validateResumePdf(text, {
    name: `${profile.identity.firstName} ${profile.identity.lastName}`,
    email: profile.identity.email,
    skills: Object.keys(profile.skills || {}).filter(k => !k.startsWith('_')),
  });

  if (!check.ok) {
    fs.rmSync(outPath, { force: true });
    throw new Error(
      `Generated PDF failed the text-layer check (${check.chars} chars, name=${check.hasName}, ` +
      `email=${check.hasEmail}, skills=${check.skillsFound.length}) — not uploading it anywhere`
    );
  }

  return {
    path: outPath,
    matchScore: matchScore ? parseInt(matchScore, 10) : null,
    chars: check.chars,
    skillsFound: check.skillsFound.length,
  };
}

export async function runTailoring({ limit = 10 } = {}) {
  const profile = loadProfile();
  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await attachScreencast(page);

  await seedDefaultResume(page);

  const jobs = db.prepare(
    `SELECT * FROM jobs WHERE status = 'scored' ORDER BY fit_score DESC, id LIMIT ?`
  ).all(limit);

  let done = 0, failed = 0;

  for (const job of jobs) {
    if (stopRequested()) { emit({ stage: 'tailor', level: 'warn', message: 'STOP file present — halting' }); break; }

    try {
      emit({ jobId: job.id, stage: 'tailor', message: `Tailoring for ${job.title} @ ${job.company}` });
      const r = await tailorForJob(page, job, profile);
      updateJob(job.id, { status: 'tailored', resume_path: r.path });
      done++;
      emit({
        jobId: job.id, stage: 'tailor',
        message: `Tailored → ${path.basename(r.path)} (${r.chars} chars of text${r.matchScore ? `, match ${r.matchScore}` : ''})`,
      });
    } catch (err) {
      updateJob(job.id, { status: 'tailor_failed', reject_reason: err.message.slice(0, 200) });
      failed++;
      emit({ jobId: job.id, stage: 'tailor', level: 'error', message: `Tailoring failed: ${err.message}` });
    }

    emitBoard();
    await humanDelay(2000, 6000);
  }

  emit({ stage: 'tailor', message: `Tailoring complete — ${done} tailored, ${failed} failed` });
  return { done, failed };
}
