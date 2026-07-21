import { callLLM, hasKey } from '../llm.js';
import { summariseForLLM } from '../profile.js';

const SYSTEM = `You write a short covering email for a job application, in the
candidate's voice.

Constraints:
- 120-180 words. Three short paragraphs at most.
- Use ONLY facts from the CANDIDATE PROFILE. Never invent employers, tools,
  metrics, degrees or years of experience.
- Reference two or three specifics from the job description that the candidate
  genuinely matches. Do not claim anything they do not have.
- No greeting line and no sign-off — those are added separately.
- Plain prose. No markdown, no bullet points, no em dashes.
- Do not mention salary or availability unless the posting asks.

Return JSON: {"body": "<the paragraphs, separated by blank lines>"}`;

function fallbackBody(job, profile) {
  const skills = Object.entries(profile.skills || {})
    .filter(([n, m]) => !n.startsWith('_') && m?.confirmed)
    .slice(0, 5).map(([n]) => n);
  return [
    `I would like to apply for the ${job.title} position at ${job.company}.`,
    `I am currently ${profile.current?.title} at ${profile.current?.company}, where I work across campaign analytics, reporting and marketing data${skills.length ? `, using ${skills.join(', ')}` : ''}. My background is in marketing analytics and ad operations, and I hold a ${profile.education?.[0]?.degree || 'degree'} from ${profile.education?.[0]?.institution || 'university'}.`,
    `My CV is attached. I would welcome the chance to discuss the role.`,
  ].join('\n\n');
}

export async function composeCoverEmail(job, profile, spec) {
  let core;

  if (hasKey()) {
    try {
      const out = await callLLM([
        { role: 'system', content: SYSTEM },
        { role: 'user', content:
            `CANDIDATE PROFILE\n${summariseForLLM(profile)}\n\n` +
            `ROLE: ${job.title} at ${job.company}\n\n` +
            `JOB DESCRIPTION\n${String(job.jd_text || '').slice(0, 3000)}` +
            (spec.requiredBodyItems?.length
              ? `\n\nThe posting asks the email to state: ${spec.requiredBodyItems.join('; ')}`
              : '') },
      ], { maxTokens: 500, temperature: 0.4 });
      core = String(out.body || '').trim();
    } catch { /* fall through */ }
  }

  if (!core) core = fallbackBody(job, profile);

  const who = `${profile.identity.firstName} ${profile.identity.lastName}`;
  const lines = [`Dear Hiring Team,`, '', core, ''];

  // Anything the posting explicitly demands in the body, stated plainly.
  const extras = [];
  if (spec.referenceNumber) extras.push(`Reference: ${spec.referenceNumber}`);
  if (spec.requiredBodyItems?.some(i => /notice/i.test(i)) && profile.authorization?.confirmed) {
    extras.push(`Notice period: ${profile.authorization.noticePeriodDays} days`);
  }
  if (spec.requiredBodyItems?.some(i => /location|reside|based/i.test(i))) {
    extras.push(`Location: ${[profile.identity.city, profile.identity.country].filter(Boolean).join(', ')}`);
  }
  if (extras.length) lines.push(...extras, '');

  lines.push(
    'Kind regards,',
    who,
    profile.identity.phone,
    profile.identity.email,
    ...(profile.links?.linkedin ? [profile.links.linkedin] : []),
  );

  return lines.join('\n');
}
