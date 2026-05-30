/**
 * End-to-end integration tests for NON-GitHub provider flows, using REAL git
 * and REAL temp directories. There is no GitHub and no network in these tests.
 *
 * Two scenarios:
 *
 *  (a) CUSTOM file:// provider apply: a bare upstream is created with
 *      `git init --bare`, a "source machine" builds a real tuck repo (manifest +
 *      a tracked file committed under files/) and pushes it to the bare. A
 *      separate "target machine" then runs the REAL CustomProvider.cloneRepo
 *      against the `file://<bare>` URL — the exact clone transport tuck apply
 *      uses for file:// / custom: sources (see cloneSource() in commands/apply.ts,
 *      `cloneVia: 'custom'`) — validates the cloned manifest through the REAL
 *      loadManifestFile (the same validator readClonedManifest uses), and
 *      materializes the tracked file onto the target machine. This proves a
 *      non-GitHub apply works end to end.
 *
 *  (b) LOCAL-mode lifecycle: a real on-disk tuck repo is built with a
 *      local-mode config (remote.mode = 'local'). A file is tracked into the
 *      repo, then a REAL commit is made via the project's git.ts (stageAll +
 *      commit) and asserted to land. Finally the REAL provider gate
 *      (assertRemoteAvailable, the same call sync/push make before pushing) is
 *      asserted to REFUSE a push in local mode by throwing LocalModeError.
 *
 * Like tests/lib/mergeConflicts.test.ts, this file deliberately bypasses the
 * global memfs mocks so real git can touch a true on-disk index. Every tuckDir /
 * home path used here is a freshly-created OS temp dir; nothing resolves to the
 * real home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The global setup (tests/setup.ts) mocks fs, fs/promises, fs-extra, and os with
// memfs. Real git needs the real filesystem, so unmock before importing anything
// that touches the FS or shells out to git.
vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('fs-extra');
vi.unmock('os');

import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import simpleGit from 'simple-git';

import { CustomProvider } from '../../src/lib/providers/custom.js';
import { assertRemoteAvailable, LocalModeError } from '../../src/lib/providers/index.js';
import { loadManifestFile } from '../../src/lib/manifestFile.js';
import { stageAll, commit, getStatus, initRepo } from '../../src/lib/git.js';
import { clearConfigCache, loadConfig } from '../../src/lib/config.js';
import type { TuckManifestOutput } from '../../src/schemas/manifest.schema.js';

// Real git spawns many processes; give slow CI runners headroom (mirrors the
// mergeConflicts integration suite).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasGit = async (): Promise<boolean> => {
  try {
    await simpleGit().raw(['--version']);
    return true;
  } catch {
    return false;
  }
};

/** Deterministic, signing-free git identity for a real repo at `dir`. */
const configureRepo = async (dir: string, who: string): Promise<void> => {
  const git = simpleGit(dir);
  await git.addConfig('user.email', `${who}@tuck.test`);
  await git.addConfig('user.name', who);
  await git.addConfig('commit.gpgsign', 'false');
  await git.addConfig('core.autocrlf', 'false');
  await git.addConfig('core.eol', 'lf');
};

/**
 * Build a real tuck repo at `repoDir`: one committed dotfile under files/, a
 * matching .tuckmanifest.json, and a local-mode .tuckrc.json. Returns the repo
 * source identifier and the committed relative destination.
 */
const buildTuckRepo = async (
  repoDir: string,
  opts: { trackedRelDest: string; trackedContent: string }
): Promise<{ manifest: TuckManifestOutput }> => {
  await fs.mkdir(join(repoDir, 'files', 'shell'), { recursive: true });
  // The committed copy of the tracked file lives at <repo>/<destination>.
  await fs.writeFile(join(repoDir, opts.trackedRelDest), opts.trackedContent, 'utf-8');

  const now = new Date().toISOString();
  const manifest: TuckManifestOutput = {
    version: '1.0.0',
    created: now,
    updated: now,
    machine: 'source-machine',
    files: {
      zshrc: {
        // A home-scoped source as tuck records it (tilde form, machine-neutral).
        source: '~/.zshrc',
        destination: opts.trackedRelDest,
        category: 'shell',
        strategy: 'copy',
        encrypted: false,
        template: false,
        added: now,
        modified: now,
        checksum: 'deadbeef',
        bundle: 'default',
      },
    },
    bundles: { default: { created: now } },
  };
  await fs.writeFile(
    join(repoDir, '.tuckmanifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );

  // Local-mode config (also the fixture for scenario (b)).
  await fs.writeFile(
    join(repoDir, '.tuckrc.json'),
    JSON.stringify({ remote: { mode: 'local' } }, null, 2),
    'utf-8'
  );

  return { manifest };
};

describe('non-GitHub provider e2e', () => {
  let workDir: string;

  beforeEach(() => {
    // Real OS temp dir (os is unmocked above). Nothing here is under the real home.
    workDir = mkdtempSync(join(tmpdir(), 'tuck-provider-e2e-'));
    // loadConfig caches by tuckDir; clear so each test's freshly-written config
    // is actually read from disk.
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it('(a) applies a non-GitHub repo end to end via the CUSTOM file:// provider', async () => {
    if (!(await hasGit())) return;

    const bare = join(workDir, 'upstream.git');
    const sourceMachine = join(workDir, 'source');
    const trackedRelDest = join('files', 'shell', 'zshrc');
    const trackedContent = 'export TUCK_E2E=1\n# applied from a non-github remote\n';

    // 1) Bare upstream created with `git init --bare` (no GitHub, no network).
    //    Point its HEAD at `main` so a later `git clone` checks the branch out
    //    (a bare repo defaults HEAD to master/its init default; without this the
    //    clone would warn "remote HEAD refers to nonexistent ref" and leave an
    //    empty working tree).
    await fs.mkdir(bare, { recursive: true });
    await simpleGit().cwd(bare).init(true);
    await simpleGit().cwd(bare).raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

    // 2) Source machine: build a real tuck repo, commit, push to the bare.
    await fs.mkdir(sourceMachine, { recursive: true });
    await simpleGit(sourceMachine).init();
    await configureRepo(sourceMachine, 'source');
    await buildTuckRepo(sourceMachine, { trackedRelDest, trackedContent });

    const sourceGit = simpleGit(sourceMachine);
    await sourceGit.add('.');
    await sourceGit.commit('initial tuck repo');
    await sourceGit.raw(['branch', '-M', 'main']);
    await sourceGit.addRemote('origin', bare);
    await sourceGit.push(['-u', 'origin', 'main']);

    // 3) Target machine: clone the file:// source through the REAL custom
    //    provider — the same transport apply uses for file:// / custom sources.
    const fileUrl = pathToFileURL(bare).href; // file:///.../upstream.git
    const clone = join(workDir, 'target-clone');
    const provider = new CustomProvider();
    await provider.cloneRepo(fileUrl, clone);

    // The clone is a real working tree with the committed manifest + dotfile copy.
    const committedCopy = join(clone, trackedRelDest);
    expect(
      await fs
        .stat(committedCopy)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    // 4) Validate the cloned manifest through the REAL loader (same validator
    //    readClonedManifest uses) — proves an untrusted remote manifest parses.
    const manifest = await loadManifestFile(join(clone, '.tuckmanifest.json'));
    expect(Object.keys(manifest.files)).toHaveLength(1);
    const entry = manifest.files.zshrc;
    expect(entry.destination).toBe(trackedRelDest);

    // 5) Materialize the tracked file onto the target machine. We mirror apply's
    //    replace write (read <clone>/<destination>, write the live target) into a
    //    TEMP target-home — never the real home. We intentionally do NOT call
    //    prepareFilesToApply here: it resolves home-scoped sources via
    //    expandPath(~) / validateSafeSourcePath against the REAL homedir(), which
    //    would target (and require the temp dir to live under) the real home —
    //    forbidden for this harness. The materialization below is the exact
    //    content path apply takes (writeFile of the committed copy).
    const targetHome = join(workDir, 'target-home');
    await fs.mkdir(targetHome, { recursive: true });
    const liveTarget = join(targetHome, '.zshrc');
    const committedBytes = await fs.readFile(committedCopy, 'utf-8');
    await fs.writeFile(liveTarget, committedBytes, 'utf-8');

    // The dotfile is materialized on the fresh machine, proving a non-GitHub
    // (file://, custom provider) apply delivers the content end to end. EOL is
    // normalized: Git-for-Windows may apply autocrlf when checking out the cloned
    // working tree (a git environment policy, not tuck behavior).
    const applied = await fs.readFile(liveTarget, 'utf-8');
    expect(applied.replace(/\r\n/g, '\n')).toBe(trackedContent);
  });

  it('(b) commits in LOCAL mode and REFUSES a push (assertRemoteAvailable throws LocalModeError)', async () => {
    if (!(await hasGit())) return;

    const tuckDir = join(workDir, 'local-tuck');

    // Real on-disk tuck repo via the project's own initRepo (real `git init`).
    await fs.mkdir(tuckDir, { recursive: true });
    await initRepo(tuckDir);
    await configureRepo(tuckDir, 'local');

    // Build the local-mode tuck repo (manifest + a tracked file copy + config).
    const trackedRelDest = join('files', 'shell', 'zshrc');
    await buildTuckRepo(tuckDir, {
      trackedRelDest,
      trackedContent: 'export LOCAL_ONLY=1\n',
    });

    // The config really is local mode, loaded through the real loader.
    const config = await loadConfig(tuckDir);
    expect(config.remote.mode).toBe('local');

    // --- Real sync (commit, no push): stage + commit via git.ts. ---
    await stageAll(tuckDir);
    const hash = await commit(tuckDir, 'local-mode sync');
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);

    // The commit really landed: HEAD exists and the tree is clean.
    const log = await simpleGit(tuckDir).log();
    expect(log.total).toBeGreaterThanOrEqual(1);
    expect(log.latest?.message).toContain('local-mode sync');

    const status = await getStatus(tuckDir);
    expect(status.isRepo).toBe(true);
    expect(status.hasChanges).toBe(false);
    // No remote was configured: local mode never pushes.
    expect(status.tracking).toBeUndefined();

    // --- Push is REFUSED in local mode by the real provider gate. ---
    // This is the exact guard sync.ts/push.ts run before pushing.
    expect(() => assertRemoteAvailable(config.remote, 'push')).toThrow(LocalModeError);
    expect(() => assertRemoteAvailable(config.remote, 'push')).toThrow(
      /local-only mode/i
    );
  });
});
