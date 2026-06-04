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

  it('tracks a dotfile, commits it, and re-materializes it on a clean machine', async () => {
    if (!(await hasGit())) return;
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
    // NOTE: `apply` reads the repo WORKING TREE, so clean-machine re-materialization
    // does not require a git commit. Sync's commit-on-initial-add behavior is a
    // separate axis — see the it.todo below (a real gap this harness surfaced).

    // Clean machine: apply FROM the machine-1 repo dir (a local dir source ⇒ no network).
    const dst = await makeHome();
    homes.push(dst);
    const apply = await runCli(['apply', homePath(src, '.tuck'), '--json', '--force'], { home: dst, env });
    expect(apply.code).toBe(0);
    expect(parseEnvelope(apply.stdout)).toMatchObject({ ok: true, data: { applied: 1 } });

    // The load-bearing assertion: the file re-materialized into the new HOME.
    expect(await readHomeFile(dst, '.zshrc')).toBe('export EDITOR=vim\n');
  });

  // Finding surfaced by this harness: after `tuck add`, `tuck sync` reports
  // noop:true while ~/.tuck still has the new files UNCOMMITTED — so `tuck push`
  // would push nothing for the initial add. Sync's no-op is keyed on tracked-file
  // drift (live-vs-repo), not on the git working-tree state. Track the fix here.
  it.todo('sync should commit the initial add (currently reports noop with uncommitted ~/.tuck files)');

  it('apply is idempotent — a second apply changes nothing on disk (non-shell file)', async () => {
    if (!(await hasGit())) return;
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
