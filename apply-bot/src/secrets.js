import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// Lives in profile/, which is gitignored along with the Gmail token and the
// master profile. Plaintext on your own machine, never committed, never sent
// anywhere except the provider it belongs to.
const FILE = path.join(ROOT, 'profile/secrets.json');

export function loadSecrets() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

/** Called at server start so stages spawned later see the key. */
export function applySecretsToEnv() {
  const s = loadSecrets();
  if (s.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = s.OPENAI_API_KEY;
  return { openai: !!process.env.OPENAI_API_KEY };
}

export function setSecret(key, value) {
  const s = loadSecrets();
  const v = String(value).trim();
  if (!v) delete s[key]; else s[key] = v;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  fs.chmodSync(FILE, 0o600);
  if (key === 'OPENAI_API_KEY') {
    if (v) process.env.OPENAI_API_KEY = v; else delete process.env.OPENAI_API_KEY;
  }
  return { ok: true };
}

/** Never return the key itself to the browser — only whether it is set. */
export function secretsStatus() {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    openaiHint: process.env.OPENAI_API_KEY ? `…${process.env.OPENAI_API_KEY.slice(-4)}` : null,
  };
}
