import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT } from './runCli.js';

const execFileAsync = promisify(execFile);
let built = false;

/**
 * Build dist/index.js exactly once per vitest process (idempotent). Set
 * TUCK_E2E_SKIP_BUILD=1 to skip when you've already built a fresh dist (fast
 * local iteration). `pnpm test:e2e` relies on this guard — there is no pretest
 * build step (which would double-build).
 */
export const ensureBuilt = async (): Promise<void> => {
  if (built) return;
  if (process.env.TUCK_E2E_SKIP_BUILD === '1') {
    built = true;
    return;
  }
  await execFileAsync('pnpm', ['build'], { cwd: REPO_ROOT, timeout: 180_000 });
  built = true;
};
