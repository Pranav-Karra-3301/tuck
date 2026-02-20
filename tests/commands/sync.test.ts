import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { NotInitializedError } from '../../src/errors.js';

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
