import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { ensureBuilt } from './helpers/build.js';
import { runCli, makeHome, cleanupHome, parseEnvelope } from './helpers/runCli.js';
import { hasGit, gitIdentityEnv } from './helpers/git.js';

/**
 * Bare `tuck` (no subcommand) with global flags, end-to-end. The old argv
 * heuristic skipped Commander's parse for the default action, so `tuck --json`
 * printed the human dashboard and `tuck --root <dir>` printed help + exit 1.
 * Registering the default action on the root program fixes both.
 */
describe('e2e: bare tuck with global flags', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 180_000);

  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(cleanupHome));
  });

  it('emits a JSON status envelope for `tuck --json` in an initialized repo', async () => {
    if (!(await hasGit())) return;
    const home = await makeHome();
    homes.push(home);
    const env = { ...gitIdentityEnv() };

    const init = await runCli(['init', '--bare', '--json'], { home, env });
    expect(init.code).toBe(0);

    const res = await runCli(['--json'], { home, env });
    expect(res.code).toBe(0);
    const envelope = parseEnvelope(res.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('tuck');
    expect((envelope.data as { initialized?: boolean }).initialized).toBe(true);
  });

  it('emits a JSON envelope for `tuck --json` even before init (not human text)', async () => {
    const home = await makeHome();
    homes.push(home);

    const res = await runCli(['--json'], { home });
    expect(res.code).toBe(0);
    const envelope = parseEnvelope(res.stdout);
    expect(envelope.ok).toBe(true);
    expect((envelope.data as { initialized?: boolean }).initialized).toBe(false);
  });

  it('does not print help+exit-1 for `tuck --root <dir>` (runs the default action)', async () => {
    const home = await makeHome();
    homes.push(home);

    // Global --root is a valid option on the root program; a bare invocation
    // with it must run the status dashboard, not fail as an unknown command.
    const res = await runCli(['--root', home], { home, sandbox: false });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/Usage:/);
  });
});
