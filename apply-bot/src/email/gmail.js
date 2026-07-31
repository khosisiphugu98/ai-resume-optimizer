import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { ROOT } from '../config.js';
import { buildMimeMessage, toBase64Url } from './mime.js';

const CREDS = path.join(ROOT, 'profile/google-credentials.json');
const TOKEN = path.join(ROOT, 'profile/google-token.json');
const REDIRECT = 'http://localhost:5179/oauth2callback';

/** How long the consent listener stays up. See the note at the setTimeout below. */
const CONSENT_TIMEOUT_MS = Number(process.env.GMAIL_CONSENT_TIMEOUT_MS) || 15 * 60_000;

/**
 * Send only. Nothing here reads the operator's mail.
 *
 * `gmail.readonly` was requested for one feature — noticing that an employer had
 * replied to a thread the bot itself started. Google has no scope that narrow:
 * the smallest one that can read a thread grants every message and every setting
 * in the mailbox, and this is the operator's personal address, not a throwaway.
 * That is a poor trade for automatic outcome tracking, and it was the operator's
 * call to decline it.
 *
 * So reply tracking is off by design, not by fault. `checkReplies` returns
 * empty-handed and says nothing, and READ_SCOPE below stays unrequested. If the
 * decision is ever revisited, adding it back here is the only change needed —
 * everything downstream already asks `canReadMail()` rather than assuming.
 */
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

/** The scope reply tracking would need. Deliberately not in SCOPES — see above. */
export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

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
    // Long enough for a person, not just for a happy path.
    //
    // Five minutes assumed you were already signed in and knew which account to
    // pick. A real grant is: account chooser, password, 2FA, the "Google hasn't
    // verified this app" interstitial with its Advanced link, then the scope
    // screen. Overrun it and the listener is gone by the time Google redirects
    // back, so the browser shows "localhost refused to connect" and the operator
    // is told nothing about why — the failure looks like a firewall problem and
    // is really a stopwatch. Fifteen minutes costs nothing; the server is closed
    // the moment consent lands either way.
    setTimeout(() => {
      server.close();
      reject(new Error(
        'Timed out waiting for consent — the browser tab was not completed in time. '
        + 'Run it again and grant access; nothing was changed.'
      ));
    }, CONSENT_TIMEOUT_MS);
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

    // Consent is per-scope, and a half-grant looks exactly like a whole one.
    //
    // Google's consent screen shows a checkbox per permission and silently drops
    // the ones left unticked — the callback still says "Connected", the token
    // still works, and `isConfigured()` is still true because both files exist.
    // Granting send but not readonly produced precisely that: mail would go out,
    // and `replies` — the only automatic outcome signal there is — would have
    // failed 403 on every cycle forever. Check what actually came back.
    const granted = new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean));
    const missing = SCOPES.filter(s => !granted.has(s));

    return { ok: true, expiring, missing, granted: [...granted] };
  });

  return { url, completed };
}

/** One-time browser consent, terminal flavour. */
export async function authorise() {
  const { url, completed } = beginAuthorisation();
  console.log('\n  Open this URL and grant access.');
  console.log('  Tick EVERY permission box — an unticked one is silently dropped.\n');
  console.log('  ' + url + '\n');

  const r = await completed;
  if (r.expiring) console.log(`\n  ⚠ ${r.expiring}\n`);
  if (r.missing?.length) {
    console.log(
      `\n  ⚠ Only part of the access was granted. Missing: ${r.missing.join(', ')}\n`
      + '    Run this again and tick every box on the consent screen.\n'
    );
  }
  return r;
}

/**
 * Which of the scopes we asked for the saved token actually carries.
 *
 * Read from the token rather than assumed from SCOPES, because the two differ
 * whenever a consent checkbox was left unticked — and that difference is invisible
 * until an API call 403s.
 */
export function grantedScopes() {
  if (!fs.existsSync(TOKEN)) return [];
  try {
    return String(JSON.parse(fs.readFileSync(TOKEN, 'utf8')).scope || '').split(/\s+/).filter(Boolean);
  } catch { return []; }
}

/** Scopes we need and do not have. Empty when the connection is whole. */
export function missingScopes() {
  const granted = new Set(grantedScopes());
  return SCOPES.filter(s => !granted.has(s));
}

/** True when the token can read mail — i.e. reply tracking can work at all. */
export function canReadMail() {
  return grantedScopes().includes(READ_SCOPE);
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

/**
 * The sending address, asked of Google.
 *
 * `users.getProfile` needs a read scope, which is exactly what this install does
 * not have — so with a send-only token this 403s. It stays because the dashboard
 * uses it to display the connected account when the scope allows, but nothing on
 * the sending path may depend on it. Callers must handle the throw.
 */
export async function profileAddress() {
  const p = await gmail('profile');
  return p.emailAddress;
}

/**
 * Send.
 *
 * `from` is passed in rather than fetched. It used to come from
 * `profileAddress()`, which meant every send began with a read call — so a
 * send-only token could not send at all, failing on the one permission it had.
 * Gmail authorises the message by the token, not by this header, and rewrites a
 * From that is not the authenticated account or a verified alias; the header is
 * for the recipient's benefit, and the profile already records the right address
 * for this channel.
 */
export async function sendEmail({ from, to, cc = [], subject, body, attachments = [] }) {
  if (!from) throw new Error('sendEmail needs a from address — the profile records one per channel');
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
