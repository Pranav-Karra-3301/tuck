import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { copyFileOrDir } from '../../src/lib/files.js';
import { assertRealTargetWithinRoots } from '../../src/commands/apply.js';
import { setWriteContext, resetWriteContext } from '../../src/lib/writeContext.js';

/**
 * Symlink TOCTOU defense on a REAL filesystem (the memfs unit suite cannot
 * exercise fs-extra's real copy or realpath). Two layers are verified:
 *   1. copyFileOrDir never RECREATES an in-tree symlink onto the live system, so
 *      a malicious repo directory entry cannot plant an escaping link.
 *   2. assertRealTargetWithinRoots refuses to write THROUGH a symlinked segment
 *      that resolves outside the allowed roots.
 */
describe('e2e: apply symlink escape defense (real fs)', () => {
  const bases: string[] = [];
  afterEach(async () => {
    resetWriteContext();
    await Promise.all(bases.splice(0).map((b) => rm(b, { recursive: true, force: true })));
  });

  const fileExists = async (p: string): Promise<boolean> => {
    try {
      await lstat(p);
      return true;
    } catch {
      return false;
    }
  };

  it('does not recreate an in-tree symlink when copying a tracked directory tree', async () => {
    if (platform === 'win32') return; // symlink creation is privileged on Windows
    const base = await mkdtemp(join(tmpdir(), 'tuck-symcopy-'));
    bases.push(base);

    // A malicious repo tree: a real file plus a symlink escaping to /outside.
    const srcTree = join(base, 'repoTree');
    await mkdir(srcTree, { recursive: true });
    await writeFile(join(srcTree, 'normal.txt'), 'ok\n');
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(srcTree, 'escape'));

    // Confine writes to `base` so copyFileOrDir's lexical destination check passes.
    setWriteContext({ root: base, isSandbox: true });
    const destTree = join(base, 'live', 'tree');
    await copyFileOrDir(srcTree, destTree, { overwrite: true });

    // The real file is materialized; the escaping symlink is NOT recreated.
    expect(await fileExists(join(destTree, 'normal.txt'))).toBe(true);
    expect(await fileExists(join(destTree, 'escape'))).toBe(false);
  });

  it('refuses a write that traverses a planted symlink escaping the allowed root', async () => {
    if (platform === 'win32') return;
    const base = await mkdtemp(join(tmpdir(), 'tuck-symguard-'));
    bases.push(base);

    const home = join(base, 'home');
    const outside = join(base, 'outside');
    await mkdir(home, { recursive: true });
    await mkdir(outside, { recursive: true });
    // Attacker plants home/link -> outside; home/link/pwned is lexically in-home.
    await symlink(outside, join(home, 'link'));

    await expect(
      assertRealTargetWithinRoots(join(home, 'link', 'pwned'), [home])
    ).rejects.toThrow(/symlinked path|outside the allowed roots/);

    // A normal in-home target with no symlinked segment is allowed.
    await expect(
      assertRealTargetWithinRoots(join(home, '.config', 'app', 'settings'), [home])
    ).resolves.toBeUndefined();
  });
});
