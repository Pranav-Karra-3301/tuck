import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { vol } from 'memfs';
import { NotInitializedError, SecretsDetectedError } from '../../src/errors.js';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const updateFileInManifestMock = vi.fn();
const removeFileFromManifestMock = vi.fn();
const getTrackedFileBySourceMock = vi.fn();
const pathExistsMock = vi.fn();
const copyFileOrDirMock = vi.fn();
const getFileChecksumMock = vi.fn();
const deleteFileOrDirMock = vi.fn();
const loadTuckignoreMock = vi.fn();
const isIgnoredMock = vi.fn();
const validateSafeSourcePathMock = vi.fn();
const validateSafeManifestDestinationMock = vi.fn();
const validatePathWithinRootMock = vi.fn();
const resolveLiveTargetMock = vi.fn();
const runPreSyncHookMock = vi.fn();
const runPostSyncHookMock = vi.fn();
const stageAllMock = vi.fn();
const commitMock = vi.fn();
const hasRemoteMock = vi.fn();
const pushMock = vi.fn();
const loggerInfoMock = vi.fn();
const getStatusMock = vi.fn();
const checkFileSizeThresholdMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    confirmDangerous: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('abort'),
    multiselect: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
  },
  logger: {
    info: loggerInfoMock,
    warning: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    file: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    dim: vi.fn(),
  },
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  // The interactive flow styles output with c.bold/c.yellow/c.red/c.cyan/c.dim —
  // a Proxy keeps every color an identity passthrough.
  colors: new Proxy({}, { get: () => (x: string) => x }),
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  pathExists: pathExistsMock,
  collapsePath: vi.fn((p: string) => p),
  getDestinationPathFromSource: vi.fn(
    (tuckDir: string, category: string, sourcePath: string) =>
      `${tuckDir}/files/${category}/${String(sourcePath).replace(/^~\//, '')}`
  ),
  detectCategory: vi.fn(() => 'misc'),
  sanitizeFilename: vi.fn((path: string) => path.split('/').pop() || 'file'),
  isDirectory: vi.fn().mockResolvedValue(false),
  validateSafeSourcePath: validateSafeSourcePathMock,
  validateSafeManifestDestination: validateSafeManifestDestinationMock,
  validatePathWithinRoot: validatePathWithinRootMock,
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
  updateFileInManifest: updateFileInManifestMock,
  removeFileFromManifest: removeFileFromManifestMock,
  getTrackedFileBySource: getTrackedFileBySourceMock,
}));

vi.mock('../../src/lib/repoScope.js', () => ({
  resolveLiveTarget: resolveLiveTargetMock,
}));

vi.mock('../../src/lib/git.js', () => ({
  stageAll: stageAllMock,
  commit: commitMock,
  getStatus: getStatusMock,
  push: pushMock,
  hasRemote: hasRemoteMock,
  fetch: vi.fn(),
  pull: vi.fn(),
}));

vi.mock('../../src/lib/files.js', () => ({
  copyFileOrDir: copyFileOrDirMock,
  getFileChecksum: getFileChecksumMock,
  deleteFileOrDir: deleteFileOrDirMock,
  checkFileSizeThreshold: checkFileSizeThresholdMock,
  formatFileSize: vi.fn((n: number) => `${n} B`),
  SIZE_BLOCK_THRESHOLD: 100 * 1024 * 1024,
}));

vi.mock('../../src/lib/tuckignore.js', () => ({
  addToTuckignore: vi.fn(),
  loadTuckignore: loadTuckignoreMock,
  isIgnored: isIgnoredMock,
}));

vi.mock('../../src/lib/hooks.js', () => ({
  runPreSyncHook: runPreSyncHookMock,
  runPostSyncHook: runPostSyncHookMock,
}));

vi.mock('../../src/lib/detect.js', () => ({
  detectDotfiles: vi.fn().mockResolvedValue([]),
  DETECTION_CATEGORIES: {},
}));

vi.mock('../../src/lib/fileTracking.js', () => ({
  trackFilesWithProgress: vi.fn().mockResolvedValue({
    succeeded: 0,
    failed: 0,
    errors: [],
    sensitiveFiles: [],
  }),
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  scanForSecrets: vi.fn().mockResolvedValue({ totalSecrets: 0, results: [] }),
  isSecretScanningEnabled: vi.fn().mockResolvedValue(false),
  shouldBlockOnSecrets: vi.fn().mockResolvedValue(true),
  processSecretsForRedaction: vi.fn(),
  redactFile: vi.fn(),
  // detectChanges loads the stored-secret value map once per run (#100). An
  // empty map keeps the raw-checksum fast path (existing behavior).
  getStoredValueMap: vi.fn().mockResolvedValue(new Map()),
  getRedactedChecksum: vi.fn(),
}));

vi.mock('../../src/commands/secrets.js', () => ({
  displayScanResults: vi.fn(),
}));

vi.mock('../../src/lib/audit.js', () => ({
  logForceSecretBypass: vi.fn(),
}));

const createSnapshotMock = vi.fn();
vi.mock('../../src/lib/timemachine.js', () => ({
  createSnapshot: createSnapshotMock,
}));

const checkLocalModeMock = vi.fn();
vi.mock('../../src/lib/remoteChecks.js', () => ({
  checkLocalMode: checkLocalModeMock,
}));

// sync.ts loads config and consults the provider gate before pushing. Mock both
// so these tests exercise the (non-local) happy path without touching real config.
const loadConfigMock = vi.fn();
const assertRemoteAvailableMock = vi.fn();
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));
vi.mock('../../src/lib/providers/index.js', () => ({
  assertRemoteAvailable: assertRemoteAvailableMock,
}));

describe('sync command behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadConfigMock.mockResolvedValue({ remote: { mode: 'github' } });
    assertRemoteAvailableMock.mockImplementation(() => {});
    loadManifestMock.mockResolvedValue({ files: {} });
    loadTuckignoreMock.mockResolvedValue(new Set());
    getAllTrackedFilesMock.mockResolvedValue({});
    pathExistsMock.mockResolvedValue(true);
    isIgnoredMock.mockResolvedValue(false);
    getFileChecksumMock.mockResolvedValue('new-checksum');
    checkFileSizeThresholdMock.mockResolvedValue({ warn: false, block: false, size: 10 });
    hasRemoteMock.mockResolvedValue(false);
    commitMock.mockResolvedValue('abc123def456');
    // Default: a clean working tree (no uncommitted changes). Tests that need a
    // dirty tree (e.g. the initial-add commit) override hasChanges per-test.
    getStatusMock.mockResolvedValue({ behind: 0, hasChanges: false });
    checkLocalModeMock.mockResolvedValue(false);
    validateSafeSourcePathMock.mockImplementation(() => {});
    validateSafeManifestDestinationMock.mockImplementation(() => {});
    validatePathWithinRootMock.mockImplementation(() => {});
    // Default: home-scoped files resolve their live path exactly like expandPath.
    resolveLiveTargetMock.mockImplementation(async (file: { scope?: string; source: string }) =>
      file.source.replace(/^~\//, '/test-home/')
    );
  });

  it('throws NotInitializedError when manifest is missing', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));
    const { runSync } = await import('../../src/commands/sync.js');

    await expect(runSync()).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('logs no changes when tracked files are unchanged', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        checksum: 'same',
      },
    });
    getFileChecksumMock.mockResolvedValue('same');
    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await runSyncCommand('sync: noop', { noCommit: true, noHooks: true, scan: false, pull: false });

    expect(loggerInfoMock).toHaveBeenCalledWith('No changes detected');
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
  });

  it('does not capture template/encrypted files live->repo (no clobber/leak)', async () => {
    // Both files' live copies differ from the recorded checksum — they WOULD be
    // captured as 'modified' if they were not one-directional.
    getAllTrackedFilesMock.mockResolvedValue({
      gitconfig: {
        source: '~/.gitconfig',
        destination: 'files/git/gitconfig',
        checksum: 'old',
        template: true,
        encrypted: false,
      },
      netrc: {
        source: '~/.netrc',
        destination: 'files/shell/netrc',
        checksum: 'old',
        template: false,
        encrypted: true,
      },
    });
    getFileChecksumMock.mockResolvedValue('new');
    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await runSyncCommand('sync: should-skip', {
      noCommit: true,
      noHooks: true,
      scan: false,
      pull: false,
    });

    // The template source is never overwritten; no plaintext is written for the
    // encrypted file; nothing is detected as a change.
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
    expect(updateFileInManifestMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith('No changes detected');
  });

  it('syncs modified files and updates manifest when changes exist', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        checksum: 'old',
      },
    });
    getFileChecksumMock.mockResolvedValue('new');
    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await runSyncCommand('sync: update', { noCommit: true, noHooks: true, scan: false, pull: false });

    expect(copyFileOrDirMock).toHaveBeenCalledTimes(1);
    expect(updateFileInManifestMock).toHaveBeenCalledTimes(1);
    expect(validatePathWithinRootMock).toHaveBeenCalledWith(
      join('/test-home/.tuck', 'files', 'shell', 'zshrc'),
      '/test-home/.tuck',
      'sync destination'
    );
    expect(stageAllMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('commits pending repo changes even when no tracked file drifted (the initial add)', async () => {
    // No tracked-file DRIFT (live == repo) ...
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'same' },
    });
    getFileChecksumMock.mockResolvedValue('same'); // ⇒ detectChanges() is empty
    // ... but the working tree HAS uncommitted changes (what `tuck add` leaves).
    getStatusMock.mockResolvedValue({
      behind: 0,
      hasChanges: true,
      staged: [],
      modified: [],
      untracked: ['files/shell/zshrc', '.tuckmanifest.json'],
    });
    commitMock.mockResolvedValue('deadbeefcafe');

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, {
      json: true,
      noHooks: true,
      scan: false,
      pull: false,
      push: false,
    } as never);

    // The initial add must be committed, not reported as a no-op.
    expect(stageAllMock).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('does not push in local-only mode even when a git remote exists', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new');
    hasRemoteMock.mockResolvedValue(true); // a stray remote is present
    checkLocalModeMock.mockResolvedValue(true); // ...but config is local-only mode

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { yes: true, noHooks: true, pull: false } as never);

    // Committed locally, but NOT pushed (local mode is authoritative over the
    // mere presence of an origin remote).
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('emits a noop JSON envelope when sync --json has nothing to do', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'same' },
    });
    getFileChecksumMock.mockResolvedValue('same'); // unchanged

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, pull: false, noHooks: true } as never);

    writeSpy.mockRestore();
    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck sync');
    expect(env.data.noop).toBe(true);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('blocks the non-interactive (--yes/--json) sync when modified files contain secrets', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new');

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 1,
      results: [{ path: '~/.zshrc' }],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);
    vi.mocked(secrets.shouldBlockOnSecrets).mockResolvedValue(true);

    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await expect(
      runSyncCommand(undefined, { yes: true, noHooks: true, pull: false } as never)
    ).rejects.toBeInstanceOf(SecretsDetectedError);

    // The secret must be caught BEFORE anything is committed or pushed.
    expect(commitMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('records a force-bypass audit entry when --yes --force skips scanning', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new');

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);

    const audit = await import('../../src/lib/audit.js');
    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await runSyncCommand(undefined, { yes: true, force: true, noHooks: true, pull: false } as never);

    expect(vi.mocked(audit.logForceSecretBypass)).toHaveBeenCalled();
    expect(vi.mocked(secrets.scanForSecrets)).not.toHaveBeenCalled();
  });

  it('emits a sorted success JSON envelope after a real --json sync', async () => {
    // Two modified files in non-alphabetical iteration order so the .sort() in
    // the success envelope is observable.
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
      bashrc: { source: '~/.bashrc', destination: 'files/shell/bashrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new'); // both differ -> both modified
    hasRemoteMock.mockResolvedValue(true);
    checkLocalModeMock.mockResolvedValue(false);
    pushMock.mockResolvedValue(undefined);
    commitMock.mockResolvedValue('deadbeefcafef00d');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, pull: false, noHooks: true } as never);

    writeSpy.mockRestore();
    const env = JSON.parse(writes.join('').trim());

    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck sync');
    expect(env.data.noop).toBe(false);
    expect(env.data.commitHash).toBe('deadbeefcafef00d');
    // basename of each source, alphabetically sorted by the .sort() call.
    expect(env.data.modified).toEqual(['.bashrc', '.zshrc']);
    expect(env.data.deleted).toEqual([]);
    // No pushError key on the clean-push success path.
    expect(env.data).not.toHaveProperty('pushError');
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('emits a pushError JSON envelope when the push fails after a committed --json sync', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new');
    hasRemoteMock.mockResolvedValue(true);
    checkLocalModeMock.mockResolvedValue(false);
    commitMock.mockResolvedValue('feedface00112233');
    pushMock.mockRejectedValue(new Error('remote rejected: non-fast-forward'));

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    // The push error must NOT bubble out of the JSON path; it is reported in
    // the envelope instead.
    await runSyncCommand(undefined, { json: true, pull: false, noHooks: true } as never);

    writeSpy.mockRestore();
    const env = JSON.parse(writes.join('').trim());

    expect(env.ok).toBe(true); // still ok=true; commit succeeded, only push failed
    expect(env.data.noop).toBe(false);
    expect(env.data.commitHash).toBe('feedface00112233');
    expect(env.data.modified).toEqual(['.zshrc']);
    expect(env.data.pushError).toBe('remote rejected: non-fast-forward');
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('warns but still commits in --json mode when secrets are found and blockOnSecrets is disabled', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new');
    hasRemoteMock.mockResolvedValue(false); // no push, isolate commit behavior
    commitMock.mockResolvedValue('1234567890abcdef');

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 2,
      results: [{ path: '~/.zshrc' }],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);
    vi.mocked(secrets.shouldBlockOnSecrets).mockResolvedValue(false); // disabled -> warn, proceed

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, pull: false, noHooks: true } as never);

    writeSpy.mockRestore();
    const env = JSON.parse(writes.join('').trim());

    // Did not throw, committed normally...
    expect(env.ok).toBe(true);
    expect(env.data.noop).toBe(false);
    expect(env.data.commitHash).toBe('1234567890abcdef');
    expect(commitMock).toHaveBeenCalledTimes(1);
    // ...and surfaced a structured warning instead of human-readable output.
    expect(Array.isArray(env.warnings)).toBe(true);
    expect(env.warnings.some((w: string) => w.includes('blockOnSecrets is disabled'))).toBe(true);
    expect(env.warnings.some((w: string) => w.includes('2 potential secret'))).toBe(true);
  });

  it('warns via logger but still commits in --yes mode when blockOnSecrets is disabled', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new');
    hasRemoteMock.mockResolvedValue(false);
    commitMock.mockResolvedValue('abcabcabcabcabc1');

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 1,
      results: [{ path: '~/.zshrc' }],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);
    vi.mocked(secrets.shouldBlockOnSecrets).mockResolvedValue(false);

    const ui = await import('../../src/ui/index.js');
    const { runSyncCommand } = await import('../../src/commands/sync.js');

    // Does not throw despite secrets present, because blocking is disabled.
    await runSyncCommand(undefined, { yes: true, noHooks: true, pull: false } as never);

    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ui.logger.warning)).toHaveBeenCalledWith(
      'Secrets detected but blockOnSecrets is disabled - proceeding with sync'
    );
    // The scan ran (not bypassed) because --force was NOT passed.
    expect(vi.mocked(secrets.scanForSecrets)).toHaveBeenCalledTimes(1);
  });

  it('records a JSON force-bypass warning and skips scanning under --json --force', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new');
    hasRemoteMock.mockResolvedValue(false);
    commitMock.mockResolvedValue('0f0f0f0f0f0f0f0f');

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);

    const audit = await import('../../src/lib/audit.js');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, force: true, noHooks: true, pull: false } as never);

    writeSpy.mockRestore();
    const env = JSON.parse(writes.join('').trim());

    expect(env.ok).toBe(true);
    expect(env.data.noop).toBe(false);
    expect(env.data.commitHash).toBe('0f0f0f0f0f0f0f0f');
    // Scan skipped entirely; audit entry recorded with the JSON command label.
    expect(vi.mocked(secrets.scanForSecrets)).not.toHaveBeenCalled();
    expect(vi.mocked(audit.logForceSecretBypass)).toHaveBeenCalledWith('tuck sync --json --force', 1);
    // Force-bypass surfaced as a structured warning.
    expect(Array.isArray(env.warnings)).toBe(true);
    expect(env.warnings.some((w: string) => w.includes('bypassed via --force'))).toBe(true);
  });

  it('skips an unbound repo-scoped file instead of reporting it as deleted', async () => {
    // A repo-scoped entry whose repo is NOT bound on this machine. resolveLiveTarget
    // returns null, so detectChanges cannot read it. The CRITICAL regression to
    // avoid: it must be SKIPPED, never reported as 'deleted' (which would delete
    // the committed copy and drop it from the manifest).
    getAllTrackedFilesMock.mockResolvedValue({
      repofile: {
        source: 'somekey-abcd1234:config/app.toml',
        destination: 'files/repos/somekey-abcd1234/config/app.toml',
        checksum: 'old',
        scope: 'repo',
        repoKey: 'somekey-abcd1234',
        repoRelative: 'config/app.toml',
      },
    });
    // Unbound repo → live target unresolvable.
    resolveLiveTargetMock.mockResolvedValue(null);

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, pull: false, noHooks: true } as never);

    // Nothing to do — and crucially nothing deleted.
    expect(deleteFileOrDirMock).not.toHaveBeenCalled();
    expect(removeFileFromManifestMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('emits a noop JSON envelope (no deletions) when the only tracked file is an unbound repo entry', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      repofile: {
        source: 'somekey-abcd1234:config/app.toml',
        destination: 'files/repos/somekey-abcd1234/config/app.toml',
        checksum: 'old',
        scope: 'repo',
        repoKey: 'somekey-abcd1234',
        repoRelative: 'config/app.toml',
      },
    });
    resolveLiveTargetMock.mockResolvedValue(null);

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, pull: false, noHooks: true } as never);

    writeSpy.mockRestore();
    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.data.noop).toBe(true);
    expect(env.data.deleted).toEqual([]);
    expect(deleteFileOrDirMock).not.toHaveBeenCalled();
  });

  it('detects a BOUND repo-scoped file via its resolved live target, not expandPath', async () => {
    // A repo-scoped entry bound to an out-of-home checkout. detectChanges must
    // resolve the live path via resolveLiveTarget (NOT expandPath(source), which
    // would mangle a "key:rel" source) and compare checksums against it.
    getAllTrackedFilesMock.mockResolvedValue({
      repofile: {
        source: 'somekey-abcd1234:config/app.toml',
        destination: 'files/repos/somekey-abcd1234/config/app.toml',
        checksum: 'old',
        scope: 'repo',
        repoKey: 'somekey-abcd1234',
        repoRelative: 'config/app.toml',
      },
    });
    const liveRepoPath = '/work/myrepo/config/app.toml';
    resolveLiveTargetMock.mockResolvedValue(liveRepoPath);
    pathExistsMock.mockResolvedValue(true);
    getFileChecksumMock.mockResolvedValue('new'); // differs from 'old' → modified

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand('sync: repo change', {
      noCommit: true,
      noHooks: true,
      scan: false,
      pull: false,
    });

    // The checksum was read from the RESOLVED live path, proving resolveLiveTarget
    // (not expandPath of "somekey-...:config/app.toml") drove change detection.
    expect(getFileChecksumMock).toHaveBeenCalledWith(liveRepoPath);
    expect(copyFileOrDirMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when manifest destination is unsafe', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: '../../outside',
        checksum: 'old',
      },
    });
    validateSafeManifestDestinationMock.mockImplementationOnce(() => {
      throw new Error('Unsafe manifest destination detected');
    });
    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await expect(
      runSyncCommand('sync: unsafe manifest', { noCommit: true, noHooks: true, scan: false, pull: false })
    ).rejects.toThrow('Unsafe manifest destination detected');
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
  });

  it('mirrors a modified tracked directory by clearing the repo copy before copying', async () => {
    // A deletion inside a tracked directory must propagate to the repo. fs-extra
    // copy only MERGES, so syncFiles must wipe the destination tree first.
    getAllTrackedFilesMock.mockResolvedValue({
      nvim: { source: '~/.config/nvim', destination: 'files/editors/nvim', checksum: 'old' },
    });
    getFileChecksumMock.mockResolvedValue('new'); // dir drifted → modified

    const paths = await import('../../src/lib/paths.js');
    vi.mocked(paths.isDirectory).mockResolvedValue(true);

    try {
      const { runSyncCommand } = await import('../../src/commands/sync.js');
      await runSyncCommand('sync: dir mirror', {
        noCommit: true,
        noHooks: true,
        scan: false,
        pull: false,
      });

      const destPath = join('/test-home/.tuck', 'files', 'editors', 'nvim');
      // The repo copy is cleared, then the live tree is copied fresh — an exact
      // mirror, so files deleted from the source vanish from the repo too.
      expect(deleteFileOrDirMock).toHaveBeenCalledWith(destPath);
      expect(copyFileOrDirMock).toHaveBeenCalledWith('/test-home/.config/nvim', destPath, {
        overwrite: true,
      });
      expect(deleteFileOrDirMock.mock.invocationCallOrder[0]).toBeLessThan(
        copyFileOrDirMock.mock.invocationCallOrder[0]
      );
    } finally {
      // Restore the shared default so later tests see a non-directory source.
      vi.mocked(paths.isDirectory).mockResolvedValue(false);
    }
  });

  it('snapshots the repo copy before deleting a vanished tracked file', async () => {
    // The live source is gone; the repo copy may be the only surviving copy (an
    // uncommitted initial add), so it must be snapshotted BEFORE deletion.
    getAllTrackedFilesMock.mockResolvedValue({
      foorc: { source: '~/.foorc', destination: 'files/misc/foorc', checksum: 'old' },
    });
    pathExistsMock.mockResolvedValue(false); // live source missing → 'deleted'

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand('sync: delete', {
      noCommit: true,
      noHooks: true,
      scan: false,
      pull: false,
    });

    const destPath = join('/test-home/.tuck', 'files', 'misc', 'foorc');
    expect(createSnapshotMock).toHaveBeenCalledTimes(1);
    expect(createSnapshotMock.mock.calls[0][0]).toEqual([destPath]);
    expect(deleteFileOrDirMock).toHaveBeenCalledWith(destPath);
    // The recoverable snapshot must be taken before the unrecoverable delete.
    expect(createSnapshotMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFileOrDirMock.mock.invocationCallOrder[0]
    );
  });

  it('excludes a repo-scoped change from the sync when the user picks the secret "ignore" action', async () => {
    // A repo-scoped tracked file drifts with a new secret. The interactive
    // 'ignore' action must key .tuckignore on the change SOURCE (the stable
    // `<repoKey>:<repoRelative>` identity that detectChanges consults) and splice
    // the change out — expandPath(source) never equals the resolved live path, so
    // the old matching leaked the secret into the commit.
    getAllTrackedFilesMock.mockResolvedValue({
      envfile: {
        source: 'myrepo:.env',
        destination: 'files/repos/myrepo/.env',
        checksum: 'old',
        scope: 'repo',
        repoKey: 'myrepo',
        repoRelative: '.env',
      },
    });
    const liveEnvPath = '/work/myrepo/.env';
    resolveLiveTargetMock.mockResolvedValue(liveEnvPath);
    getFileChecksumMock.mockResolvedValue('new'); // drifted → modified

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 1,
      results: [{ path: liveEnvPath, hasSecrets: true, matches: [] }],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);

    const ui = await import('../../src/ui/index.js');
    vi.mocked(ui.prompts.select).mockResolvedValue('ignore' as never);

    const tuckignore = await import('../../src/lib/tuckignore.js');

    try {
      const { runSyncCommand } = await import('../../src/commands/sync.js');
      // No message / json / yes ⇒ the interactive flow (scanAndHandleSecrets).
      await runSyncCommand(undefined, { noHooks: true, scan: false, pull: false } as never);

      expect(vi.mocked(tuckignore.addToTuckignore)).toHaveBeenCalledWith(
        '/test-home/.tuck',
        'myrepo:.env'
      );
      // The secret-bearing change was spliced out, so it is never copied/committed.
      expect(copyFileOrDirMock).not.toHaveBeenCalled();
      expect(commitMock).not.toHaveBeenCalled();
    } finally {
      vi.mocked(ui.prompts.select).mockResolvedValue('abort' as never);
    }
  });

  // ==========================================================================
  // Repo-only redaction during sync (issue #100 RC5): choosing 'redact' must
  // apply placeholders to the REPO copy only — the live file in $HOME is never
  // rewritten.
  // ==========================================================================

  const SECRET_VALUE = 'supersecret_value_1234567890';

  /** Minimal SecretMatch carrying only what the redaction path consumes. */
  const makeMatch = (value: string, placeholder: string) => ({
    patternId: 'generic-api-key',
    patternName: 'Generic API Key',
    severity: 'high',
    value,
    redactedValue: '***',
    line: 1,
    column: 1,
    context: '',
    placeholder,
    start: 0,
    end: value.length,
    offsetsExact: true,
  });

  /** Content-derived checksum so manifest assertions can compare real bytes. */
  const contentChecksum = async (p: string) => `sum:${vol.readFileSync(p, 'utf-8')}`;

  /** memfs-backed copy so the repo copy holds the live file's real bytes. */
  const memfsCopy = async (src: string, dest: string) => {
    vol.mkdirSync(dirname(dest), { recursive: true });
    vol.writeFileSync(dest, vol.readFileSync(src));
  };

  /** memfs-backed redactFile stand-in: replaces values with {{PLACEHOLDER}}. */
  const memfsRedactFile = async (
    filepath: string,
    matches: Array<{ value: string }>,
    placeholderMap: Map<string, string>
  ) => {
    let content = vol.readFileSync(filepath, 'utf-8') as string;
    for (const m of matches) {
      content = content.split(m.value).join(`{{${placeholderMap.get(m.value)}}}`);
    }
    vol.writeFileSync(filepath, content);
    return { originalContent: '', redactedContent: content, replacements: [] };
  };

  it("redacts the REPO copy only when the user picks 'redact' — live file untouched", async () => {
    const livePath = '/test-home/.secretrc';
    const liveContent = `export API_KEY=${SECRET_VALUE}\nalias ll="ls -la"\n`;
    vol.writeFileSync(livePath, liveContent);

    getAllTrackedFilesMock.mockResolvedValue({
      secretrc: { source: '~/.secretrc', destination: 'files/shell/secretrc', checksum: 'old' },
    });
    getFileChecksumMock.mockImplementation(contentChecksum);
    copyFileOrDirMock.mockImplementation(memfsCopy);

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 1,
      results: [
        {
          path: livePath,
          collapsedPath: '~/.secretrc',
          hasSecrets: true,
          matches: [makeMatch(SECRET_VALUE, 'API_KEY')],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);
    vi.mocked(secrets.processSecretsForRedaction).mockResolvedValue(
      new Map([[livePath, new Map([[SECRET_VALUE, 'API_KEY']])]])
    );
    vi.mocked(secrets.redactFile).mockImplementation(memfsRedactFile as never);

    const ui = await import('../../src/ui/index.js');
    vi.mocked(ui.prompts.select).mockResolvedValue('redact' as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { noHooks: true, scan: false, pull: false } as never);

    const destPath = join('/test-home/.tuck', 'files/shell/secretrc');

    // LIVE FILE: byte-identical — issue #100's core contract.
    expect(vol.readFileSync(livePath, 'utf-8')).toBe(liveContent);

    // REPO COPY: placeholder in, cleartext out.
    const repoContent = vol.readFileSync(destPath, 'utf-8') as string;
    expect(repoContent).toContain('{{API_KEY}}');
    expect(repoContent).not.toContain(SECRET_VALUE);

    // redactFile targeted the REPO copy, never the live path.
    expect(vi.mocked(secrets.redactFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(secrets.redactFile).mock.calls[0][0]).toBe(destPath);

    // Manifest checksum reflects the REDACTED repo content.
    expect(updateFileInManifestMock).toHaveBeenCalledTimes(1);
    expect(updateFileInManifestMock.mock.calls[0][2].checksum).toBe(
      await contentChecksum(destPath)
    );
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('maps directory redaction plans onto inner repo targets and skips missing ones', async () => {
    const liveDir = '/test-home/.config/tool';
    getAllTrackedFilesMock.mockResolvedValue({
      tool: { source: '~/.config/tool', destination: 'files/misc/tool', checksum: 'old' },
    });

    const destPath = join('/test-home/.tuck', 'files/misc/tool');
    const innerTarget = join(destPath, 'credentials');
    const missingTarget = join(destPath, 'nested', 'excluded.env');
    // The excluded inner file never reached the repo copy; everything else exists.
    pathExistsMock.mockImplementation(async (p: string) => p !== missingTarget);

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 2,
      results: [
        {
          path: join(liveDir, 'credentials'),
          collapsedPath: '~/.config/tool/credentials',
          hasSecrets: true,
          matches: [makeMatch(SECRET_VALUE, 'AWS_KEY')],
        },
        {
          path: join(liveDir, 'nested', 'excluded.env'),
          collapsedPath: '~/.config/tool/nested/excluded.env',
          hasSecrets: true,
          matches: [makeMatch('other_secret_9876543210', 'OTHER_KEY')],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);
    vi.mocked(secrets.processSecretsForRedaction).mockResolvedValue(
      new Map([
        [join(liveDir, 'credentials'), new Map([[SECRET_VALUE, 'AWS_KEY']])],
        [join(liveDir, 'nested', 'excluded.env'), new Map([['other_secret_9876543210', 'OTHER_KEY']])],
      ])
    );

    const ui = await import('../../src/ui/index.js');
    vi.mocked(ui.prompts.select).mockResolvedValue('redact' as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { noHooks: true, scan: false, pull: false } as never);

    // The plan for the inner file that EXISTS in the repo copy is applied to the
    // mapped repo target (destPath + relative live path)...
    expect(vi.mocked(secrets.redactFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(secrets.redactFile).mock.calls[0][0]).toBe(innerTarget);
    // ...and its containment was validated against the tuck root.
    expect(validatePathWithinRootMock).toHaveBeenCalledWith(
      innerTarget,
      '/test-home/.tuck',
      'sync redaction target'
    );
    // The plan whose repo target was excluded from the copy is skipped, and the
    // sync still completes.
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(updateFileInManifestMock).toHaveBeenCalledTimes(1);
  });

  it('warns and does NOT redact a symlink-tracked file whose live file IS the repo copy', async () => {
    // Symlink strategy: the live path is a symlink to the repo copy (same inode).
    // Redacting the repo copy would rewrite the live file — forbidden. Sync must
    // warn, skip redaction, and still complete.
    const destPath = join('/test-home/.tuck', 'files/shell/zshrc');
    const liveContent = `export TOKEN=${SECRET_VALUE}\n`;
    vol.mkdirSync(dirname(destPath), { recursive: true });
    vol.writeFileSync(destPath, liveContent);
    vol.symlinkSync(destPath, '/test-home/.zshrc');

    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 1,
      results: [
        {
          path: '/test-home/.zshrc',
          collapsedPath: '~/.zshrc',
          hasSecrets: true,
          matches: [makeMatch(SECRET_VALUE, 'TOKEN')],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);
    vi.mocked(secrets.processSecretsForRedaction).mockResolvedValue(
      new Map([['/test-home/.zshrc', new Map([[SECRET_VALUE, 'TOKEN']])]])
    );

    const ui = await import('../../src/ui/index.js');
    vi.mocked(ui.prompts.select).mockResolvedValue('redact' as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { noHooks: true, scan: false, pull: false } as never);

    // Neither copied (same inode) nor redacted (would rewrite the live file).
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
    expect(vi.mocked(secrets.redactFile)).not.toHaveBeenCalled();
    // Both files (one inode) still hold the original bytes.
    expect(vol.readFileSync(destPath, 'utf-8')).toBe(liveContent);
    expect(vol.readFileSync('/test-home/.zshrc', 'utf-8')).toBe(liveContent);
    // The user was told why, with a re-track suggestion — and sync did not fail.
    expect(vi.mocked(ui.logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('symlink-tracked')
    );
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('removes the repo copy and fails the file sync loudly when redaction fails', async () => {
    // A genuinely failed redaction must never leave a CLEARTEXT repo copy behind
    // for stageAll to commit, and must not record the manifest checksum.
    const livePath = '/test-home/.secretrc';
    vol.writeFileSync(livePath, `export API_KEY=${SECRET_VALUE}\n`);

    getAllTrackedFilesMock.mockResolvedValue({
      secretrc: { source: '~/.secretrc', destination: 'files/shell/secretrc', checksum: 'old' },
    });
    copyFileOrDirMock.mockImplementation(memfsCopy);

    const secrets = await import('../../src/lib/secrets/index.js');
    vi.mocked(secrets.isSecretScanningEnabled).mockResolvedValue(true);
    vi.mocked(secrets.scanForSecrets).mockResolvedValue({
      totalSecrets: 1,
      results: [
        {
          path: livePath,
          collapsedPath: '~/.secretrc',
          hasSecrets: true,
          matches: [makeMatch(SECRET_VALUE, 'API_KEY')],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof secrets.scanForSecrets>>);
    vi.mocked(secrets.processSecretsForRedaction).mockResolvedValue(
      new Map([[livePath, new Map([[SECRET_VALUE, 'API_KEY']])]])
    );
    vi.mocked(secrets.redactFile).mockRejectedValue(new Error('disk full'));

    const ui = await import('../../src/ui/index.js');
    vi.mocked(ui.prompts.select).mockResolvedValue('redact' as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await expect(
      runSyncCommand(undefined, { noHooks: true, scan: false, pull: false } as never)
    ).rejects.toThrow('disk full');

    const destPath = join('/test-home/.tuck', 'files/shell/secretrc');
    // The cleartext repo copy is removed before the error propagates...
    expect(deleteFileOrDirMock).toHaveBeenCalledWith(destPath);
    // ...and the manifest checksum was never updated, nothing staged/committed.
    expect(updateFileInManifestMock).not.toHaveBeenCalled();
    expect(stageAllMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
    // The live file is untouched.
    expect(vol.readFileSync(livePath, 'utf-8')).toBe(`export API_KEY=${SECRET_VALUE}\n`);
  });
});
