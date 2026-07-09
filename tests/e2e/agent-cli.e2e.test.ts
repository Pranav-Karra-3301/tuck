import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { ensureBuilt } from './helpers/build.js';
import { runCli, makeHome, cleanupHome, seedHomeFile, parseEnvelope } from './helpers/runCli.js';
import { hasGit, gitIdentityEnv } from './helpers/git.js';

/**
 * Agent-native CLI contract (IDEAS.md 1.3): every command must expose a
 * guaranteed non-interactive path, a stable JSON envelope, machine-readable
 * error codes, and no ANSI when output is not a terminal. A memfs unit test
 * cannot prove the real binary honors these end to end — this spawns it.
 */
describe('e2e: agent-native CLI contract', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 180_000);

  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(cleanupHome));
  });

  it('accepts --non-interactive as a global flag on any command', async () => {
    const home = await makeHome();
    homes.push(home);
    // Uninitialized home + bare status: the default dashboard action honors --json.
    const r = await runCli(['--non-interactive', '--json'], { home });
    expect(r.code).toBe(0);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ initialized: false });
  });

  it('fails fast with a typed JSON error when a prompt would be required', async () => {
    if (!(await hasGit())) return;
    const home = await makeHome();
    homes.push(home);
    const env = { ...gitIdentityEnv() };
    await seedHomeFile(home, '.vimrc', 'set number\n');
    const init = await runCli(['init', '--bare', '--json'], { home, env });
    expect(init.code).toBe(0);
    const add = await runCli(['add', join(home, '.vimrc'), '--json', '--yes'], { home, env });
    expect(add.code).toBe(0);

    // `tuck remove` with no path opens an interactive picker. Under --json /
    // non-TTY it must NOT hang — it must fail fast with a typed error envelope.
    const r = await runCli(['remove', '--json'], { home, env });
    expect(r.code).not.toBe(0);
    const parsed = parseEnvelope(r.stdout);
    expect(parsed.ok).toBe(false);
    expect((parsed.error as { code?: string }).code).toBe('OPERATION_CANCELLED');
  });

  it('emits no ANSI escape codes when stdout is not a TTY', async () => {
    const home = await makeHome();
    homes.push(home);
    // Clear the harness's NO_COLOR/FORCE_COLOR so suppression is driven purely by
    // tuck's own non-TTY detection (configureColor), not the ambient env.
    const r = await runCli([], { home, env: { NO_COLOR: '', FORCE_COLOR: '' } });
    expect(r.code).toBe(0);
    const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m');
    expect(ansi.test(r.stdout)).toBe(false);
    expect(ansi.test(r.stderr)).toBe(false);
  });
});
