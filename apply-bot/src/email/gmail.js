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
  Connect it under the gear in the dashboard, which walks through the steps.
`;

function loadClient() {
  const raw = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  const conf = raw.installed || raw.web;
  if (!conf) throw new Error('google-credentials.json is not an installed/desktop OAuth client');
  return new OAuth2Client(conf.client_id, conf.client_secret, REDIRECT);
}

/**
 * Save the OAuth client JSON downloaded from Google Cloud. Validated on the way
 * in, because the difference between a Desktop client and a Web one only shows
 * up as an opaque redirect_uri_mismatch three steps later.
 */
export function saveCredentials(jsonText) {
  let raw;
  try { raw = JSON.parse(jsonText); }
  catch { throw new Error('That is not valid JSON — paste the whole file you downloaded from Google Cloud.'); }

  const conf = raw.installed || raw.web;
  if (!conf?.client_id || !conf?.client_secret) {
    throw new Error('No OAuth client in that JSON. It needs an "installed" or "web" block with client_id and client_secret.');
  }
  if (raw.web && !raw.installed) {
    throw new Error('That is a Web application client. Create an OAuth client of type "Desktop app" instead.');
  }

  fs.mkdirSync(path.dirname(CREDS), { recursive: true });
  fs.writeFileSync(CREDS, JSON.stringify(raw, null, 2));
  fs.chmodSync(CREDS, 0o600);
  return { ok: true, clientId: conf.client_id };
}

/** Forget the connection. Credentials stay so reconnecting is one click. */
export function disconnect() {
  fs.rmSync(TOKEN, { force: true });
  return { ok: true };
}

export function status() {
  return { hasCredentials: hasCredentials(), connected: isConfigured(), redirect: REDIRECT };
}

/**
 * Consent, split so it can be driven from the dashboard as well as the CLI.
 *
 * The caller needs the URL back *before* the flow finishes — a browser cannot be
 * told to visit a page by a request that is still blocking on that visit — so
 * this returns the URL immediately alongside a promise for the rest.
 */
export function beginAuthorisation() {
  if (!hasCredentials()) throw new Error(`No credentials at ${CREDS}.\n${SETUP_HELP}`);
  const client = loadClient();
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  const completed = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); return res.end(); }
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<body style="font:16px system-ui;padding:40px;background:#0f1216;color:#e6edf3">${
        c ? 'Connected. You can close this tab and go back to the dashboard.' : `Not connected: ${err || 'no code returned'}`
      }</body>`);
      server.close();
      c ? resolve(c) : reject(new Error(err || 'No code returned'));
    });
    server.on('error', reject);
    server.listen(5179);
    setTimeout(() => { server.close(); reject(new Error('Timed out waiting for consent')); }, 300_000);
  }).then(async code => {
    const { tokens } = await client.getToken(code);
    fs.mkdirSync(path.dirname(TOKEN), { recursive: true });
    fs.writeFileSync(TOKEN, JSON.stringify(tokens, null, 2));
    fs.chmodSync(TOKEN, 0o600);

    // Say so now, not in three days' worth of invalid_grant. A bounded refresh
    // token means the consent screen is still in Testing; publishing it to
    // Production is what makes the connection survive.
    const ttl = Number(tokens.refresh_token_expires_in);
    const expiring = Number.isFinite(ttl)
      ? `Google issued a refresh token good for only ${(ttl / 3600).toFixed(1)} hours. `
        + 'That happens while the OAuth consent screen is in "Testing" — publish the app '
        + 'to Production in Google Cloud, then reconnect, or this will break again today.'
      : null;

    return { ok: true, expiring };
  });

  return { url, completed };
}

/** One-time browser consent, terminal flavour. */
export async function authorise() {
  const { url, completed } = beginAuthorisation();
  console.log('\n  Open this URL and grant access:\n\n  ' + url + '\n');
  return completed;
}

/**
 * A refresh token that Google will not honour again. Distinct from every other
 * Gmail failure because it is the only one a retry cannot fix: the fix is a human
 * granting consent once more. Callers key off `.code` rather than string-matching
 * the message.
 */
export class GmailAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GmailAuthError';
    this.code = 'gmail_disconnected';
  }
}

/**
 * Refresh tokens Google issues while the OAuth consent screen is still in
 * "Testing" carry a `refresh_token_expires_in` — the one on 29 July was good for
 * 4.1 hours. When it lapses, every call returns `invalid_grant` forever, and the
 * pipeline logged that same failure 146 times over three days without ever saying
 * what to do about it. Surfacing the lifetime at grant time is the cheap warning;
 * `GmailAuthError` is the one that arrives too late to help.
 */
export function refreshTokenLifetimeSeconds() {
  if (!fs.existsSync(TOKEN)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN, 'utf8'));
    return Number.isFinite(t.refresh_token_expires_in) ? t.refresh_token_expires_in : null;
  } catch { return null; }
}

async function accessToken() {
  const client = loadClient();
  client.setCredentials(JSON.parse(fs.readFileSync(TOKEN, 'utf8')));

  let token;
  try {
    ({ token } = await client.getAccessToken());
  } catch (err) {
    // google-auth-library reports the OAuth error code on the response body, and
    // in the message for transport-level failures. Check both.
    const code = err?.response?.data?.error || '';
    if (code === 'invalid_grant' || /invalid_grant/.test(err.message || '')) {
      throw new GmailAuthError(
        'the Gmail refresh token is no longer valid (invalid_grant) — reconnect with: npm run gmail:auth'
      );
    }
    throw err;
  }

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
