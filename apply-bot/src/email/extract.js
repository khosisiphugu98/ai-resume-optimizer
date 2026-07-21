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

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;

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
  const addresses = [...new Set(String(jd).match(EMAIL_RE) || [])];
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
  const present = new Set((jd.match(EMAIL_RE) || []).map(a => a.toLowerCase()));
  if (!out.to || !present.has(String(out.to).toLowerCase())) {
    const fallback = extractHeuristically(jd);
    if (!fallback.to) return { ...fallback, to: null };
    return { ...out, to: fallback.to, correctedRecipient: true };
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

export function buildSubject(spec, job, profile) {
  if (spec.subjectTemplate) return spec.subjectTemplate;
  const who = `${profile.identity.firstName} ${profile.identity.lastName}`;
  const ref = spec.referenceNumber ? ` — Ref ${spec.referenceNumber}` : '';
  return `Application: ${job.title}${ref} — ${who}`;
}
