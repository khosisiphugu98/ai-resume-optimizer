import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT } from '../config.js';
import { getContext, attachScreencast, stopRequested, humanDelay } from '../browser.js';
import { db, updateJob } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { extractPdfText, validateResumePdf, CORE_RESUME_SKILLS } from '../../scripts/extract-text.mjs';
import { loadProfile, confirmedSkillNames, confirmSkill } from '../profile.js';
import { recordSkillSuggestions } from '../db.js';
import { gateSkills } from '../evidence/skills.js';
import { corpus } from '../evidence/store.js';

export const SEED_RESUME = path.join(ROOT, 'seed/Khosi_Siphugu_Resume (Marketing Analyst) (1).pdf');

/**
 * Minimum characters of extracted text a real one-page résumé carries. The real
 * exports measure 8100–9100; anything under a third of that is a broken render,
 * not a CV. `validateResumePdf` has always computed `chars` and never asserted it.
 */
const MIN_RESUME_CHARS = 3000;

/**
 * Height-to-width ratio above which the export is not one page.
 *
 * `page.pdf()` is called with `height: ${box.h}px`, so a runaway document is
 * emitted as one enormous page and `pdfPageCount() === 1` can never catch it.
 * Measured across 40 real exports: all 675px wide, ratio 1.22–1.33 (A4 is 1.41).
 * 1.8 sits well clear of the observed maximum while still catching a doubled
 * document, which lands near 2.6.
 */
const MAX_PAGE_RATIO = 1.8;

/**
 * Ceiling on skills the evidence gate may confirm by itself for one job.
 *
 * The gate confirms into the same allowlist that decides what the optimiser is
 * permitted to write into the CV, so an unbounded gate slowly grants itself
 * permission to claim anything. A cap keeps the growth visible and operator-paced.
 */
const MAX_AUTO_CONFIRMS_PER_JOB = 5;

/**
 * The rendered résumé's text, normalised, straight from the page.
 *
 * Deliberately NOT the seed PDF's text layer: the optimiser re-renders the seed
 * into its own template, so an untailored export never matches the seed file
 * byte-for-byte — it matches the other untailored exports. Reading `#resume-content`
 * (the element the PDF is printed from) before and after optimisation compares the
 * document against itself, which is the comparison that actually holds.
 */
export function normaliseResumeText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** Shortest rendered résumé we will accept as "the document has loaded". */
const MIN_BASELINE_CHARS = 500;

async function resumeTextInPage(page) {
  const raw = await page.evaluate(() => {
    const el = document.getElementById('resume-content');
    return el ? el.innerText || el.textContent || '' : '';
  });
  return normaliseResumeText(raw);
}

/**
 * The baseline the export is compared against, read only once the résumé has
 * actually rendered.
 *
 * Taking this too early is the one way the whole guard fails open: an empty
 * baseline can never equal the finished document, so an untailored export would
 * sail through the very check written to stop it. Waiting for real content, and
 * refusing to proceed without it, keeps the comparison honest.
 */
async function resumeBaseline(page) {
  await page.waitForFunction(min => {
    const el = document.getElementById('resume-content');
    return !!el && (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().length >= min;
  }, MIN_BASELINE_CHARS, { timeout: 30_000 }).catch(() => {});

  const text = await resumeTextInPage(page);
  if (text.length < MIN_BASELINE_CHARS) {
    throw new Error(
      `The résumé had not rendered before optimisation (${text.length} chars) — ` +
      `without a baseline the untailored-export check cannot run, so this is not safe to tailor`
    );
  }
  return text;
}

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

/**
 * Filenames a recruiter sorts by. Never ship "resume(11).pdf".
 *
 * The job id is on the end because company and title are both truncated to 40
 * characters, and long postings at the same employer collide after truncation:
 * 190 tailored rows mapped to 159 distinct paths, so 31 jobs were carrying a
 * CV written for a different posting. The id makes the path unique per job
 * while staying stable when the same job is re-tailored.
 */
export function outputName(job, profile) {
  const slug = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  const who = `${profile.identity.firstName}_${profile.identity.lastName}`;
  return `${who}_CV_${slug(job.company)}_${slug(job.title)}_${job.id}.pdf`;
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

  // The document as it stands before this job's optimisation — the baseline the
  // export is checked against below. Read from the same element the PDF is printed
  // from, so both sides of the comparison measure the same thing.
  const beforeText = await resumeBaseline(page);

  await page.fill(SEL.jd, job.jd_text || '');
  await page.evaluate(() => { window.__optimizeDone = null; });
  await page.click(SEL.optimise);

  // Wait on the optimiser's own completion signal, not the diff panel. The skill
  // confirmation gate now runs first and, in bot mode, confirms only the skills the
  // master profile vouches for — so a run with nothing to add legitimately produces
  // NO diff panel. Racing the panel would time out on exactly those (safe) runs.
  // The optimiser fires parallel per-section AI calls, so 3 minutes is generous.
  await page.waitForFunction(() => window.__optimizeDone != null, { timeout: 180_000 })
    .catch(() => { throw new Error('Optimisation timed out — no completion signal from the optimiser'); });

  const done = await page.evaluate(() => window.__optimizeDone);
  if (!done.ok) {
    const err = await optimiserError(page);
    throw new Error(`Optimisation failed: ${done.error || err || 'unknown error'}`);
  }

  // Apply the reviewed changes. "Accept All" deliberately excludes diffs the
  // fabrication guard flagged (invented metrics / smuggled unconfirmed skills), so
  // those are simply dropped rather than shipped — the safe direction for an
  // unattended run. Skip the click entirely when there is nothing to apply.
  if (done.diffCount > 0) {
    await page.click(SEL.acceptAll);
    // The panel only auto-collapses when every diff is resolved; flagged ones stay
    // pending by design, so wait on the button's applied state instead of the panel.
    await page.waitForFunction(() => {
      const b = document.getElementById('diff-accept-all');
      return b && !b.disabled && /✓/.test(b.textContent || '');
    }, { timeout: 60_000 }).catch(() => {});
  }

  // The guard that was missing. `diffCount === 0` is a legitimate outcome upstream,
  // and diffs the fabrication guard flagged are excluded from "Accept All" — so a
  // run can complete "successfully" having changed nothing at all, and the export
  // then ships the untailored base CV under a job-specific filename. 19 of 164
  // résumés on disk were duplicates of one another that way, including the only
  // application ever emailed. Comparing the rendered document before and after is
  // the one check that catches every route to that outcome.
  if ((await resumeTextInPage(page)) === beforeText) {
    throw new Error(
      `Optimisation changed nothing for "${job.title}" — the export would be the ` +
      `untailored base CV. Not marking this tailored.`
    );
  }

  const unconfirmedSkills = Array.isArray(done.unconfirmedSkills) ? done.unconfirmedSkills : [];
  const matchScore = done.matchScore != null
    ? String(done.matchScore)
    : await page.textContent(SEL.matchScore).catch(() => null);

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
  // The real one-page check. `pageRanges: '1'` with an explicit pixel height means
  // pdfPageCount() below always returns 1, however long the document actually is.
  if (box.h / box.w > MAX_PAGE_RATIO) {
    throw new Error(
      `Resume is ${(box.h / box.w).toFixed(2)}x as tall as it is wide (${box.w}x${box.h}) — ` +
      `over the ${MAX_PAGE_RATIO} single-page limit, refusing to export`
    );
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
    // A curated set of hard technical skills, not all 188 profile keys — see the
    // comment on CORE_RESUME_SKILLS.
    skills: CORE_RESUME_SKILLS,
  });

  if (check.chars < MIN_RESUME_CHARS) {
    fs.rmSync(outPath, { force: true });
    throw new Error(
      `Generated PDF holds only ${check.chars} characters of text (expected ` +
      `>${MIN_RESUME_CHARS}) — the render is broken, not uploading it anywhere`
    );
  }

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
    unconfirmedSkills,
  };
}

/**
 * The evidence gate, applied without letting it break a tailor run.
 *
 * The gate reads uploaded documents and may call a model. Neither is essential to
 * producing a tailored résumé, so any failure degrades to the old behaviour —
 * queue everything and let the operator decide — rather than losing the run's work.
 *
 * Note that skills confirmed here reach the browser allowlist on the NEXT run:
 * the allowlist is seeded once per session via addInitScript, which is the same
 * timing the dashboard's confirm button has always had.
 */
async function gateSkillsSafely(terms, profile) {
  try {
    return await gateSkills(terms, corpus(), profile);
  } catch (err) {
    emit({ stage: 'tailor', level: 'warn', message: `Skill evidence gate unavailable (${err.message}) — queuing everything for review` });
    return { drop: [], confirm: [], ask: (terms || []).map(skill => ({ skill, why: 'evidence gate unavailable' })) };
  }
}

export async function runTailoring({ limit = 10 } = {}) {
  const profile = loadProfile();
  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await attachScreencast(page);

  // Seed the optimiser's skill-confirmation gate. __AUTO_CONFIRM_SKILLS__ makes the
  // gate resolve non-interactively (no modal to hang on), and it confirms ONLY skills
  // present in this allowlist — the profile's confirmed skills. Anything the job wants
  // that isn't vouched for here is skipped and reported back as a suggestion, never
  // written into the resume. addInitScript re-runs on every navigation, so it is in
  // place before resume.js executes on each page load.
  const allowlist = confirmedSkillNames(profile);
  await page.addInitScript(skills => {
    window.__AUTO_CONFIRM_SKILLS__ = true;
    try { localStorage.setItem('confirmedSkills', JSON.stringify(skills)); } catch {}
  }, allowlist);

  await seedDefaultResume(page);
  emit({ stage: 'tailor', message: `Auto-confirm allowlist seeded — ${allowlist.length} confirmed skill(s)` });

  const jobs = db.prepare(
    // Only routes something can actually apply through. `unknown` jobs were being
    // tailored too — a browser session and a full optimiser pass each — and then
    // dead-ended, because run.js selects easy_apply/external and outbox.js selects
    // email, and nothing selects unknown. Four of them, averaging fit 76, have a
    // finished PDF on disk and no code path that will ever send it.
    `SELECT * FROM jobs WHERE status = 'scored' AND apply_type IN ('easy_apply', 'external', 'email')
     ORDER BY fit_score DESC, id LIMIT ?`
  ).all(limit);   // all channels tailor first — email attaches the same PDF

  let done = 0, failed = 0;

  for (const job of jobs) {
    if (stopRequested()) { emit({ stage: 'tailor', level: 'warn', message: 'STOP file present — halting' }); break; }

    try {
      emit({ jobId: job.id, stage: 'tailor', message: `Tailoring for ${job.title} @ ${job.company}` });
      const r = await tailorForJob(page, job, profile);
      // tailored_at exists as a column and was written by nothing, so every row
      // read NULL and there was no way to tell a CV built this morning from one
      // built three weeks ago against a posting that has since changed.
      updateJob(job.id, { status: 'tailored', resume_path: r.path, tailored_at: new Date().toISOString() });
      done++;

      // Skills this job asked for that the candidate hasn't vouched for. They were
      // NOT added to the resume — they go through the evidence gate, which drops
      // what isn't a skill at all, auto-confirms what the candidate's own CV
      // already evidences, and queues only the genuine open questions.
      //
      // This is the one place the queue is written from, which is why the gate
      // sits here: everything upstream is a job-description keyword extractor.
      const gated = await gateSkillsSafely(r.unconfirmedSkills || [], profile);

      // Auto-confirmation is bounded, and only on skills that carry actual
      // evidence. Unbounded, it ran the confirmed list to 188 entries — every
      // skill in the profile — which turned the allowlist that is supposed to stop
      // the optimiser inventing credentials into a rubber stamp that authorises
      // them. A skill without evidence is a question for the operator, not a fact.
      const confirmable = gated.confirm.filter(c => c.evidence || c.derivation);
      for (const c of confirmable.slice(0, MAX_AUTO_CONFIRMS_PER_JOB)) {
        confirmSkill(c.skill, c.years, { source: 'resume-evidence', evidence: c.evidence, derivation: c.derivation });
      }
      const heldBack = confirmable.length - Math.min(confirmable.length, MAX_AUTO_CONFIRMS_PER_JOB);
      if (heldBack > 0) {
        emit({
          jobId: job.id, stage: 'tailor', level: 'warn',
          message: `${heldBack} evidenced skill(s) not auto-confirmed — ${MAX_AUTO_CONFIRMS_PER_JOB}/job cap reached. Confirm them in the dashboard if they are right.`,
        });
      }
      const suggested = recordSkillSuggestions(
        gated.ask.map(a => a.skill),
        Object.fromEntries(gated.ask.map(a => [a.skill, a.why])),
      );

      if (gated.confirm.length) {
        emit({ jobId: job.id, stage: 'tailor', message: `${gated.confirm.length} skill(s) confirmed from your CV: ${gated.confirm.map(c => c.skill).join(', ')}` });
      }
      if (suggested > 0) {
        emit({ jobId: job.id, stage: 'tailor', message: `${suggested} skill suggestion(s) queued for your review` });
      }
      if (gated.drop.length) {
        emit({ jobId: job.id, stage: 'tailor', level: 'debug', message: `${gated.drop.length} keyword(s) dropped as not-skills` });
      }

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
