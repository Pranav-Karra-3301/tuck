/**
 * Local-mode push gating for `tuck sync`.
 *
 * The non-interactive (--yes / --json) sync path must consult the provider gate
 * (assertRemoteAvailable) before pushing. In local-only mode the gate throws,
 * so even a committed change with a stray origin remote is never pushed. In a
 * non-local mode the push proceeds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const checkLocalModeMock = vi.fn();
const loadConfigMock = vi.fn();
const assertRemoteAvailableMock = vi.fn();

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
    info: vi.fn(),
    warning: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    file: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    dim: vi.fn(),
  },
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  colors: { dim: (x: string) => x },
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  pathExists: pathExistsMock,
  collapsePath: vi.fn((p: string) => p),
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
  clearManifestCache: vi.fn(),
}));

vi.mock('../../src/lib/repoScope.js', () => ({
  resolveLiveTarget: resolveLiveTargetMock,
}));

vi.mock('../../src/lib/git.js', () => ({
  stageAll: stageAllMock,
  commit: commitMock,
  getStatus: vi.fn().mockResolvedValue({ behind: 0, tracking: 'origin/main', branch: 'main' }),
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

vi.mock('../../src/lib/trackPipeline.js', () => ({
  preparePathsForTracking: vi.fn().mockResolvedValue([]),
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

vi.mock('../../src/lib/remoteChecks.js', () => ({
  checkLocalMode: checkLocalModeMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  assertRemoteAvailable: assertRemoteAvailableMock,
}));

describe('sync command local-mode push gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    loadTuckignoreMock.mockResolvedValue(new Set());
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    });
    pathExistsMock.mockResolvedValue(true);
    isIgnoredMock.mockResolvedValue(false);
    getFileChecksumMock.mockResolvedValue('new'); // change detected
    hasRemoteMock.mockResolvedValue(true); // stray origin present
    commitMock.mockResolvedValue('abc123def456');
    checkLocalModeMock.mockResolvedValue(false);
    validateSafeSourcePathMock.mockImplementation(() => {});
    validateSafeManifestDestinationMock.mockImplementation(() => {});
    validatePathWithinRootMock.mockImplementation(() => {});
    resolveLiveTargetMock.mockImplementation(async (file: { source: string }) =>
      file.source.replace(/^~\//, '/test-home/')
    );
    loadConfigMock.mockResolvedValue({ remote: { mode: 'github' } });
    assertRemoteAvailableMock.mockImplementation(() => {});
  });

  it('refuses to push in local mode even with a stray origin remote', async () => {
    // The provider gate is authoritative: local mode throws the local-mode
    // error, which IS the refusal — git push is never invoked. checkLocalMode
    // is forced false here so the gate is the only thing standing between the
    // committed change and a push.
    checkLocalModeMock.mockResolvedValue(false);
    hasRemoteMock.mockResolvedValue(true);
    loadConfigMock.mockResolvedValue({ remote: { mode: 'local' } });
    assertRemoteAvailableMock.mockImplementation((cfg: { mode: string }, op: string) => {
      if (cfg.mode === 'local') throw new Error(`Cannot ${op} in local-only mode`);
    });

    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await expect(
      runSyncCommand(undefined, { yes: true, noHooks: true, pull: false } as never)
    ).rejects.toThrow(/local-only mode/);

    // Committed locally, but the provider gate blocked the push entirely.
    expect(commitMock).toHaveBeenCalled();
    expect(assertRemoteAvailableMock).toHaveBeenCalledWith({ mode: 'local' }, 'push');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('pushes in a non-local mode after consulting the provider gate', async () => {
    loadConfigMock.mockResolvedValue({ remote: { mode: 'github' } });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { yes: true, noHooks: true, pull: false } as never);

    expect(assertRemoteAvailableMock).toHaveBeenCalledWith({ mode: 'github' }, 'push');
    expect(pushMock).toHaveBeenCalled();
  });
});
