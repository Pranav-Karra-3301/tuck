import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
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
const runPreSyncHookMock = vi.fn();
const runPostSyncHookMock = vi.fn();
const stageAllMock = vi.fn();
const commitMock = vi.fn();
const hasRemoteMock = vi.fn();
const pushMock = vi.fn();
const loggerInfoMock = vi.fn();

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
  colors: {
    dim: (x: string) => x,
  },
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

vi.mock('../../src/lib/git.js', () => ({
  stageAll: stageAllMock,
  commit: commitMock,
  getStatus: vi.fn().mockResolvedValue({ behind: 0 }),
  push: pushMock,
  hasRemote: hasRemoteMock,
  fetch: vi.fn(),
  pull: vi.fn(),
}));

vi.mock('../../src/lib/files.js', () => ({
  copyFileOrDir: copyFileOrDirMock,
  getFileChecksum: getFileChecksumMock,
  deleteFileOrDir: deleteFileOrDirMock,
  checkFileSizeThreshold: vi.fn().mockResolvedValue({ warn: false, block: false, size: 10 }),
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
}));

vi.mock('../../src/commands/secrets.js', () => ({
  displayScanResults: vi.fn(),
}));

vi.mock('../../src/lib/audit.js', () => ({
  logForceSecretBypass: vi.fn(),
}));

const checkLocalModeMock = vi.fn();
vi.mock('../../src/lib/remoteChecks.js', () => ({
  checkLocalMode: checkLocalModeMock,
}));

describe('sync command behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    loadTuckignoreMock.mockResolvedValue(new Set());
    getAllTrackedFilesMock.mockResolvedValue({});
    pathExistsMock.mockResolvedValue(true);
    isIgnoredMock.mockResolvedValue(false);
    getFileChecksumMock.mockResolvedValue('new-checksum');
    hasRemoteMock.mockResolvedValue(false);
    commitMock.mockResolvedValue('abc123def456');
    checkLocalModeMock.mockResolvedValue(false);
    validateSafeSourcePathMock.mockImplementation(() => {});
    validateSafeManifestDestinationMock.mockImplementation(() => {});
    validatePathWithinRootMock.mockImplementation(() => {});
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
});
