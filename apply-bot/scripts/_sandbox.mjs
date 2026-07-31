/**
 * Refuse to run a suite against the real database.
 *
 * run-tests.mjs points every suite at a throwaway DB precisely so the suites can
 * seed jobs and clear the rate ledger without consequence. Run one of those files
 * directly — `node scripts/apply-tests.mjs`, which is the obvious thing to do when
 * you are iterating on a single suite — and it inherits no such thing. It writes
 * to data/pipeline.sqlite.
 *
 * That is not theoretical. It has cost, in one session: the operator's run mode
 * flipped to `observe` and stayed there, silently halting every application; and
 * `DELETE FROM rate_ledger` emptied the live table, taking four days of anti-ban
 * accounting with it. The runner's own header warns about exactly this — "running
 * the tests must not be able to reset it" — and nothing enforced it.
 *
 * Import this first in any suite that writes. It is a guard, not a fixture: it
 * points nothing anywhere, it only refuses.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DB = path.join(ROOT, 'data/pipeline.sqlite');

export function requireSandboxedDb() {
  const configured = process.env.APPLY_BOT_DB;
  if (configured && path.resolve(configured) !== REAL_DB) return;

  console.error(`
  This suite writes to the database it is pointed at, and it is pointed at the
  real one${configured ? '' : ' (APPLY_BOT_DB is unset)'}. It would clear the rate ledger and overwrite operator
  settings on the live pipeline.

  Run the suites through the runner, which gives them a throwaway database:

      npm test

  Or point this one somewhere disposable yourself:

      APPLY_BOT_DB=$(mktemp -d)/pipeline.sqlite node ${path.relative(process.cwd(), process.argv[1])}
`);
  process.exit(2);
}

requireSandboxedDb();
