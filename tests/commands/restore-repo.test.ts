/**
 * repo-aware restore unit tests (Step 9).
 *
 * A repo-scoped tracked file (scope:'repo') is identified by a stable
 * (repoKey, repoRelative) pair, NOT an absolute path. At restore time:
 *   - if the repoKey is BOUND on this machine, the live target is the bound
 *     root joined with repoRelative — restoring writes THERE (not under $HOME).
 *   - if the repoKey is UNBOUND, the file is SKIPPED (and surfaced as skipped),
 *     UNLESS --repo-root <dir> is given, in which case the key is bound first.
 *   - under --root (sandbox), a repo write rebases to <root>/repos/<key>/<rel>.
 *   - home-scoped restore is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const getTrackedFileBySourceMock = vi.fn();
const loadConfigMock = vi.fn();
const copyFileOrDirMock = vi.fn();
const createSymlinkMock = vi.fn();
const createBackupMock = vi.fn();
const runPreRestoreHookMock = vi.fn();
const runPostRestoreHookMock = vi.fn();
const restoreSecretsMock = vi.fn();
const getSecretCountMock = vi.fn();
const pathExistsMock = vi.fn();
const validateSafeSourcePathMock = vi.fn();
const validateSafeManifestDestinationMock = vi.fn();
const validatePathWithinRootMock = vi.fn();
const validateSafeRepoSourcePathMock = vi.fn();

const resolveLiveTargetMock = vi.fn();
const resolveRepoRootMock = vi.fn();
const bindRepoMock = vi.fn();
const loadReposRegistryMock = vi.fn();

const resolveWriteTargetMock = vi.fn();
const setKnownRepoRootsMock = vi.fn();

const loggerWarningMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    multiselect: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  },
  logger: {
    warning: loggerWarningMock,
    info: vi.fn(),
    success: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
  },
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/ui/theme.js', () => ({
  colors: {
    yellow: (x: string) => x,
    dim: (x: string) => x,
  },
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  pathExists: pathExistsMock,
  collapsePath: vi.fn((p: string) => p),
  validateSafeSourcePath: validateSafeSourcePathMock,
  validateSafeManifestDestination: validateSafeManifestDestinationMock,
  validatePathWithinRoot: validatePathWithinRootMock,
  validateSafeRepoSourcePath: validateSafeRepoSourcePathMock,
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
  getTrackedFileBySource: getTrackedFileBySourceMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/files.js', () => ({
  copyFileOrDir: copyFileOrDirMock,
  createSymlink: createSymlinkMock,
}));

vi.mock('../../src/lib/backup.js', () => ({
  createBackup: createBackupMock,
}));

vi.mock('../../src/lib/hooks.js', () => ({
  runPreRestoreHook: runPreRestoreHookMock,
  runPostRestoreHook: runPostRestoreHookMock,
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  restoreFiles: restoreSecretsMock,
  getSecretCount: getSecretCountMock,
}));

vi.mock('../../src/lib/repoScope.js', () => ({
  resolveLiveTarget: resolveLiveTargetMock,
  resolveRepoRoot: resolveRepoRootMock,
  bindRepo: bindRepoMock,
  loadReposRegistry: loadReposRegistryMock,
}));

vi.mock('../../src/lib/writeContext.js', () => ({
  resolveWriteTarget: resolveWriteTargetMock,
  setKnownRepoRoots: setKnownRepoRootsMock,
}));

describe('repo-aware restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    getAllTrackedFilesMock.mockResolvedValue({});
    getTrackedFileBySourceMock.mockResolvedValue(null);
    loadConfigMock.mockResolvedValue({
      files: { strategy: 'copy', backupOnRestore: false },
    });
    copyFileOrDirMock.mockResolvedValue(undefined);
    createSymlinkMock.mockResolvedValue(undefined);
    createBackupMock.mockResolvedValue(undefined);
    runPreRestoreHookMock.mockResolvedValue(undefined);
    runPostRestoreHookMock.mockResolvedValue(undefined);
    getSecretCountMock.mockResolvedValue(0);
    restoreSecretsMock.mockResolvedValue({ totalRestored: 0, allUnresolved: [] });
    pathExistsMock.mockResolvedValue(true);
    validateSafeSourcePathMock.mockImplementation(() => {});
    validateSafeManifestDestinationMock.mockImplementation(() => {});
    validatePathWithinRootMock.mockImplementation(() => {});
    validateSafeRepoSourcePathMock.mockImplementation(() => {});

    // Default write-target behavior: home maps under /test-home; repo writes
    // compose to <repoRoot>/<rel> (normal mode) — mirrors the real module.
    resolveWriteTargetMock.mockImplementation(
      (
        source: string,
        repo?: { repoKey: string; repoRelative: string; repoRoot: string }
      ) => {
        if (repo) return join(repo.repoRoot, repo.repoRelative);
        return source.replace(/^~\//, '/test-home/');
      }
    );
    setKnownRepoRootsMock.mockImplementation(() => {});

    resolveRepoRootMock.mockResolvedValue(null);
    bindRepoMock.mockResolvedValue(undefined);
    loadReposRegistryMock.mockResolvedValue({ version: '1', repos: {} });

    // Default: repo files are unbound (null); home files expand under /test-home.
    resolveLiveTargetMock.mockImplementation(async (file: { scope?: string; source: string }) => {
      if (file.scope === 'repo') return null;
      return file.source.replace(/^~\//, '/test-home/');
    });
  });

  it('restores a bound repo file to its bound root (not under $HOME)', async () => {
    const repoRoot = '/Users/somebody/work/myrepo';
    getAllTrackedFilesMock.mockResolvedValue({
      cfg: {
        source: 'myrepo-abc123:.config/app.toml',
        destination: 'files/repos/myrepo-abc123/.config/app.toml',
        category: 'misc',
        scope: 'repo',
        repoKey: 'myrepo-abc123',
        repoRelative: '.config/app.toml',
      },
    });
    // Key is bound to a concrete (out-of-home) root.
    resolveLiveTargetMock.mockResolvedValue(join(repoRoot, '.config/app.toml'));
    resolveRepoRootMock.mockResolvedValue(repoRoot);

    const { runRestore } = await import('../../src/commands/restore.js');
    await runRestore({ all: true, noHooks: true, noSecrets: true });

    // It must write to the bound repo root, NOT a home path.
    expect(copyFileOrDirMock).toHaveBeenCalledTimes(1);
    const dest = copyFileOrDirMock.mock.calls[0][1] as string;
    expect(dest).toBe(join(repoRoot, '.config/app.toml'));
    expect(dest.startsWith('/test-home/')).toBe(false);

    // The repo write must compose through resolveWriteTarget with the repo descriptor.
    expect(resolveWriteTargetMock).toHaveBeenCalledWith(
      'myrepo-abc123:.config/app.toml',
      expect.objectContaining({
        repoKey: 'myrepo-abc123',
        repoRelative: '.config/app.toml',
        repoRoot,
      })
    );
    // Repo files are validated with the repo-scoped validator, not the home one.
    expect(validateSafeRepoSourcePathMock).toHaveBeenCalledWith(repoRoot, '.config/app.toml');
  });

  it('skips an unbound repo file and reports it in the JSON envelope', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      cfg: {
        source: 'ghost-deadbeef:.config/app.toml',
        destination: 'files/repos/ghost-deadbeef/.config/app.toml',
        category: 'misc',
        scope: 'repo',
        repoKey: 'ghost-deadbeef',
        repoRelative: '.config/app.toml',
      },
    });
    // Unbound: live target resolves to null.
    resolveLiveTargetMock.mockResolvedValue(null);
    resolveRepoRootMock.mockResolvedValue(null);

    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runRestoreCommand } = await import('../../src/commands/restore.js');
    await runRestoreCommand([], { all: true, json: true, yes: true, noHooks: true, noSecrets: true });

    writeSpy.mockRestore();

    // Nothing was written to disk for the unbound repo file.
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
    expect(bindRepoMock).not.toHaveBeenCalled();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck restore');
    expect(env.data.restored).toBe(0);
    // The skipped repo file must be surfaced.
    expect(env.data.skipped).toContain('ghost-deadbeef:.config/app.toml');
    // The user should have been warned.
    expect(loggerWarningMock).toHaveBeenCalled();
  });

  it('binds an unbound repo to --repo-root and restores there', async () => {
    const repoRoot = '/tmp/fresh-checkout';
    getAllTrackedFilesMock.mockResolvedValue({
      cfg: {
        source: 'fresh-cafe:.config/app.toml',
        destination: 'files/repos/fresh-cafe/.config/app.toml',
        category: 'misc',
        scope: 'repo',
        repoKey: 'fresh-cafe',
        repoRelative: '.config/app.toml',
      },
    });
    // existsAtTarget probe (prepareFilesToRestore) — unbound for now.
    resolveLiveTargetMock.mockResolvedValue(null);
    // restoreFilesInternal: first resolveRepoRoot is unbound (null); after
    // bindRepo the second resolveRepoRoot returns the freshly-bound root.
    resolveRepoRootMock.mockResolvedValueOnce(null).mockResolvedValue(repoRoot);

    const { runRestore } = await import('../../src/commands/restore.js');
    await runRestore({
      all: true,
      noHooks: true,
      noSecrets: true,
      repoRoot,
    });

    // The unbound key was bound to --repo-root before resolving.
    expect(bindRepoMock).toHaveBeenCalledWith('fresh-cafe', repoRoot);

    // It then wrote into the freshly-bound root.
    expect(copyFileOrDirMock).toHaveBeenCalledTimes(1);
    const dest = copyFileOrDirMock.mock.calls[0][1] as string;
    expect(dest).toBe(join(repoRoot, '.config/app.toml'));

    // copyFileOrDir validates against allowedRoots(); restore must register the
    // new repo root via setKnownRepoRoots so an out-of-home dest is accepted.
    expect(setKnownRepoRootsMock).toHaveBeenCalled();
    const registered = setKnownRepoRootsMock.mock.calls.flatMap((c) => c[0] as string[]);
    expect(registered).toContain(repoRoot);
  });

  it('rebases a repo write under --root (sandbox) to <root>/repos/<key>/<rel>', async () => {
    const sandboxRoot = '/tmp/dryhome';
    // Simulate sandbox resolveWriteTarget: repo writes rebase by stable identity.
    resolveWriteTargetMock.mockImplementation(
      (
        _source: string,
        repo?: { repoKey: string; repoRelative: string; repoRoot: string }
      ) => {
        if (repo) return join(sandboxRoot, 'repos', repo.repoKey, repo.repoRelative);
        return join(sandboxRoot, _source.replace(/^~\//, ''));
      }
    );
    getAllTrackedFilesMock.mockResolvedValue({
      cfg: {
        source: 'myrepo-abc123:.config/app.toml',
        destination: 'files/repos/myrepo-abc123/.config/app.toml',
        category: 'misc',
        scope: 'repo',
        repoKey: 'myrepo-abc123',
        repoRelative: '.config/app.toml',
      },
    });
    resolveLiveTargetMock.mockResolvedValue('/Users/somebody/work/myrepo/.config/app.toml');
    resolveRepoRootMock.mockResolvedValue('/Users/somebody/work/myrepo');

    const { runRestore } = await import('../../src/commands/restore.js');
    await runRestore({ all: true, noHooks: true, noSecrets: true });

    expect(copyFileOrDirMock).toHaveBeenCalledTimes(1);
    const dest = copyFileOrDirMock.mock.calls[0][1] as string;
    expect(dest).toBe(join(sandboxRoot, 'repos', 'myrepo-abc123', '.config/app.toml'));
  });

  it('leaves home-scoped restore unchanged (uses validateSafeSourcePath + plain resolveWriteTarget)', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
      },
    });

    const { runRestore } = await import('../../src/commands/restore.js');
    await runRestore({ all: true, noHooks: true, noSecrets: true });

    expect(copyFileOrDirMock).toHaveBeenCalledTimes(1);
    const dest = copyFileOrDirMock.mock.calls[0][1] as string;
    expect(dest).toBe('/test-home/.zshrc');

    // Home files: validated with the home validator, written with no repo descriptor.
    expect(validateSafeSourcePathMock).toHaveBeenCalledWith('~/.zshrc');
    expect(resolveWriteTargetMock).toHaveBeenCalledWith('~/.zshrc');
    // The repo-scoped validator must NOT run for home files.
    expect(validateSafeRepoSourcePathMock).not.toHaveBeenCalled();
    expect(bindRepoMock).not.toHaveBeenCalled();
  });
});
