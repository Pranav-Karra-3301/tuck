import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { NotInitializedError } from '../../src/errors.js';

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
    warning: vi.fn(),
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

describe('restore command behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    getAllTrackedFilesMock.mockResolvedValue({});
    getTrackedFileBySourceMock.mockResolvedValue(null);
    loadConfigMock.mockResolvedValue({
      files: {
        strategy: 'copy',
        backupOnRestore: true,
      },
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
  });

  it('throws NotInitializedError when manifest is missing', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));
    const { runRestore } = await import('../../src/commands/restore.js');

    await expect(runRestore({ all: true })).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('restores tracked files in all mode', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
      },
    });

    const { runRestore } = await import('../../src/commands/restore.js');

    await runRestore({ all: true, noHooks: true, noSecrets: true });

    expect(copyFileOrDirMock.mock.calls.length + createSymlinkMock.mock.calls.length).toBe(1);
    expect(validatePathWithinRootMock).toHaveBeenCalledWith(
      join('/test-home/.tuck', 'files', 'shell', 'zshrc'),
      '/test-home/.tuck',
      'restore source'
    );
  });

  it('fails fast when manifest destination is unsafe', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: '../../outside',
        category: 'shell',
      },
    });
    validateSafeManifestDestinationMock.mockImplementationOnce(() => {
      throw new Error('Unsafe manifest destination detected');
    });

    const { runRestore } = await import('../../src/commands/restore.js');

    await expect(runRestore({ all: true, noHooks: true })).rejects.toThrow(
      'Unsafe manifest destination detected'
    );
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
  });
});
