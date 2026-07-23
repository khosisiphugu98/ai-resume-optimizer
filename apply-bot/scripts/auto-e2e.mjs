/**
 * End-to-end test of the autonomous loop against the real server, over real HTTP.
 *
 * The whole point of the loop is that it keeps running on its own, so the thing to
 * prove is the wiring the unit tests can't reach: that /api/auto starts the loop in
 * the server process, that the board and settings report it, that the kill switch
 * parks it, and that toggling it off unwinds it.
 *
 * The kill switch is written BEFORE the loop is enabled, so it parks on STOP before
 * it ever reaches discover — this exercises the full server + orchestrator path
 * without launching Chrome or touching LinkedIn. Everything runs on a throwaway db
 * and port so it cannot disturb a live dashboard or the daily rate ledger.
 *
 * Run: node scripts/auto-e2e.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); fail++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (p, init) => {
  const res = await fetch(BASE + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (p, obj) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-bot-auto-'));
const STOP = path.join(tmp, 'STOP');
const env = {
  ...process.env,
  APPLY_BOT_DB: path.join(tmp, 'pipeline.sqlite'),
  APPLY_BOT_STOP: STOP,
  APPLY_BOT_PORT: String(PORT),
  HEADLESS: '1',
};

const children = [];
function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch {} } }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);

// Park the loop before it can reach a real stage.
fs.writeFileSync(STOP, new Date().toISOString());

console.log('\n── Dashboard server (throwaway db + port) ──\n');

const server = spawn(process.execPath, ['src/cli.js', 'serve'], {
  cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env,
});
children.push(server);
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => process.stderr.write(`  [server] ${d}`));

for (let i = 0; i < 40 && !/Dashboard →/.test(serverOut); i++) await sleep(500);
ok('server started', /Dashboard →/.test(serverOut), serverOut.slice(0, 300));

let board = await api('/api/board');
ok('/api/board reports auto:false before we enable it', board.body?.auto === false, JSON.stringify(board.body?.auto));
let settings = await api('/api/settings');
ok('/api/settings reports auto:false too', settings.body?.auto === false);

console.log('\n── Enable the loop while the kill switch is on ──\n');

const enabled = await post('/api/auto', { on: true });
ok('/api/auto {on:true} returns auto:true', enabled.body?.auto === true, JSON.stringify(enabled.body));

board = await api('/api/board');
ok('board now reports auto:true', board.body?.auto === true);
ok('board still reports stopped:true (kill switch)', board.body?.stopped === true);
settings = await api('/api/settings');
ok('settings reports auto:true', settings.body?.auto === true);

// The loop should reach its first stage, see STOP, and park — not run anything.
let events = [];
for (let i = 0; i < 20; i++) {
  await sleep(300);
  events = (await api('/api/events')).body || [];
  if (events.some(e => e.stage === 'auto' && /paused/i.test(e.message))) break;
}
ok('the loop parked on the kill switch', events.some(e => e.stage === 'auto' && /paused/i.test(e.message)),
  events.filter(e => e.stage === 'auto').map(e => e.message).join(' | ') || 'no auto events');
ok('no stage ran while parked (no discover/enrich Started)',
  !events.some(e => ['discover', 'enrich', 'score', 'tailor'].includes(e.stage) && /^Started/.test(e.message)),
  events.filter(e => /^Started/.test(e.message)).map(e => e.stage).join(',') || 'none');

console.log('\n── Disable the loop ──\n');

const disabled = await post('/api/auto', { on: false });
ok('/api/auto {on:false} returns auto:false', disabled.body?.auto === false);
board = await api('/api/board');
ok('board reports auto:false again', board.body?.auto === false);

console.log(fail ? `\n${fail} failed\n` : `\n${pass} passed\n`);
process.exit(fail ? 1 : 0);
