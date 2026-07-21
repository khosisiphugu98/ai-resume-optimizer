import {
  SEARCHES, SELECTORS, LINKEDIN, CAPS, REJECT_TITLE,
  AUTH_BLOCKERS, ZA_LOCATIONS, OPEN_REMOTE,
} from '../config.js';
import {
  getContext, attachScreencast, assertNoChallenge, stopRequested,
  humanDelay, textOf, ChallengeDetected,
} from '../browser.js';
import { upsertJob, updateJob, bumpRate, todayRates, db } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { looksLikeEmailApplication } from '../email/extract.js';

function buildSearchUrl({ keywords, location, remote, easyApplyOnly }) {
  const p = new URLSearchParams({
    keywords,
    location,
    f_TPR: 'r86400',   // last 24h — keeps volume sane and freshness high
    sortBy: 'DD',
    f_E: '2,3,4',      // entry / associate / mid-senior — matches the band in §2.2
  });
  if (remote) p.set('f_WT', '2');
  if (easyApplyOnly) p.set('f_AL', 'true');
  return `${LINKEDIN.searchBase}?${p}`;
}

/** Cheap pre-filter — runs before any LLM spend. Returns a reject reason or null. */
export function preFilter({ title, location, jd }) {
  if (title && REJECT_TITLE.test(title)) return 'seniority: above band';

  const hay = `${location || ''} ${jd || ''}`;
  const inZA = ZA_LOCATIONS.test(location || '') || ZA_LOCATIONS.test(jd || '');
  if (!inZA) {
    const blocker = AUTH_BLOCKERS.find(re => re.test(hay));
    // The single highest-leverage filter (§2.3): a US-only remote role is not a
    // near-miss, it is impossible, and it would otherwise eat most of the budget.
    if (blocker && !OPEN_REMOTE.test(hay)) return 'work authorisation: not open to South Africa';
  }
  return null;
}

/**
 * "<Job Title> | <Company> | LinkedIn" — but titles themselves often contain
 * pipes ("Visual Content Analyst | $70/hr Remote"), so take the company from the
 * end and treat everything before it as the title.
 */
export function parseDocTitle(docTitle) {
  const parts = String(docTitle || '').split(' | ').map(s => s.trim()).filter(Boolean);
  if (parts.length && /^linkedin$/i.test(parts.at(-1))) parts.pop();
  if (parts.length < 2) return { title: parts[0] || null, company: null };
  const company = parts.pop();
  return { title: parts.join(' | ') || null, company };
}

async function collectCards(page) {
  return page.evaluate(({ cardSels, idAttrs, titleSels, companySels, locSels }) => {
    const pick = (root, sels) => {
      for (const s of sels) { const el = root.querySelector(s); if (el) return el.innerText.trim().split('\n')[0]; }
      return null;
    };
    const cards = [];
    const seen = new Set();
    for (const sel of cardSels) {
      for (const el of document.querySelectorAll(sel)) {
        let id = null;
        for (const a of idAttrs) { if (el.getAttribute(a)) { id = el.getAttribute(a); break; } }
        if (!id) {
          const link = el.querySelector('a[href*="/jobs/view/"]');
          const m = link?.getAttribute('href')?.match(/\/jobs\/view\/(\d+)/);
          if (m) id = m[1];
        }
        if (!id || seen.has(id)) continue;
        seen.add(id);
        cards.push({
          external_id: id,
          url: `https://www.linkedin.com/jobs/view/${id}/`,
          title: pick(el, titleSels),
          company: pick(el, companySels),
          location: pick(el, locSels),
        });
      }
      if (cards.length) break;
    }
    return cards;
  }, {
    cardSels: SELECTORS.jobCard,
    idAttrs: SELECTORS.jobCardId,
    titleSels: SELECTORS.jobCardTitle,
    companySels: SELECTORS.jobCardCompany,
    locSels: SELECTORS.jobCardLocation,
  });
}

/** Scroll the results pane the way a human does — LinkedIn lazy-loads on scroll. */
async function scrollResults(page, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(sels => {
      const pane = sels.map(s => document.querySelector(s)).find(Boolean);
      (pane || document.scrollingElement).scrollBy(0, 900);
    }, SELECTORS.resultsList);
    await page.waitForTimeout(600 + Math.random() * 900);
  }
}

export async function runDiscovery({ searches = SEARCHES, maxPerSearch = 25 } = {}) {
  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await attachScreencast(page);

  let found = 0, kept = 0, rejected = 0, selectorMisses = 0;

  try {
    for (const search of searches) {
      if (stopRequested()) { emit({ stage: 'discover', level: 'warn', message: 'STOP file present — halting discovery' }); break; }
      if (todayRates().linkedin_pageviews >= CAPS.linkedin_pageviews) {
        emit({ stage: 'discover', level: 'warn', message: `LinkedIn pageview cap (${CAPS.linkedin_pageviews}) reached — stopping for today` });
        break;
      }

      const url = buildSearchUrl(search);
      emit({ stage: 'discover', message: `Searching "${search.keywords}" · ${search.location} (tier ${search.tier})` });

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      bumpRate('linkedin_pageviews');
      await page.waitForTimeout(2500);
      await assertNoChallenge(page);

      await scrollResults(page);
      const cards = await collectCards(page);
      found += cards.length;

      if (!cards.length) {
        selectorMisses++;
        emit({
          stage: 'discover', level: 'warn',
          message: `Zero cards for "${search.keywords}" — either genuinely no results, or LinkedIn changed its DOM. Check SELECTORS.jobCard in config.js.`,
        });
      }

      for (const card of cards.slice(0, maxPerSearch)) {
        const reason = preFilter({ title: card.title, location: card.location });
        const id = upsertJob({ ...card, tier: search.tier, search_keywords: search.keywords });
        if (!id) continue;                       // already known — dedupe on (source, external_id)

        if (reason) {
          updateJob(id, { status: 'rejected', reject_reason: reason });
          rejected++;
        } else {
          updateJob(id, { status: 'discovered' });
          kept++;
        }
      }

      emitBoard();
      await humanDelay(4000, 11000);
    }
  } catch (err) {
    if (err instanceof ChallengeDetected) {
      bumpRate('challenges_hit');
      emit({ stage: 'discover', level: 'critical', message: `${err.message} — ALL RUNS HALTED. Clear it manually in the browser, then restart.` });
    } else {
      emit({ stage: 'discover', level: 'error', message: `Discovery failed: ${err.message}` });
    }
    throw err;
  }

  emit({
    stage: 'discover',
    level: selectorMisses === searches.length ? 'error' : 'info',
    message: `Discovery complete — ${found} cards seen, ${kept} new kept, ${rejected} pre-filtered out`,
  });
  emitBoard();
  return { found, kept, rejected };
}

/**
 * Fetch full JD text and resolve the apply route for jobs that passed the
 * pre-filter. Split from discovery because it costs a pageview per job.
 */
export async function runEnrich({ limit = 20 } = {}) {
  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await attachScreencast(page);

  const jobs = db.prepare(`SELECT * FROM jobs WHERE status = 'discovered' ORDER BY id LIMIT ?`).all(limit);
  let enriched = 0, rejected = 0;

  for (const job of jobs) {
    if (stopRequested()) break;
    if (todayRates().linkedin_pageviews >= CAPS.linkedin_pageviews) {
      emit({ stage: 'enrich', level: 'warn', message: 'LinkedIn pageview cap reached — stopping' });
      break;
    }

    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded' });
      bumpRate('linkedin_pageviews');
      await page.waitForTimeout(2200);
      await assertNoChallenge(page);

      const page1 = await page.evaluate(({ sels, jobId }) => {
        // The per-job id is the most reliable anchor in the new UI.
        const byId = document.getElementById(`JobDetails_AboutTheJob_${jobId}`);
        let desc = byId;
        if (!desc) for (const s of sels) { const el = document.querySelector(s); if (el) { desc = el; break; } }

        // The apply button's accessible name distinguishes the routes cleanly:
        // "Easy Apply to this job" vs "Apply on company website".
        const applyEl = document.querySelector('[aria-label*="pply" i]');

        return {
          jd: desc ? desc.innerText.replace(/^\s*About the job\s*/i, '').trim() : null,
          applyLabel: applyEl?.getAttribute('aria-label') || applyEl?.innerText?.trim() || null,
          docTitle: document.title || '',
        };
      }, { sels: SELECTORS.detailDescription, jobId: job.external_id });

      const jdText = page1.jd;

      // Job cards are lazily hydrated — LinkedIn strips the text of off-screen
      // ones (they are literally data-occludable), so most cards yield an id and
      // nothing else. document.title is "<Title> | <Company> | LinkedIn" and is
      // always present, so title and company are backfilled here instead.
      const meta = parseDocTitle(page1.docTitle);
      const title = job.title || meta.title;
      const company = job.company || meta.company;

      const emailMatch = jdText?.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
      const wantsEmail = looksLikeEmailApplication(jdText);
      const label = page1.applyLabel || '';

      let applyType = 'unknown';
      if (wantsEmail && emailMatch) applyType = 'email';
      else if (/easy apply/i.test(label)) applyType = 'easy_apply';
      else if (/apply/i.test(label)) applyType = 'external';

      if (!jdText) {
        updateJob(job.id, { title, company, status: 'error' });
        emit({
          jobId: job.id, stage: 'enrich', level: 'warn',
          message: `No description found for "${title || job.external_id}" — check SELECTORS.detailDescription`,
        });
        continue;
      }

      // Re-run the filter now that the real title is known. At discovery most
      // titles were null, so the seniority gate could not fire.
      const reason = preFilter({ title, location: job.location, jd: jdText });
      if (reason) {
        updateJob(job.id, { title, company, jd_text: jdText, apply_type: applyType, status: 'rejected', reject_reason: reason });
        rejected++;
        emit({ jobId: job.id, stage: 'enrich', message: `Rejected — ${reason}: ${title} @ ${company}` });
      } else {
        updateJob(job.id, {
          title, company,
          jd_text: jdText,
          apply_type: applyType,
          apply_email: applyType === 'email' ? emailMatch[0] : null,
          status: 'enriched',
        });
        enriched++;
        emit({ jobId: job.id, stage: 'enrich', message: `Enriched (${applyType}, ${jdText.length} chars): ${title} @ ${company}` });
      }
    } catch (err) {
      if (err instanceof ChallengeDetected) {
        bumpRate('challenges_hit');
        emit({ jobId: job.id, stage: 'enrich', level: 'critical', message: `${err.message} — ALL RUNS HALTED.` });
        throw err;
      }
      updateJob(job.id, { status: 'error' });
      emit({ jobId: job.id, stage: 'enrich', level: 'error', message: `Enrich failed: ${err.message}` });
    }

    emitBoard();
    await humanDelay(3000, 9000);
  }

  emit({ stage: 'enrich', message: `Enrich complete — ${enriched} enriched, ${rejected} rejected` });
  return { enriched, rejected };
}
