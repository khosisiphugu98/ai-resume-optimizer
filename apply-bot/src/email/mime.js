import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

/** RFC 2047 — headers must be ASCII, and names and subjects often are not. */
function encodeHeader(value) {
  const s = String(value);
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function wrap(b64, width = 76) {
  return b64.replace(new RegExp(`(.{1,${width}})`, 'g'), '$1\r\n').trimEnd();
}

/**
 * Build an RFC 5322 multipart/mixed message.
 *
 * The text part is base64-encoded rather than sent raw: bodies routinely contain
 * non-ASCII (curly quotes, accented names) and 8-bit content in a 7-bit transport
 * is how mojibake happens.
 */
export function buildMimeMessage({ from, to, cc = [], subject, body, attachments = [] }) {
  const boundary = `----=_bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(body, 'utf8').toString('base64')),
  ];

  for (const file of attachments) {
    if (!fs.existsSync(file)) throw new Error(`Attachment not found: ${file}`);
    const name = path.basename(file);
    const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    parts.push(
      `--${boundary}`,
      `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap(fs.readFileSync(file).toString('base64')),
    );
  }

  parts.push(`--${boundary}--`, '');
  return [...headers, '', ...parts].join('\r\n');
}

/** Gmail's API wants base64url with no padding. */
export function toBase64Url(raw) {
  return Buffer.from(raw, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
