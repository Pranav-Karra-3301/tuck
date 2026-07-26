/**
 * Integration tests for `src/lib/mergeConflicts.ts`.
 *
 * These tests build real git repos in a real temp directory because the
 * conflict detection / resolution helpers shell out to `git` via simple-git
 * and need a true on-disk index. The tests deliberately bypass the project's
 * global memfs mocks for fs / fs-extra by importing the real `node:fs`
 * primitives and using `os.tmpdir()` directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The global test setup (tests/setup.ts) mocks fs, fs/promises, and fs-extra
// with memfs. Real git operations need the real filesystem, so we unmock here
// before importing anything that touches the FS.
vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('fs-extra');
vi.unmock('os');

import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';

import {
  detectConflicts,
  applyResolution,
  continueRebase,
  abortRebase,
} from '../../src/lib/mergeConflicts.js';

// Every test builds real git repos and runs a real `pull --rebase` (~15 git
// process spawns). On slow CI runners — notably Windows + Node 18 — that
// legitimately exceeds Vitest's default 10s per-test timeout. These are
// environment-speed limits, not hangs, so raise the budget for this file.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Create two repos that share history, then diverge on the same file so a
 * `git pull --rebase` will produce a conflict on `conflict.txt`.
 *
 * Returns paths to the local clone (where the pull happens) and the bare
 * upstream that acts as `origin`.
 */
const buildConflictingRepos = async (
  root: string
): Promise<{ local: string; upstream: string }> => {
  const upstream = join(root, 'upstream.git');
  const seed = join(root, 'seed');
  const local = join(root, 'local');

  // Bare upstream repo serving as `origin`.
  await fs.mkdir(upstream, { recursive: true });
  await simpleGit().cwd(upstream).init(true);

  // Seed clone: write the initial file, commit, and push.
  await fs.mkdir(seed, { recursive: true });
  const seedGit = simpleGit(seed);
  await seedGit.init();
  await seedGit.addConfig('user.email', 'seed@tuck.test');
  await seedGit.addConfig('user.name', 'Seed');
  await seedGit.addConfig('commit.gpgsign', 'false');
  // Keep line endings as LF on every platform. Git for Windows defaults to
  // `core.autocrlf=true`, which would rewrite our `\n` test content to `\r\n`
  // on checkout and break the byte-for-byte content assertions below.
  await seedGit.addConfig('core.autocrlf', 'false');
  await seedGit.addConfig('core.eol', 'lf');
  await fs.writeFile(join(seed, 'conflict.txt'), 'base line\n', 'utf-8');
  await seedGit.add('conflict.txt');
  await seedGit.commit('base');
  await seedGit.addRemote('origin', upstream);
  // Force the branch name to `main` so behavior matches across git versions.
  await seedGit.raw(['branch', '-M', 'main']);
  await seedGit.push(['-u', 'origin', 'main']);

  // Local clone: change the file, commit.
  await simpleGit().clone(upstream, local);
  const localGit = simpleGit(local);
  await localGit.addConfig('user.email', 'local@tuck.test');
  await localGit.addConfig('user.name', 'Local');
  await localGit.addConfig('commit.gpgsign', 'false');
  // Match the seed repo: never translate LF <-> CRLF (see note above).
  await localGit.addConfig('core.autocrlf', 'false');
  await localGit.addConfig('core.eol', 'lf');
  await fs.writeFile(join(local, 'conflict.txt'), 'local change\n', 'utf-8');
  await localGit.add('conflict.txt');
  await localGit.commit('local change');

  // Back in seed: a divergent change to the same line, then push.
  await fs.writeFile(join(seed, 'conflict.txt'), 'remote change\n', 'utf-8');
  await seedGit.add('conflict.txt');
  await seedGit.commit('remote change');
  await seedGit.push();

  // Fetch from local so we know about the remote commit, then trigger the
  // conflicted rebase. The pull will fail; that's the state we want.
  await localGit.fetch('origin');
  try {
    await localGit.pull('origin', 'main', { '--rebase': null });
  } catch {
    // Expected — the rebase stops with a conflict.
  }

  return { local, upstream };
};

const hasGit = async (): Promise<boolean> => {
  try {
    await simpleGit().raw(['--version']);
    return true;
  } catch {
    return false;
  }
};

// Resolve git availability ONCE at module load (top-level await) so the tests
// can be marked skipped (visible in the reporter) rather than silently passing
// with zero assertions when git is missing — a green suite that asserted
// nothing would hide a total loss of coverage.
const gitAvailable = await hasGit();

describe('mergeConflicts', () => {
  let workDir: string;

  beforeEach(async () => {
    // Use the real OS temp dir; the global vi.mock('os') is unmocked above so
    // tmpdir() returns the real path.
    workDir = mkdtempSync(join(tmpdir(), 'tuck-merge-conflicts-'));
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; failure shouldn't fail the test.
    }
  });

  it.skipIf(!gitAvailable)('detects conflicts produced by a failed rebase', async () => {
    const { local } = await buildConflictingRepos(workDir);
    const conflicts = await detectConflicts(local);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toBe('conflict.txt');
    // tuck sync pulls with --rebase, which swaps git's internal stages (stage 2
    // is the remote tip, stage 3 the replayed local commit). detectConflicts
    // normalizes back to user-facing semantics, so `ours` must be the LOCAL edit
    // and `theirs` the REMOTE edit — picking "Keep local" must keep local.
    expect(conflicts[0].ours).toBe('local change\n');
    expect(conflicts[0].theirs).toBe('remote change\n');
    // `base` may or may not be present depending on the git version and the
    // shape of the conflict; when present it must reflect the shared ancestor.
    if (conflicts[0].base !== undefined) {
      expect(conflicts[0].base).toBe('base line\n');
    }
    expect(conflicts[0].oursDeleted).toBe(false);
    expect(conflicts[0].theirsDeleted).toBe(false);
  });

  it.skipIf(!gitAvailable)('applies an "ours" resolution and continues the rebase', async () => {
    const { local } = await buildConflictingRepos(workDir);
    const [conflict] = await detectConflicts(local);

    await applyResolution(local, { path: conflict.path, choice: 'ours' });
    await continueRebase(local);

    // After continuing, no conflicts remain and HEAD's content matches the
    // "ours" stage that we kept.
    const remaining = await detectConflicts(local);
    expect(remaining).toHaveLength(0);

    const content = await fs.readFile(join(local, 'conflict.txt'), 'utf-8');
    expect(content).toBe(conflict.ours);
  });

  it.skipIf(!gitAvailable)('applies a "theirs" resolution and continues the rebase', async () => {
    const { local } = await buildConflictingRepos(workDir);
    const [conflict] = await detectConflicts(local);

    await applyResolution(local, { path: conflict.path, choice: 'theirs' });
    await continueRebase(local);

    const remaining = await detectConflicts(local);
    expect(remaining).toHaveLength(0);

    const content = await fs.readFile(join(local, 'conflict.txt'), 'utf-8');
    expect(content).toBe(conflict.theirs);
  });

  it.skipIf(!gitAvailable)('applies an "edited" resolution that merges both sides', async () => {
    const { local } = await buildConflictingRepos(workDir);
    const [conflict] = await detectConflicts(local);

    const merged = `${conflict.ours.trim()} + ${conflict.theirs.trim()}\n`;
    await applyResolution(local, {
      path: conflict.path,
      choice: 'edited',
      finalContent: merged,
    });
    await continueRebase(local);

    const remaining = await detectConflicts(local);
    expect(remaining).toHaveLength(0);

    const content = await fs.readFile(join(local, 'conflict.txt'), 'utf-8');
    expect(content).toBe(merged);
  });

  it.skipIf(!gitAvailable)('aborts the rebase and restores the pre-pull HEAD', async () => {
    const { local } = await buildConflictingRepos(workDir);
    expect((await detectConflicts(local)).length).toBeGreaterThan(0);

    await abortRebase(local);

    const remaining = await detectConflicts(local);
    expect(remaining).toHaveLength(0);

    // After abort, HEAD is back to the local commit (i.e. "local change\n").
    const content = await fs.readFile(join(local, 'conflict.txt'), 'utf-8');
    expect(content).toBe('local change\n');
  });

  it.skipIf(!gitAvailable)('keeps the LOCAL edit when resolving "ours" under a rebase (no side inversion)', async () => {
    const { local } = await buildConflictingRepos(workDir);
    const [conflict] = await detectConflicts(local);

    // Picking "Keep local (ours)" must materialize the local edit, never the
    // remote one. This pins the rebase ours/theirs inversion regression.
    await applyResolution(local, { path: conflict.path, choice: 'ours' });
    await continueRebase(local);

    const content = await fs.readFile(join(local, 'conflict.txt'), 'utf-8');
    expect(content).toBe('local change\n');
  });

  it.skipIf(!gitAvailable)('resolves a modify/delete conflict by removing the file when the deleted side is kept', async () => {
    const upstream = join(workDir, 'md-upstream.git');
    const seed = join(workDir, 'md-seed');
    const local = join(workDir, 'md-local');

    await fs.mkdir(upstream, { recursive: true });
    await simpleGit().cwd(upstream).init(true);

    await fs.mkdir(seed, { recursive: true });
    const seedGit = simpleGit(seed);
    await seedGit.init();
    await seedGit.addConfig('user.email', 'seed@tuck.test');
    await seedGit.addConfig('user.name', 'Seed');
    await seedGit.addConfig('commit.gpgsign', 'false');
    await seedGit.addConfig('core.autocrlf', 'false');
    await seedGit.addConfig('core.eol', 'lf');
    await fs.writeFile(join(seed, 'f.txt'), 'base line\n', 'utf-8');
    await seedGit.add('f.txt');
    await seedGit.commit('base');
    await seedGit.addRemote('origin', upstream);
    await seedGit.raw(['branch', '-M', 'main']);
    await seedGit.push(['-u', 'origin', 'main']);

    // Local clone: delete the file.
    await simpleGit().clone(upstream, local);
    const localGit = simpleGit(local);
    await localGit.addConfig('user.email', 'local@tuck.test');
    await localGit.addConfig('user.name', 'Local');
    await localGit.addConfig('commit.gpgsign', 'false');
    await localGit.addConfig('core.autocrlf', 'false');
    await localGit.addConfig('core.eol', 'lf');
    // Ensure the working tree actually reflects origin/main (a freshly-init'd
    // bare repo's HEAD may not track our pushed branch on every git version).
    await localGit.reset(['--hard', 'origin/main']);
    await fs.rm(join(local, 'f.txt'));
    await localGit.add('f.txt');
    await localGit.commit('local delete');

    // Remote: modify the same file, then push.
    await fs.writeFile(join(seed, 'f.txt'), 'remote change\n', 'utf-8');
    await seedGit.add('f.txt');
    await seedGit.commit('remote modify');
    await seedGit.push();

    await localGit.fetch('origin');
    try {
      await localGit.pull('origin', 'main', { '--rebase': null });
    } catch {
      // Expected — modify/delete conflict.
    }

    const [conflict] = await detectConflicts(local);
    expect(conflict.path).toBe('f.txt');
    // From the user's perspective the LOCAL side deleted the file.
    expect(conflict.oursDeleted).toBe(true);
    expect(conflict.theirsDeleted).toBe(false);

    // Keeping local (the deletion) must not throw and must remove the file.
    await applyResolution(local, { path: conflict.path, choice: 'ours' });
    await continueRebase(local);

    expect((await detectConflicts(local))).toHaveLength(0);
    await expect(fs.access(join(local, 'f.txt'))).rejects.toBeTruthy();
  });

  it.skipIf(!gitAvailable)('detects and resolves a conflict on a unicode (C-quoted) filename', async () => {
    const fileName = 'résumé.txt';
    const upstream = join(workDir, 'uni-upstream.git');
    const seed = join(workDir, 'uni-seed');
    const local = join(workDir, 'uni-local');

    await fs.mkdir(upstream, { recursive: true });
    await simpleGit().cwd(upstream).init(true);

    await fs.mkdir(seed, { recursive: true });
    const seedGit = simpleGit(seed);
    await seedGit.init();
    await seedGit.addConfig('user.email', 'seed@tuck.test');
    await seedGit.addConfig('user.name', 'Seed');
    await seedGit.addConfig('commit.gpgsign', 'false');
    await seedGit.addConfig('core.autocrlf', 'false');
    await seedGit.addConfig('core.eol', 'lf');
    await fs.writeFile(join(seed, fileName), 'base line\n', 'utf-8');
    await seedGit.add(fileName);
    await seedGit.commit('base');
    await seedGit.addRemote('origin', upstream);
    await seedGit.raw(['branch', '-M', 'main']);
    await seedGit.push(['-u', 'origin', 'main']);

    await simpleGit().clone(upstream, local);
    const localGit = simpleGit(local);
    await localGit.addConfig('user.email', 'local@tuck.test');
    await localGit.addConfig('user.name', 'Local');
    await localGit.addConfig('commit.gpgsign', 'false');
    await localGit.addConfig('core.autocrlf', 'false');
    await localGit.addConfig('core.eol', 'lf');
    await fs.writeFile(join(local, fileName), 'local change\n', 'utf-8');
    await localGit.add(fileName);
    await localGit.commit('local change');

    await fs.writeFile(join(seed, fileName), 'remote change\n', 'utf-8');
    await seedGit.add(fileName);
    await seedGit.commit('remote change');
    await seedGit.push();

    await localGit.fetch('origin');
    try {
      await localGit.pull('origin', 'main', { '--rebase': null });
    } catch {
      // Expected.
    }

    const conflicts = await detectConflicts(local);
    expect(conflicts).toHaveLength(1);
    // The C-quoted porcelain path must be decoded back to the real filename.
    expect(conflicts[0].path).toBe(fileName);
    expect(conflicts[0].ours).toBe('local change\n');
    expect(conflicts[0].theirs).toBe('remote change\n');
    expect(conflicts[0].oursDeleted).toBe(false);
    expect(conflicts[0].theirsDeleted).toBe(false);

    // And the decoded path must be a valid pathspec for resolution.
    await applyResolution(local, { path: conflicts[0].path, choice: 'ours' });
    await continueRebase(local);
    const content = await fs.readFile(join(local, fileName), 'utf-8');
    expect(content).toBe('local change\n');
  });

  it.skipIf(!gitAvailable)('returns an empty list when no conflicts exist', async () => {
    const clean = join(workDir, 'clean');
    await fs.mkdir(clean, { recursive: true });
    const git = simpleGit(clean);
    await git.init();
    await git.addConfig('user.email', 'clean@tuck.test');
    await git.addConfig('user.name', 'Clean');
    await git.addConfig('commit.gpgsign', 'false');
    await git.addConfig('core.autocrlf', 'false');
    await git.addConfig('core.eol', 'lf');
    await fs.writeFile(join(clean, 'a.txt'), 'hello', 'utf-8');
    await git.add('a.txt');
    await git.commit('init');

    const conflicts = await detectConflicts(clean);
    expect(conflicts).toEqual([]);
  });
});
