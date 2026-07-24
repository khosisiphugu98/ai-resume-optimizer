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
// Keys we mirror into the environment so stages spawned later can read them.
// OpenAI powers scoring + field answers; Anthropic powers the adaptive agent's
// planner (Phase 2) with OpenAI as the fallback.
const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

export function applySecretsToEnv() {
  const s = loadSecrets();
  for (const k of ENV_KEYS) if (s[k] && !process.env[k]) process.env[k] = s[k];
  return { openai: !!process.env.OPENAI_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY };
}

export function setSecret(key, value) {
  const s = loadSecrets();
  const v = String(value).trim();
  if (!v) delete s[key]; else s[key] = v;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  fs.chmodSync(FILE, 0o600);
  if (ENV_KEYS.includes(key)) {
    if (v) process.env[key] = v; else delete process.env[key];
  }
  return { ok: true };
}

/** Never return a key itself to the browser — only whether it is set, plus a hint. */
export function secretsStatus() {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    openaiHint: process.env.OPENAI_API_KEY ? `…${process.env.OPENAI_API_KEY.slice(-4)}` : null,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    anthropicHint: process.env.ANTHROPIC_API_KEY ? `…${process.env.ANTHROPIC_API_KEY.slice(-4)}` : null,
  };
}
