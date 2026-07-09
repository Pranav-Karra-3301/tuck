import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { ensureBuilt } from './helpers/build.js';
import {
  runCli,
  makeHome,
  cleanupHome,
  seedHomeFile,
  readHomeFile,
  fileExists,
  parseEnvelope,
  homePath,
} from './helpers/runCli.js';
import { hasGit, gitIdentityEnv } from './helpers/git.js';

// Resolve git availability once (top-level await) so the commit-dependent cases
// below register as genuinely SKIPPED — not silently PASSED — when git is absent.
const gitAvailable = await hasGit();

/**
 * Case (a): the flagship lifecycle, end-to-end through the real binary —
 * init (local/bare, no network) → add → sync (commit, no push) → apply FROM the
 * local repo dir into a CLEAN home, asserting the dotfile re-materializes on disk.
 */
describe('e2e: init → add → sync → apply round-trip', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 180_000);

  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(cleanupHome));
  });

  it.skipIf(!gitAvailable)('tracks a dotfile, commits it, and re-materializes it on a clean machine', async () => {
    const src = await makeHome();
    homes.push(src);
    const env = { ...gitIdentityEnv() };

    await seedHomeFile(src, '.zshrc', 'export EDITOR=vim\n');

    const init = await runCli(['init', '--bare', '--json'], { home: src, env });
    expect(init.code).toBe(0);
    expect(parseEnvelope(init.stdout).ok).toBe(true);
    expect(await fileExists(homePath(src, '.tuck/.tuckmanifest.json'))).toBe(true);

    const add = await runCli(['add', join(src, '.zshrc'), '--json', '--yes'], { home: src, env });
    expect(add.code).toBe(0);
    expect(parseEnvelope(add.stdout)).toMatchObject({ ok: true, data: { added: 1 } });

    const sync = await runCli(['sync', '--json', '--no-push'], { home: src, env });
    expect(sync.code).toBe(0);
    const syncData = parseEnvelope(sync.stdout).data as { commitHash: string | null; noop: boolean };
    expect(syncData.commitHash).toBeTruthy(); // the initial add is committed (not a noop)
    expect(syncData.noop).toBe(false);

    // Clean machine: apply FROM the machine-1 repo dir (a local dir source ⇒ no network).
    const dst = await makeHome();
    homes.push(dst);
    const apply = await runCli(['apply', homePath(src, '.tuck'), '--json', '--force'], { home: dst, env });
    expect(apply.code).toBe(0);
    expect(parseEnvelope(apply.stdout)).toMatchObject({ ok: true, data: { applied: 1 } });

    // The load-bearing assertion: the file re-materialized into the new HOME.
    expect(await readHomeFile(dst, '.zshrc')).toBe('export EDITOR=vim\n');
  });

  it.skipIf(!gitAvailable)('apply is idempotent — a second apply changes nothing on disk (non-shell file)', async () => {
    const src = await makeHome();
    homes.push(src);
    const env = { ...gitIdentityEnv() };
    // A non-shell file: apply is a straight write (no smartMerge), so byte-identical
    // after the 2nd apply is a sound idempotency invariant.
    await seedHomeFile(src, '.gitconfig', '[user]\n  name = Ada\n');
    await runCli(['init', '--bare', '--json'], { home: src, env });
    await runCli(['add', join(src, '.gitconfig'), '--json', '--yes'], { home: src, env });
    await runCli(['sync', '--json', '--no-push'], { home: src, env });

    const dst = await makeHome();
    homes.push(dst);
    const repoDir = homePath(src, '.tuck');

    const first = await runCli(['apply', repoDir, '--json', '--force'], { home: dst, env });
    expect(first.code).toBe(0);
    const after1 = await readHomeFile(dst, '.gitconfig');

    const second = await runCli(['apply', repoDir, '--json', '--force'], { home: dst, env });
    expect(second.code).toBe(0); // a second apply still succeeds
    const after2 = await readHomeFile(dst, '.gitconfig');

    expect(after2).toBe(after1);
    expect(after2).toBe('[user]\n  name = Ada\n');
  });
});
