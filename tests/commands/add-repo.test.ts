/**
 * tuck add --repo (Step 8) integration tests.
 *
 * `tuck add --repo [dir]` tracks a file as REPO-scoped: it lives inside a git
 * repo whose absolute path differs per machine. The committed manifest entry
 * carries scope:'repo' + stable (repoKey, repoRelative) and NO absolute path;
 * the live copy is staged under files/repos/<key>/..., and the repo is bound in
 * the machine-local registry so it can be resolved later.
 *
 * These run against the global memfs sandbox (os.homedir() -> /test-home). The
 * "git repo" lives OUTSIDE that home (under /work) to prove repo-scoped tracking
 * is not home-confined. An explicit --repo-key is used so the derived key is
 * deterministic (the remote/first-commit derivation shells out to real git,
 * which the virtual repo has no answer for).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join, posix, resolve } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../utils/testHelpers.js';
import { initTestTuck } from '../utils/testHelpers.js';
import { addFilesFromPaths } from '../../src/commands/add.js';
import { loadManifest, clearManifestCache } from '../../src/lib/manifest.js';
import { resolveRepoRoot, getReposRegistryPath } from '../../src/lib/repoScope.js';
import { getRepoScopedDestination } from '../../src/lib/paths.js';

// Real git in this sandbox cannot inspect the virtual repo; the symlink/copy
// path and checksums all run against memfs already via the global setup.

const REPO_ROOT = '/work/myrepo';

const makeRepo = (): void => {
  // A git repo OUTSIDE the (mocked) home directory.
  vol.mkdirSync(join(REPO_ROOT, '.git'), { recursive: true });
  vol.writeFileSync(join(REPO_ROOT, '.git', 'HEAD'), 'ref: refs/heads/main');
  vol.mkdirSync(join(REPO_ROOT, 'config'), { recursive: true });
  vol.writeFileSync(join(REPO_ROOT, 'config', 'settings.toml'), 'theme = "dark"\n');
};

describe('tuck add --repo (repo-scoped tracking)', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    clearManifestCache();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('writes a repo-scoped manifest entry with correct repoKey/repoRelative', async () => {
    await initTestTuck();
    makeRepo();

    const count = await addFilesFromPaths([join(REPO_ROOT, 'config', 'settings.toml')], {
      repo: REPO_ROOT,
      repoKey: 'myrepo',
      force: true,
    });

    expect(count).toBe(1);

    const manifest = await loadManifest(TEST_TUCK_DIR);
    const entries = Object.values(manifest.files);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.scope).toBe('repo');
    expect(entry.repoKey).toBe('myrepo');
    expect(entry.repoRelative).toBe('config/settings.toml');
    expect(entry.strategy).toBe('copy');
    // source is the stable identity, never an absolute path.
    expect(entry.source).toBe('myrepo:config/settings.toml');
    expect(entry.source).not.toContain(REPO_ROOT);
  });

  it('stages the live file under files/repos/<key>/ in the tuck repo', async () => {
    await initTestTuck();
    makeRepo();

    await addFilesFromPaths([join(REPO_ROOT, 'config', 'settings.toml')], {
      repo: REPO_ROOT,
      repoKey: 'myrepo',
      force: true,
    });

    const manifest = await loadManifest(TEST_TUCK_DIR);
    const entry = Object.values(manifest.files)[0];

    const expectedDest = getRepoScopedDestination('myrepo', 'config/settings.toml');
    expect(entry.destination).toBe(expectedDest);
    expect(entry.destination.startsWith('files/repos/')).toBe(true);

    // The file content was actually copied into the tuck repo.
    const copiedPath = join(TEST_TUCK_DIR, entry.destination);
    expect(vol.existsSync(copiedPath)).toBe(true);
    expect(vol.readFileSync(copiedPath, 'utf-8')).toBe('theme = "dark"\n');
  });

  it('binds the repoKey to the repo root in the machine-local registry', async () => {
    await initTestTuck();
    makeRepo();

    await addFilesFromPaths([join(REPO_ROOT, 'config', 'settings.toml')], {
      repo: REPO_ROOT,
      repoKey: 'myrepo',
      force: true,
    });

    // The off-repo registry now resolves the key back to the live root.
    // bindRepo stores resolve(root), which is OS-native (drive-prefixed on
    // Windows), so build the expected value with the same path API.
    expect(await resolveRepoRoot('myrepo')).toBe(resolve(REPO_ROOT));
    // ...and it lives off-repo, not inside ~/.tuck.
    expect(getReposRegistryPath()).not.toContain('/.tuck/');
    expect(vol.existsSync(getReposRegistryPath())).toBe(true);
  });

  it('auto-detects the enclosing git root when --repo is given without a dir', async () => {
    await initTestTuck();
    makeRepo();

    // Pass the path to a file nested under the repo; --repo with no dir means
    // "treat as repo-scoped, find the enclosing git root from the path".
    const count = await addFilesFromPaths([join(REPO_ROOT, 'config', 'settings.toml')], {
      repo: true,
      repoKey: 'autorepo',
      force: true,
    });

    expect(count).toBe(1);
    const manifest = await loadManifest(TEST_TUCK_DIR);
    const entry = Object.values(manifest.files)[0];
    expect(entry.scope).toBe('repo');
    expect(entry.repoKey).toBe('autorepo');
    expect(entry.repoRelative).toBe('config/settings.toml');
    expect(await resolveRepoRoot('autorepo')).toBe(resolve(REPO_ROOT));
  });

  it('rejects --symlink combined with --repo (repo scope is copy-only)', async () => {
    await initTestTuck();
    makeRepo();

    await expect(
      addFilesFromPaths([join(REPO_ROOT, 'config', 'settings.toml')], {
        repo: REPO_ROOT,
        repoKey: 'myrepo',
        symlink: true,
        force: true,
      })
    ).rejects.toThrow(/--symlink cannot be combined with --repo/);

    // Nothing was tracked or bound.
    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(Object.keys(manifest.files)).toHaveLength(0);
    expect(await resolveRepoRoot('myrepo')).toBeNull();
  });

  it('leaves home-scoped add unchanged (no scope/repo fields) when --repo is absent', async () => {
    await initTestTuck();
    vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'export PATH=$PATH\n');

    const count = await addFilesFromPaths(['~/.zshrc'], { force: true });
    expect(count).toBe(1);

    const manifest = await loadManifest(TEST_TUCK_DIR);
    const entry = Object.values(manifest.files)[0];
    expect(entry.scope).toBeUndefined();
    expect(entry.repoKey).toBeUndefined();
    expect(entry.repoRelative).toBeUndefined();
    expect(entry.source).toBe('~/.zshrc');
    // Home dest is under files/<category>/, never files/repos/.
    expect(entry.destination.startsWith('files/repos/')).toBe(false);
  });

  it('persists a manifest that re-parses against the schema (repo superRefine)', async () => {
    await initTestTuck();
    makeRepo();

    await addFilesFromPaths([join(REPO_ROOT, 'config', 'settings.toml')], {
      repo: REPO_ROOT,
      repoKey: 'myrepo',
      force: true,
    });

    // loadManifest re-validates with the zod schema; a missing repoKey or an
    // unsafe repoRelative would throw here.
    const raw = vol.readFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), 'utf-8') as string;
    const parsed = JSON.parse(raw);
    const stored = Object.values(parsed.files)[0] as Record<string, unknown>;
    expect(stored.scope).toBe('repo');
    expect(stored.repoRelative).toBe(posix.normalize('config/settings.toml'));
    expect(stored.repoKey).toBe('myrepo');
  });
});
