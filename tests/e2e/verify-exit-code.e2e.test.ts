import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { ensureBuilt } from './helpers/build.js';
import { runCli, makeHome, cleanupHome, seedHomeFile, parseEnvelope } from './helpers/runCli.js';
import { hasGit, gitIdentityEnv } from './helpers/git.js';

/**
 * Case (b): `tuck verify --exit-code` is the CI drift gate. A memfs unit test
 * that stubs process.exitCode cannot prove the flag actually gates end-to-end;
 * this spawns the real binary and reads the real exit code.
 */
describe('e2e: verify --exit-code CI gate', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 180_000);

  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(cleanupHome));
  });

  const setupTracked = async () => {
    const home = await makeHome();
    homes.push(home);
    const env = { ...gitIdentityEnv() };
    await seedHomeFile(home, '.vimrc', 'set number\n');
    const init = await runCli(['init', '--bare', '--json'], { home, env });
    expect(init.code).toBe(0);
    const add = await runCli(['add', join(home, '.vimrc'), '--json', '--yes'], { home, env });
    expect(add.code).toBe(0);
    return { home, env };
  };

  it('exits 0 when everything is in sync', async () => {
    if (!(await hasGit())) return;
    const { home, env } = await setupTracked();
    const r = await runCli(['verify', '--exit-code', '--json'], { home, env });
    expect(r.code).toBe(0);
    expect(parseEnvelope(r.stdout).ok).toBe(true);
  });

  it('exits 1 when the live file has drifted from the repo copy', async () => {
    if (!(await hasGit())) return;
    const { home, env } = await setupTracked();
    // Mutate the LIVE file so live ≠ repo ⇒ drift.
    await seedHomeFile(home, '.vimrc', 'set number\nset relativenumber\n');
    const r = await runCli(['verify', '--exit-code', '--json'], { home, env });
    expect(r.code).toBe(1); // the CI gate trips
    expect(parseEnvelope(r.stdout).ok).toBe(true); // verify itself succeeded; exit code carries drift
  });

  it('exits 0 on drift WITHOUT --exit-code (report-only mode)', async () => {
    if (!(await hasGit())) return;
    const { home, env } = await setupTracked();
    await seedHomeFile(home, '.vimrc', 'set number\nset relativenumber\n');
    const r = await runCli(['verify', '--json'], { home, env }); // no --exit-code
    expect(r.code).toBe(0); // reporting drift must not fail CI
  });
});
