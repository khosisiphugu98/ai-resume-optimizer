import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { ROOT } from '../config.js';
import { buildMimeMessage, toBase64Url } from './mime.js';

const CREDS = path.join(ROOT, 'profile/google-credentials.json');
const TOKEN = path.join(ROOT, 'profile/google-token.json');
const REDIRECT = 'http://localhost:5179/oauth2callback';

// gmail.send to send, gmail.readonly to watch for replies. Deliberately not
// gmail.modify — nothing here should ever alter or delete mail.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export function isConfigured() {
  return fs.existsSync(CREDS) && fs.existsSync(TOKEN);
}

export function hasCredentials() {
  return fs.existsSync(CREDS);
}

export const SETUP_HELP = `
  Gmail is not connected, so emails will be drafted but not sent.

  To connect:
    1. console.cloud.google.com → create a project
    2. Enable the Gmail API
    3. Credentials → Create OAuth client ID → Desktop app
    4. Download the JSON to apply-bot/profile/google-credentials.json
    5. npm run gmail:auth
`;

function loadClient() {
  const raw = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  const conf = raw.installed || raw.web;
  if (!conf) throw new Error('google-credentials.json is not an installed/desktop OAuth client');
  return new OAuth2Client(conf.client_id, conf.client_secret, REDIRECT);
}

/** One-time browser consent. Runs a throwaway local server for the redirect. */
export async function authorise() {
  if (!hasCredentials()) throw new Error(`No credentials at ${CREDS}.\n${SETUP_HELP}`);
  const client = loadClient();
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('\n  Open this URL and grant access:\n\n  ' + url + '\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); return res.end(); }
      const c = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<body style="font:16px system-ui;padding:40px">Connected. You can close this tab.</body>');
      server.close();
      c ? resolve(c) : reject(new Error('No code returned'));
    });
    server.listen(5179);
    setTimeout(() => { server.close(); reject(new Error('Timed out waiting for consent')); }, 300_000);
  });

  const { tokens } = await client.getToken(code);
  fs.mkdirSync(path.dirname(TOKEN), { recursive: true });
  fs.writeFileSync(TOKEN, JSON.stringify(tokens, null, 2));
  return { ok: true };
}

async function accessToken() {
  const client = loadClient();
  client.setCredentials(JSON.parse(fs.readFileSync(TOKEN, 'utf8')));
  const { token } = await client.getAccessToken();
  // Refresh tokens rotate; persist whatever we now hold.
  fs.writeFileSync(TOKEN, JSON.stringify(client.credentials, null, 2));
  return token;
}

async function gmail(pathname, { method = 'GET', body = null, query = {} } = {}) {
  const token = await accessToken();
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function profileAddress() {
  const p = await gmail('profile');
  return p.emailAddress;
}

export async function sendEmail({ to, cc = [], subject, body, attachments = [] }) {
  const from = await profileAddress();
  const raw = toBase64Url(buildMimeMessage({ from, to, cc, subject, body, attachments }));
  const sent = await gmail('messages/send', { method: 'POST', body: { raw } });
  return { messageId: sent.id, threadId: sent.threadId };
}

/**
 * Look for a reply in a thread we started. This is the only channel that gives
 * outcome data back automatically — the ATS ones tell you nothing.
 */
export async function checkThread(threadId, ourAddress) {
  const thread = await gmail(`threads/${threadId}`, { query: { format: 'metadata' } });
  const messages = thread.messages || [];

  const inbound = messages.filter(m => {
    const from = (m.payload?.headers || []).find(h => h.name.toLowerCase() === 'from')?.value || '';
    return !from.toLowerCase().includes(String(ourAddress).toLowerCase());
  });
  if (!inbound.length) return { replied: false };

  const latest = inbound.at(-1);
  const snippet = `${latest.snippet || ''}`.toLowerCase();
  const state =
    /unfortunately|not (be )?(moving|proceeding)|unsuccessful|regret|other candidates|not shortlist/.test(snippet) ? 'rejected'
    : /interview|schedule a (call|chat)|availability|meet|next steps|assessment/.test(snippet) ? 'interview'
    : 'replied';

  return { replied: true, state, snippet: latest.snippet || '', at: Number(latest.internalDate) || null };
}
