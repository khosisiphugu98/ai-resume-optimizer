import { callLLM, hasKey } from '../llm.js';

const SYSTEM = `You read a job posting and extract how to apply by email.

Return JSON only:
{
  "to": "<the application email address>",
  "cc": ["..."],
  "subjectTemplate": "<subject line the posting asks for, or a sensible one>",
  "referenceNumber": "<reference/req number if the posting quotes one, else null>",
  "requiredAttachments": ["cv", "cover_letter", "id_document", "transcripts", "certificates", "portfolio"],
  "requiredBodyItems": ["<things the posting says to state in the email>"],
  "deadline": "<ISO date or null>"
}

Rules:
- "to" must be an address that literally appears in the posting. Never invent one.
- Only list attachments the posting explicitly asks for. "cv" covers CV/resume.
- If the posting demands a reference number in the subject, put it in both
  referenceNumber and subjectTemplate.
- If no email address is present, return {"to": null}.`;

// The TLD is matched label by label rather than as one `[\w.]{2,}` run, because
// that class also matches the full stop that ends the sentence the address sits
// in — "send your CV to stefan@prinsandprins.com." yielded a trailing dot and a
// guaranteed hard bounce. 11% of the addresses on file were captured that way.
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

// Inboxes that appear in postings but are never the place an application goes.
// One posting carried both a recruiter's address and the company's data-protection
// officer; only document order kept the CV away from the DPO.
const ROLE_DENYLIST = /^(dpo|privacy|legal|noreply|no-reply|donotreply|unsubscribe|abuse|postmaster|webmaster|marketing|sales|support|billing|press)@/i;

/** Addresses in the posting, de-duplicated, with role inboxes dropped. */
export function addressesIn(jd) {
  const all = [...new Set((String(jd).match(EMAIL_RE) || []).map(a => a.trim()))];
  const usable = all.filter(a => !ROLE_DENYLIST.test(a));
  // If the posting offers nothing but role inboxes, a careers@ address is still
  // better than parking — fall back rather than losing the application.
  return usable.length ? usable : all;
}

// Documents we cannot produce. Asking for these parks the application rather
// than sending an incomplete one.
export const UNAVAILABLE_ATTACHMENTS = new Set([
  'id_document', 'transcripts', 'certificates', 'police_clearance', 'matric_certificate',
]);

export function looksLikeEmailApplication(jd) {
  if (!jd) return false;
  const hasAddress = EMAIL_RE.test(jd);
  EMAIL_RE.lastIndex = 0;
  if (!hasAddress) return false;
  return /send (your |the |us )?(cv|resume|application)|e-?mail your (application|cv|resume)|applications? (to|via|should be)|forward your (cv|resume)|apply by e-?mail|submit your (cv|resume) to/i.test(jd);
}

// Documents ZA postings routinely demand. Detected deterministically and unioned
// with whatever the model reports: a prompt is not a control, and missing one of
// these means emailing a knowingly incomplete application.
const DOCUMENT_PATTERNS = [
  [/\b(certified )?(copy of your )?(id|identity) (document|copy|book)\b|\bid document\b|\bcopy of (your )?id\b/i, 'id_document'],
  [/\btranscripts?\b|\bacademic record\b|\bstatement of results\b/i, 'transcripts'],
  [/\bcertificates?\b|\bqualifications? (copies|documents)\b|\bmatric certificate\b/i, 'certificates'],
  [/\bpolice clearance\b|\bcriminal record check\b/i, 'police_clearance'],
  [/\bdrivers?.? licen[sc]e (copy|document)\b/i, 'drivers_licence_copy'],
];

export function detectRequiredDocuments(jd) {
  const text = String(jd || '');
  return DOCUMENT_PATTERNS.filter(([re]) => re.test(text)).map(([, name]) => name);
}

/** Deterministic fallback when there is no LLM key — address + reference only. */
export function extractHeuristically(jd) {
  const addresses = addressesIn(jd);
  const ref = String(jd).match(/\b(?:ref(?:erence)?|req(?:uisition)?)\s*(?:no\.?|number|#|:)?\s*([A-Z0-9][A-Z0-9\/\-_]{2,})/i);
  return {
    to: addresses[0] || null,
    cc: [],
    subjectTemplate: null,
    referenceNumber: ref ? ref[1] : null,
    requiredAttachments: ['cv', ...detectRequiredDocuments(jd)],
    requiredBodyItems: [],
    deadline: null,
    degraded: true,
  };
}

export async function extractEmailApplication(job) {
  const jd = job.jd_text || '';
  if (!hasKey()) return extractHeuristically(jd);

  let out;
  try {
    out = await callLLM([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `JOB: ${job.title} at ${job.company}\n\nPOSTING\n${jd.slice(0, 6000)}` },
    ], { maxTokens: 500 });
  } catch {
    return extractHeuristically(jd);
  }

  // The address must actually appear in the posting — a hallucinated recipient
  // would send this person's CV to a stranger.
  const present = new Set(addressesIn(jd).map(a => a.toLowerCase()));
  if (!out.to || !present.has(String(out.to).toLowerCase())) {
    const fallback = extractHeuristically(jd);
    if (!fallback.to) return { ...fallback, to: null };
    // Spreading `out` here used to carry the model's own cc array through — on the
    // exact path where it has just been caught inventing a recipient, and skipping
    // the `present` filter applied on the happy path below. Rebuild the spec from
    // the deterministic scan instead, and keep the document union.
    return {
      ...fallback,
      to: fallback.to,
      cc: [],
      subjectTemplate: out.subjectTemplate || fallback.subjectTemplate || null,
      referenceNumber: out.referenceNumber || fallback.referenceNumber || null,
      requiredAttachments: [...new Set([
        ...(Array.isArray(out.requiredAttachments) ? out.requiredAttachments : ['cv']),
        ...detectRequiredDocuments(jd),
      ])],
      correctedRecipient: true,
    };
  }

  return {
    to: out.to,
    cc: Array.isArray(out.cc) ? out.cc.filter(a => present.has(String(a).toLowerCase())) : [],
    subjectTemplate: out.subjectTemplate || null,
    referenceNumber: out.referenceNumber || null,
    // Union with the deterministic scan — if the model overlooks a demand for
    // certified copies, the application must still park rather than go out
    // knowingly incomplete.
    requiredAttachments: [...new Set([
      ...(Array.isArray(out.requiredAttachments) ? out.requiredAttachments : ['cv']),
      ...detectRequiredDocuments(jd),
    ])],
    requiredBodyItems: Array.isArray(out.requiredBodyItems) ? out.requiredBodyItems : [],
    deadline: out.deadline || null,
  };
}

/** Attachments the posting demands that we cannot supply. */
export function missingAttachments(required = []) {
  return required.map(a => String(a).toLowerCase().replace(/\s+/g, '_'))
    .filter(a => UNAVAILABLE_ATTACHMENTS.has(a));
}

/**
 * The subject line, and when the posting's own wins.
 *
 * The one email this system has sent went out as "Application for BI Engineer
 * Position" — no candidate name, no reference, and the real title ("Business
 * Intelligence Engineer") abbreviated into something a recruiter cannot search
 * for. That was not this function; it was `subjectTemplate`, which the model
 * fills in on every extraction whether or not the posting asked for anything,
 * and which unconditionally outranked what is built here.
 *
 * A posting that dictates a subject line must be obeyed — a recruiter filtering
 * on a reference will never see anything else. A posting that says nothing about
 * it should not have a subject invented for it. So the template is honoured only
 * when the posting genuinely instructed one, which `jd_instructions` records
 * deterministically, and everything else gets a subject that carries the real
 * title, the reference if there is one, and the candidate's name.
 */
export function buildSubject(spec, job, profile) {
  const dictated = spec.instructedSubject || (spec.subjectWasInstructed ? spec.subjectTemplate : null);
  if (dictated) return dictated;

  const who = `${profile.identity.firstName} ${profile.identity.lastName}`;
  const ref = spec.referenceNumber ? ` — Ref ${spec.referenceNumber}` : '';
  return `Application: ${job.title}${ref} — ${who}`;
}
