/**
 * Settings tests — the credential paths.
 *
 * These touch real files (secrets.json, google-credentials.json), so each test
 * snapshots what was there and puts it back. Getting that wrong would delete a
 * working key, which is exactly the kind of thing a test must never do.
 */
import './_sandbox.mjs';   // refuses to run against the real database
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT } from '../src/config.js';
import { setSecret, secretsStatus, loadSecrets } from '../src/secrets.js';
import * as gmail from '../src/email/gmail.js';

const SECRETS = path.join(ROOT, 'profile/secrets.json');
const CREDS = path.join(ROOT, 'profile/google-credentials.json');
const TOKEN = path.join(ROOT, 'profile/google-token.json');

const snapshot = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const restore = (f, v) => { if (v === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, v); };

const before = { secrets: snapshot(SECRETS), creds: snapshot(CREDS), token: snapshot(TOKEN) };
const envKeyBefore = process.env.OPENAI_API_KEY;

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); fail++; }
};

console.log('\nOpenAI key');

test('saving a key makes it visible to the pipeline but never readable back', () => {
  setSecret('OPENAI_API_KEY', 'sk-test-abcdefghijklmnop1234');
  const s = secretsStatus();
  assert.equal(s.openai, true);
  assert.equal(s.openaiHint, '…1234');
  assert.equal(JSON.stringify(s).includes('abcdefghijklmnop'), false, 'the key itself leaked to the client payload');
  assert.equal(process.env.OPENAI_API_KEY, 'sk-test-abcdefghijklmnop1234');
});

test('the key file is not world-readable', () => {
  assert.equal(fs.statSync(SECRETS).mode & 0o077, 0, 'secrets.json is readable by other users');
});

test('clearing removes it from disk and from the environment', () => {
  setSecret('OPENAI_API_KEY', '');
  assert.equal(secretsStatus().openai, false);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal('OPENAI_API_KEY' in loadSecrets(), false);
});

test('whitespace-only input clears rather than storing a blank key', () => {
  setSecret('OPENAI_API_KEY', '   ');
  assert.equal(secretsStatus().openai, false);
});

console.log('\nGmail credentials');

test('rejects text that is not JSON', () => {
  assert.throws(() => gmail.saveCredentials('not json at all'), /valid JSON/);
});

test('rejects JSON with no OAuth client in it', () => {
  assert.throws(() => gmail.saveCredentials('{"hello":"world"}'), /No OAuth client/);
});

test('rejects a Web client, which cannot use the local redirect', () => {
  assert.throws(
    () => gmail.saveCredentials(JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } })),
    /Desktop app/,
  );
});

test('accepts a Desktop client and reports the client id', () => {
  const r = gmail.saveCredentials(JSON.stringify({
    installed: { client_id: 'test-client.apps.googleusercontent.com', client_secret: 'shh' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.clientId, 'test-client.apps.googleusercontent.com');
  assert.equal(fs.existsSync(CREDS), true);
});

test('the credentials file is not world-readable', () => {
  assert.equal(fs.statSync(CREDS).mode & 0o077, 0);
});

test('credentials present but no token means "not connected"', () => {
  fs.rmSync(TOKEN, { force: true });
  const s = gmail.status();
  assert.equal(s.hasCredentials, true);
  assert.equal(s.connected, false);
  assert.equal(s.redirect, 'http://localhost:5179/oauth2callback');
});

test('connecting is only possible once credentials exist', () => {
  fs.rmSync(CREDS, { force: true });
  assert.throws(() => gmail.beginAuthorisation(), /No credentials/);
});

test('beginAuthorisation hands back a Google consent URL with the right scopes', () => {
  gmail.saveCredentials(JSON.stringify({
    installed: { client_id: 'test-client.apps.googleusercontent.com', client_secret: 'shh' },
  }));
  const { url, completed } = gmail.beginAuthorisation();
  completed.catch(() => {});                       // nothing will complete it here
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:5179/oauth2callback');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  const scope = u.searchParams.get('scope');
  assert.match(scope, /gmail\.send/);
  // Send, and nothing else.
  //
  // gmail.readonly was asked for so the bot could notice an employer replying to
  // a thread it started. Google has no scope that narrow — the smallest one that
  // can read a thread grants every message and every setting in the mailbox — and
  // this runs against the operator's personal address. They declined it, and
  // reply tracking is off as a result. Widening this again is a decision about
  // someone's private mail, so it should fail here first and be made on purpose.
  assert.doesNotMatch(scope, /gmail\.readonly/);
  // gmail.modify would let this delete or alter mail. It must never be asked for.
  assert.doesNotMatch(scope, /gmail\.modify/);
});

// A send-only token is the expected state, so nothing on the sending path may
// depend on a read call. sendEmail used to open with users.getProfile to find its
// own From address — one read to enable one send, which 403s on a token that can
// only send. It takes the address as an argument now.
test('sending needs no read access — the From address is passed in', async () => {
  await assert.rejects(
    () => gmail.sendEmail({ to: 'a@b.c', subject: 's', body: 'b' }),
    /needs a from address/,
  );
});

test('the scopes a saved token actually carries are readable, and read access is off', () => {
  fs.writeFileSync(TOKEN, JSON.stringify({
    refresh_token: 'x', scope: 'https://www.googleapis.com/auth/gmail.send',
  }));
  assert.deepEqual(gmail.grantedScopes(), ['https://www.googleapis.com/auth/gmail.send']);
  assert.equal(gmail.canReadMail(), false);
  assert.deepEqual(gmail.missingScopes(), []);   // nothing missing: send is all we ask for

  // And a half-grant against a wider ask is still detected, which is what makes
  // a silently-unticked consent box visible at grant time instead of at 403 time.
  fs.writeFileSync(TOKEN, JSON.stringify({ refresh_token: 'x', scope: gmail.READ_SCOPE }));
  assert.equal(gmail.canReadMail(), true);
  assert.deepEqual(gmail.missingScopes(), ['https://www.googleapis.com/auth/gmail.send']);
  fs.rmSync(TOKEN, { force: true });
});

test('disconnect drops the token but keeps credentials', () => {
  fs.writeFileSync(TOKEN, '{"refresh_token":"x"}');
  gmail.disconnect();
  assert.equal(fs.existsSync(TOKEN), false);
  assert.equal(gmail.hasCredentials(), true);
});

restore(SECRETS, before.secrets);
restore(CREDS, before.creds);
restore(TOKEN, before.token);
if (envKeyBefore === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = envKeyBefore;

console.log('\nteardown');
test('the files this suite touched are back as they were', () => {
  assert.equal(snapshot(SECRETS), before.secrets);
  assert.equal(snapshot(CREDS), before.creds);
  assert.equal(snapshot(TOKEN), before.token);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
