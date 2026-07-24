import {
  SELECTORS, LINKEDIN, CAPS, ZA_LOCATIONS, OPEN_REMOTE,
  DATE_POSTED_WINDOWS, DEFAULT_DATE_POSTED,
} from '../config.js';
import { titleRejectRe, authBlockerMatch } from '../reject-criteria.js';
import {
  getContext, attachScreencast, assertNoChallenge, stopRequested,
  humanDelay, textOf, ChallengeDetected,
} from '../browser.js';
import { upsertJob, updateJob, bumpRate, todayRates, db, activeSearches, isCompanyBlocked, getSetting } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { looksLikeEmailApplication } from '../email/extract.js';
import { fetchGuestPosting, seniorityReject } from './jd-fetch.js';

/** The date-posted window in force, resolved from the setting with a safe fallback. */
export function activeDatePostedWindow() {
  const key = getSetting('date_posted', DEFAULT_DATE_POSTED);
  return DATE_POSTED_WINDOWS.find(w => w.key === key)
    || DATE_POSTED_WINDOWS.find(w => w.key === DEFAULT_DATE_POSTED);
}

export function buildSearchUrl({ keywords, location, remote, easyApplyOnly }) {
  const p = new URLSearchParams({
    keywords,
    location,
    sortBy: 'DD',
    f_E: '2,3,4',      // entry / associate / mid-senior — matches the band in §2.2
  });
  // How far back to look — operator-set from the gear, defaulting to the past
  // month so the pool is deep rather than same-day thin. "Any time" omits f_TPR.
  const win = activeDatePostedWindow();
  if (win?.seconds) p.set('f_TPR', `r${win.seconds}`);
  if (remote) p.set('f_WT', '2');
  if (easyApplyOnly) p.set('f_AL', 'true');
  return `${LINKEDIN.searchBase}?${p}`;
}

/** Cheap pre-filter — runs before any LLM spend. Returns a reject reason or null. */
export function preFilter({ title, location, jd }) {
  if (title && titleRejectRe().test(title)) return 'seniority: above band';

  const hay = `${location || ''} ${jd || ''}`;
  const inZA = ZA_LOCATIONS.test(location || '') || ZA_LOCATIONS.test(jd || '');
  if (!inZA) {
    // The single highest-leverage filter (§2.3): a US-only remote role is not a
    // near-miss, it is impossible, and it would otherwise eat most of the budget.
    if (authBlockerMatch(hay) && !OPEN_REMOTE.test(hay)) return 'work authorisation: not open to South Africa';
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

export async function runDiscovery({ searches = activeSearches(), maxPerSearch = 25 } = {}) {
  if (!searches.length) {
    emit({ stage: 'discover', level: 'warn', message: 'No search terms enabled — add one in the Search terms panel' });
    return { found: 0, kept: 0, rejected: 0 };
  }

  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await attachScreencast(page);

  emit({ stage: 'discover', message: `Looking at postings from the ${activeDatePostedWindow().label.toLowerCase()}` });

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
        // Only an explicit veto turns a job away at discovery. Seniority and
        // work-authorisation are deferred to enrich (recordEnrichment), where the
        // real title, location and full JD are known — a search card carries a
        // title and often nothing else, which is too thin to reject on. A blocked
        // company is the one exception: it is your decision, not a heuristic.
        const reason = isCompanyBlocked(card.company) ? `blocked company: ${card.company}` : null;
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
    message: `Discovery complete — ${found} cards seen, ${kept} new kept, ${rejected} from blocked companies` +
      ` (seniority and work-authorisation are judged at enrich now, with the full JD)`,
  });
  emitBoard();
  return { found, kept, rejected };
}

/**
 * Decide the apply route and, for email postings, the address. Kept separate
 * from fetching so it can be tested against fixture text with no network.
 */
export function classifyApply({ jd, applyRoute }) {
  const emailMatch = jd?.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);

  // An email instruction in the body beats whatever button LinkedIn renders:
  // plenty of postings show "Apply on company website" and then spend a
  // paragraph telling you to send your CV to a named address.
  if (looksLikeEmailApplication(jd) && emailMatch) {
    return { applyType: 'email', applyEmail: emailMatch[0] };
  }
  return { applyType: applyRoute || 'unknown', applyEmail: null };
}

/**
 * Fetch full JD text and resolve the apply route for jobs that passed the
 * pre-filter.
 *
 * Runs over HTTP against LinkedIn's public guest endpoint — no browser, no
 * session, nothing to contend over. The signed-in page is kept only as a
 * fallback for the rare posting the guest view will not serve, and even that is
 * skipped when the profile is busy rather than failing the stage.
 */
export async function runEnrich({ limit = 20, allowBrowserFallback = true } = {}) {
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status = 'discovered' ORDER BY id LIMIT ?`).all(limit);
  let enriched = 0, rejected = 0, failed = 0, gone = 0;
  const needBrowser = [];

  if (!jobs.length) {
    emit({ stage: 'enrich', message: 'Nothing to enrich — no jobs in "discovered"' });
    return { enriched, rejected, failed, gone };
  }

  emit({ stage: 'enrich', message: `Enriching ${jobs.length} job(s) over HTTP` });

  for (const job of jobs) {
    if (stopRequested()) { emit({ stage: 'enrich', level: 'warn', message: 'STOP file present — halting enrich' }); break; }

    try {
      const post = await fetchGuestPosting(job.external_id);

      if (!post) {
        updateJob(job.id, { status: 'expired', reject_reason: 'posting removed from LinkedIn' });
        gone++;
        continue;
      }
      bumpRate('guest_fetches');

      if (!post.jd) { needBrowser.push({ job, post }); continue; }

      const outcome = recordEnrichment(job, post);
      if (outcome === 'rejected') rejected++; else enriched++;
    } catch (err) {
      needBrowser.push({ job, post: null, error: err.message });
    }

    // Polite, not paranoid — this endpoint is public and unauthenticated, so the
    // pacing is about not hammering a host, not about account risk.
    await new Promise(r => setTimeout(r, 400 + Math.random() * 700));
    if ((enriched + rejected) % 10 === 0) emitBoard();
  }

  emitBoard();

  if (needBrowser.length && allowBrowserFallback && !stopRequested()) {
    const r = await enrichViaBrowser(needBrowser);
    enriched += r.enriched; rejected += r.rejected; failed += r.failed;
  } else if (needBrowser.length) {
    failed += needBrowser.length;
    for (const { job } of needBrowser) updateJob(job.id, { status: 'error' });
  }

  emit({
    stage: 'enrich',
    level: failed && !enriched ? 'error' : 'info',
    message: `Enrich complete — ${enriched} enriched, ${rejected} rejected, ${gone} expired, ${failed} failed`,
  });
  emitBoard();
  return { enriched, rejected, failed, gone };
}

/** Apply one fetched posting to the row. Returns 'enriched' or 'rejected'. */
function recordEnrichment(job, post) {
  const title = post.title || job.title;
  const company = post.company || job.company;
  const location = post.location || job.location;
  const { applyType, applyEmail } = classifyApply(post);

  if (post.closed) {
    updateJob(job.id, { title, company, location, status: 'expired', reject_reason: 'no longer accepting applications' });
    return 'rejected';
  }

  // Re-run the filter now that the real title, location and JD are known. At
  // discovery most cards yielded an id and nothing else, so neither the
  // seniority gate nor the work-authorisation gate could fire.
  // The company name is only trustworthy once the posting itself has been read —
  // card subtitles are frequently the recruiter, not the employer — so the
  // blocklist is applied here as well as at discovery.
  const reason = preFilter({ title, location, jd: post.jd })
    || seniorityReject(post.criteria)
    || (isCompanyBlocked(company) ? `blocked company: ${company}` : null);

  const common = {
    title, company, location,
    jd_text: post.jd,
    apply_type: applyType,
    apply_email: applyEmail,
    external_apply_url: post.applyUrl || null,
    posted_at: post.postedAt || job.posted_at,
  };

  if (reason) {
    updateJob(job.id, { ...common, status: 'rejected', reject_reason: reason });
    emit({ jobId: job.id, stage: 'enrich', message: `Rejected — ${reason}: ${title} @ ${company}` });
    return 'rejected';
  }

  updateJob(job.id, { ...common, status: 'enriched' });
  emit({
    jobId: job.id, stage: 'enrich',
    message: `Enriched (${applyType}, ${post.jd.length} chars): ${title} @ ${company}`,
  });
  return 'enriched';
}

/**
 * Last resort for postings the guest endpoint would not serve. Costs a real
 * pageview each, so it is capped and only reached for the handful that failed.
 */
async function enrichViaBrowser(pending) {
  let enriched = 0, rejected = 0, failed = 0;

  emit({
    stage: 'enrich', level: 'warn',
    message: `${pending.length} posting(s) had no public description — retrying those in the browser`,
  });

  let page;
  try {
    const ctx = await getContext();
    page = ctx.pages()[0] || await ctx.newPage();
    await attachScreencast(page);
  } catch (err) {
    // The browser being unavailable must not fail the stage — everything the
    // guest endpoint served is already saved.
    emit({
      stage: 'enrich', level: 'warn',
      message: `Browser fallback unavailable (${err.message.split('\n')[0]}) — leaving ${pending.length} job(s) for the next run`,
    });
    return { enriched, rejected, failed: pending.length };
  }

  for (const { job } of pending) {
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

      const seen = await page.evaluate(({ sels, jobId }) => {
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

      if (!seen.jd) {
        updateJob(job.id, { status: 'error' });
        failed++;
        emit({
          jobId: job.id, stage: 'enrich', level: 'warn',
          message: `No description found for ${job.external_id} — check SELECTORS.detailDescription`,
        });
        continue;
      }

      // document.title is "<Title> | <Company> | LinkedIn" and is always
      // present, so title and company are backfilled from it.
      const meta = parseDocTitle(seen.docTitle);
      const label = seen.applyLabel || '';
      const outcome = recordEnrichment(job, {
        title: job.title || meta.title,
        company: job.company || meta.company,
        location: job.location,
        jd: seen.jd,
        criteria: {},
        applyRoute: /easy apply/i.test(label) ? 'easy_apply' : (/apply/i.test(label) ? 'external' : 'unknown'),
        applyUrl: null,
        postedAt: null,
        closed: false,
      });
      if (outcome === 'rejected') rejected++; else enriched++;
    } catch (err) {
      if (err instanceof ChallengeDetected) {
        bumpRate('challenges_hit');
        emit({ jobId: job.id, stage: 'enrich', level: 'critical', message: `${err.message} — ALL RUNS HALTED.` });
        throw err;
      }
      updateJob(job.id, { status: 'error' });
      failed++;
      emit({ jobId: job.id, stage: 'enrich', level: 'error', message: `Enrich failed: ${err.message}` });
    }

    emitBoard();
    await humanDelay(3000, 9000);
  }

  return { enriched, rejected, failed };
}
