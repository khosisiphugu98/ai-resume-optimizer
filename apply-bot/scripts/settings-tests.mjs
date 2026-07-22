/**
 * Settings tests — the credential paths.
 *
 * These touch real files (secrets.json, google-credentials.json), so each test
 * snapshots what was there and puts it back. Getting that wrong would delete a
 * working key, which is exactly the kind of thing a test must never do.
 */
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
  assert.match(scope, /gmail\.readonly/);
  // gmail.modify would let this delete or alter mail. It must never be asked for.
  assert.doesNotMatch(scope, /gmail\.modify/);
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
