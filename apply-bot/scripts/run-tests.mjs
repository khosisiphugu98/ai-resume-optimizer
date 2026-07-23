/**
 * Test runner.
 *
 * Its one job beyond sequencing is pointing every suite at a throwaway database.
 * The suites seed jobs and clear the rate ledger, and that ledger is the daily
 * cap that keeps LinkedIn from flagging the account — running the tests must not
 * be able to reset it, or to leave fixture jobs sitting in the real board.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'smoke.mjs',
  'answer-tests.mjs',
  'apply-tests.mjs',
  'easyapply-integration.mjs',
  'ats-tests.mjs',
  'a11y-tests.mjs',
  'email-tests.mjs',
  'outcome-tests.mjs',
  'calibration-tests.mjs',
  'enrich-tests.mjs',
  'searches-tests.mjs',
  'settings-tests.mjs',
  'orchestrator-tests.mjs',
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-bot-test-'));
const env = {
  ...process.env,
  APPLY_BOT_DB: path.join(tmp, 'pipeline.sqlite'),
  // And at a kill switch that is never on, so a real STOP left over from a halted
  // run cannot fail every rate-limit assertion.
  APPLY_BOT_STOP: path.join(tmp, 'STOP'),
};

let failed = 0;
for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [path.join(HERE, suite)], { stdio: 'inherit', env });
  if (r.status !== 0) { failed++; console.log(`\n  ✗ ${suite} exited ${r.status}\n`); }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failed ? `\n${failed} suite(s) failed\n` : '\nAll suites passed\n');
process.exit(failed ? 1 : 0);
