/**
 * What the posting actually told you to do.
 *
 * `jd_text` has always been passed into the answer context and the email
 * composer, so a model could *reason* from it — but nothing in the pipeline ever
 * extracted an instruction from a job description and acted on it. Measured
 * across 2465 stored descriptions:
 *
 *   portfolio / work samples requested      331   13.4%
 *   reference / quote code                  106    4.3%
 *   closing date stated                      99    4.0%
 *   explicit "send your CV to <address>"     50    2.0%
 *   complete an assessment / test            37    1.5%
 *   cover letter required                    23    0.9%
 *   subject-line instruction                 20    0.8%
 *
 * The sharpest case is routing. Of the 50 postings naming an address to apply
 * to, the classifier already sent 39 to the email channel and misrouted 11 —
 * `careers@pineapple.co.za` for an Actuarial and Data Analyst among them, which
 * is exactly the kind of role that should score. All 11 happened to be rejected
 * on fit, so nothing was misapplied; the mechanism was live regardless.
 *
 * Deliberately deterministic. This runs on every posting at enrich time, the
 * patterns are the ones the corpus actually contains, and an instruction is a
 * thing the posting says in words rather than a judgement call — so there is
 * nothing here for a model to add, and a model would add a way to be wrong.
 */
import { normalisePunctuation } from '../answer/matchers.js';

/**
 * Inboxes that appear in postings but are never where an application goes.
 *
 * `legal@metricgroup.net` was extracted as the apply address for a Maintenance
 * Foreman post. The send-time denylist already refuses to mail these; refusing
 * to *route* on them as well means the posting is not pulled onto the email
 * channel by an address that was never an invitation in the first place.
 */
const ROLE_INBOX = /^(dpo|privacy|legal|noreply|no-reply|donotreply|unsubscribe|abuse|postmaster|webmaster|compliance|invoices?|accounts|billing|press|media|info)@/i;

const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;

/** A sentence that tells you to send something somewhere. */
const APPLY_INSTRUCTION =
  /\b(send|e-?mail|forward|submit|apply|address|direct)\b[^.!?\n]{0,80}\b(cv|c\.v\.|resume|résumé|application|applications|credentials)\b|\b(cv|resume|résumé|application|applications)\b[^.!?\n]{0,80}\b(should be|must be|to be)?\s*(sent|e-?mailed|forwarded|submitted|addressed|directed)\b/i;

/**
 * A reference code, and the two things that stop it being any word at all.
 *
 * The label has to be one that means "a code follows" — "Job Ref", "Reference
 * Number", "Requisition ID". A first attempt also allowed a bare "Position:" or
 * "Job:", which matched "Position: Data Analyst" across the corpus and captured
 * the word `Data`. A recruiter would have received "Ref Data" in a subject line.
 */
const REFERENCE =
  /\b(?:ref(?:erence)?|req(?:uisition)?|(?:job|vacancy|position)\s*(?:ref(?:erence)?|no|number|code|id))\b\s*(?:no\.?|number|code|#|id|:)?\s*[:#]?\s*([A-Z0-9][A-Z0-9/\-_]{2,})/i;

/**
 * What a code looks like, as opposed to a word.
 *
 * Either it carries a digit, or it is a short all-caps token — "CPT006720/H",
 * "RCL260721-3", "GMMG". Ordinary capitalised English never satisfies both the
 * label above and this.
 */
const looksLikeCode = v => /\d/.test(v) || (/^[A-Z][A-Z0-9/\-_]{2,}$/.test(v) && v === v.toUpperCase());

const SUBJECT_LINE =
  /\bsubject\s*(?:line)?\s*(?:should (?:read|be)|must (?:read|be)|:|as)\s*["“']?([^"”'\n.]{4,90})/i;

const REQUIREMENT_PATTERNS = [
  ['portfolio', /\bportfolio\b|\bwork samples?\b|\bsamples? of (?:your )?work\b|\bwriting samples?\b|\blink to your work\b|\bshow ?reel\b/i],
  ['assessment', /\b(complete|take|sit|undergo|pass)\b[^.!?\n]{0,40}\b(assessment|aptitude test|online test|technical test|coding (challenge|test)|psychometric)\b|\byou will be (asked|required) to complete\b[^.!?\n]{0,40}\btest\b/i],
  ['cover_letter', /\b(cover(ing)? letter|motivational letter|letter of motivation)\b[^.!?\n]{0,40}\b(required|must|is essential|please (attach|include|submit))\b|\b(attach|include|submit|send)\b[^.!?\n]{0,30}\b(cover(ing)? letter|motivational letter)\b/i],
];

// "Closing date: 15 August 2026", "applications close on 2026-08-15",
// "deadline: 15/08/2026". Only ever read from a labelled statement — a bare date
// in a job description is far more often a start date or a company milestone.
const CLOSING_DATE =
  /\b(?:closing date|applications? close|close[sd]? on|deadline|apply before|last day to apply|applications? must be (?:received|submitted) by)\b\s*(?:is|:|on|by)?\s*([0-9]{1,2}[ \/\-.][0-9]{1,2}[ \/\-.][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}(?:st|nd|rd|th)? +[A-Za-z]{3,9},? +[0-9]{4}|[A-Za-z]{3,9} +[0-9]{1,2}(?:st|nd|rd|th)?,? +[0-9]{4})/i;

/** Sentences, with the punctuation real postings are typed with folded to ASCII. */
const sentencesIn = jd => normalisePunctuation(String(jd || '')).split(/(?<=[.!?])\s+|\n+/);

/**
 * The address a posting tells you to apply to, or null.
 *
 * Read from the instruction sentence rather than from the document, because a
 * posting routinely carries several addresses and only one of them is an
 * invitation. Taking the first address anywhere in the text is how a
 * data-protection officer came to be a candidate recipient.
 */
export function applyAddressIn(jd) {
  for (const sentence of sentencesIn(jd)) {
    if (!APPLY_INSTRUCTION.test(sentence)) continue;
    const hit = sentence.match(ADDRESS);
    if (hit && !ROLE_INBOX.test(hit[0])) return hit[0];
  }
  return null;
}

/** An ISO date, or null when the text does not parse as one. */
function toIsoDate(raw) {
  if (!raw) return null;
  const text = String(raw).trim().replace(/(\d)(st|nd|rd|th)\b/i, '$1');

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;

  // Day-first, which is what South African postings use.
  const dmy = text.match(/^(\d{1,2})[ \/\-.](\d{1,2})[ \/\-.](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? `20${y}` : y;
    const date = new Date(Date.UTC(Number(year), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  const parsed = new Date(`${text} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Everything the posting says about how to apply.
 *
 * @returns {{applyEmail, referenceNumber, subjectLine, requires: string[], closingDate}}
 */
export function extractInstructions(jd) {
  const text = normalisePunctuation(String(jd || ''));

  const reference = text.match(REFERENCE);
  const subject = text.match(SUBJECT_LINE);
  const closing = text.match(CLOSING_DATE);

  const code = reference?.[1]?.trim();

  return {
    applyEmail: applyAddressIn(jd),
    referenceNumber: code && looksLikeCode(code) ? code : null,
    subjectLine: subject ? subject[1].trim() : null,
    requires: REQUIREMENT_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name),
    closingDate: closing ? toIsoDate(closing[1]) : null,
  };
}

/** True when nothing was found — worth knowing so an empty object is not stored. */
export const hasInstructions = i =>
  !!(i && (i.applyEmail || i.referenceNumber || i.subjectLine || i.closingDate || i.requires?.length));

/**
 * Requirements this system cannot meet for a posting, in words an operator can act on.
 *
 * Not every stated requirement is a blocker. A covering letter is written for
 * every email application and most ATS forms offer somewhere to put one; a
 * portfolio is satisfiable the moment `links.portfolio` is set, and the answer
 * layer already has a matcher that will supply it. An assessment is not
 * satisfiable at all — something has to be sat, by a person.
 *
 * The point is the doc's: an application that silently omits a required artefact
 * is a wasted send, and 13.4% of postings ask for one.
 */
export function unmeetableRequirements(instructions, profile) {
  const out = [];
  for (const need of instructions?.requires || []) {
    if (need === 'portfolio' && !profile?.links?.portfolio) {
      out.push('the posting asks for a portfolio or work samples, and links.portfolio is empty in the profile');
    }
    if (need === 'assessment') {
      out.push('the posting requires an assessment or test, which has to be sat by a person');
    }
  }
  return out;
}

/** Whether a posting's own closing date has passed. */
export function isClosed(instructions, now = new Date()) {
  const date = instructions?.closingDate;
  if (!date) return false;
  return date < now.toISOString().slice(0, 10);
}
