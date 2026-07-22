/**
 * Job descriptions without a browser.
 *
 * LinkedIn serves every public posting from a guest endpoint that needs no
 * session, no cookies and no Chrome:
 *
 *   https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>
 *
 * It returns the whole posting — title, company, location, the full description
 * body, and the structured criteria block (seniority level, employment type,
 * function, industries) that the signed-in UI hides behind lazy hydration.
 *
 * This matters for more than speed. Enrichment used to be the stage that opened
 * Chrome on the shared persistent profile, which is a single-owner resource: any
 * leftover browser anywhere on the machine made the whole stage fail before it
 * read a single posting. Fetching over HTTP takes enrichment off that resource
 * entirely, so the highest-volume stage in the pipeline has nothing to contend
 * over and no session to burn.
 */

const GUEST_BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·', deg: '°', eacute: 'é',
};

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * HTML fragment → readable text. LinkedIn descriptions are <ul>/<li>/<br> soup,
 * and the requirements are almost always in the list items, so bullets and line
 * breaks have to survive: "5 years experience" on its own line means something
 * different from the same words run into the paragraph before it.
 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|tr|section|article)>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<\/li>/gi, '');
  s = s.replace(/<\/(ul|ol|table)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const first = (html, ...res) => {
  for (const re of res) {
    const m = html.match(re);
    if (m) {
      const t = htmlToText(m[1]);
      if (t) return t;
    }
  }
  return null;
};

/**
 * The guest page is server-rendered with stable, semantic class names — unlike
 * the signed-in app, whose hashed classes churn every deploy. Each field still
 * gets fallbacks, and a miss returns null rather than throwing, so one changed
 * class costs a field and not the run.
 */
export function parseGuestPosting(html, externalId) {
  const title = first(html,
    /<h2[^>]*class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i,
    /<h1[^>]*class="[^"]*topcard__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);

  const company = first(html,
    /<a[^>]*class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    /<span[^>]*class="[^"]*topcard__flavor[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

  const location = first(html,
    /<span[^>]*class="[^"]*topcard__flavor--bullet[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

  const descHtml = html.match(
    /<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/section>|<button)/i,
  )?.[1]
    ?? html.match(/<div[^>]*class="[^"]*description__text[^"]*"[^>]*>([\s\S]*?)<\/section>/i)?.[1];

  const jd = descHtml ? htmlToText(descHtml) : null;

  // Structured criteria — "Seniority level: Mid-Senior level" is a far better
  // seniority signal than guessing from the title string.
  const criteria = {};
  const itemRe = /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/gi;
  for (const m of html.matchAll(itemRe)) {
    const key = htmlToText(m[1]).toLowerCase().replace(/\s+/g, '_');
    if (key) criteria[key] = htmlToText(m[2]);
  }

  // The apply CTA's tracking name is how the guest page distinguishes the two
  // routes: -offsite goes to the company's own ATS, -onsite is Easy Apply.
  let applyRoute = 'unknown';
  if (/public_jobs_apply-link-offsite/.test(html)) applyRoute = 'external';
  else if (/public_jobs_apply-link-onsite|jobs-apply-button|easy apply/i.test(html)) applyRoute = 'easy_apply';

  const applyUrl = html.match(
    /<(?:a|code)[^>]*(?:applyUrl|apply-link-offsite)[^>]*href="([^"]+)"/i,
  )?.[1] ?? null;

  const postedAt = html.match(/<time[^>]*datetime="([^"]+)"/i)?.[1] ?? null;
  const applicants = first(html, /<(?:span|figcaption)[^>]*class="[^"]*num-applicants__caption[^"]*"[^>]*>([\s\S]*?)<\/(?:span|figcaption)>/i);

  // A posting that has been taken down still returns 200 with a stub page.
  const closed = /no longer accepting applications|job is no longer available/i.test(html);

  return {
    external_id: externalId,
    title, company, location, jd, criteria,
    applyRoute, applyUrl, postedAt, applicants, closed,
  };
}

/** Retries only what is worth retrying: throttling and transient upstream faults. */
async function fetchWithRetry(url, { attempts = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise(r => setTimeout(r, 1500 * 2 ** (i - 1) + Math.random() * 700));
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-ZA,en-GB;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Fetch and parse one posting. Returns null when the posting is gone (404/410)
 * so callers can retire the job rather than retry it forever.
 */
export async function fetchGuestPosting(externalId) {
  const res = await fetchWithRetry(`${GUEST_BASE}/${encodeURIComponent(externalId)}`);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`guest fetch HTTP ${res.status}`);
  const html = await res.text();
  const parsed = parseGuestPosting(html, externalId);
  // A page with no description at all means the shape changed or LinkedIn served
  // an interstitial — worth surfacing rather than silently storing an empty JD.
  if (!parsed.jd && !parsed.title) throw new Error('guest page had neither title nor description');
  return parsed;
}

/** Seniority from the criteria block — used only when the label is unambiguous. */
const ABOVE_BAND = /^(director|executive)$/i;

export function seniorityReject(criteria) {
  const level = criteria?.seniority_level;
  if (!level) return null;
  if (ABOVE_BAND.test(level.trim())) return `seniority: ${level.toLowerCase()}`;
  return null;
}
