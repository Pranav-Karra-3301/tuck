import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotInitializedError,
  FileNotFoundError,
  FileAlreadyTrackedError,
  SecretsDetectedError,
} from '../../src/errors.js';

const loadManifestMock = vi.fn();
const isFileTrackedMock = vi.fn();
const trackFilesWithProgressMock = vi.fn();
const pathExistsMock = vi.fn();
const isDirectoryMock = vi.fn();
const detectCategoryMock = vi.fn();
const sanitizeFilenameMock = vi.fn();
const getDestinationPathMock = vi.fn();
const loadConfigMock = vi.fn();
const scanForSecretsMock = vi.fn();
const shouldBlockOnSecretsMock = vi.fn();
const isIgnoredMock = vi.fn();
const shouldExcludeFromBinMock = vi.fn();
const getDirectoryFileCountMock = vi.fn();
const checkFileSizeThresholdMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    confirmDangerous: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('continue'),
    text: vi.fn(),
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
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
  },
  colors: {
    error: (x: string) => x,
    warning: (x: string) => x,
    info: (x: string) => x,
    brand: (x: string) => x,
    muted: (x: string) => x,
    bold: (x: string) => x,
  },
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  isFileTracked: isFileTrackedMock,
}));

vi.mock('../../src/lib/fileTracking.js', () => ({
  trackFilesWithProgress: trackFilesWithProgressMock,
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  collapsePath: vi.fn((p: string) => p.replace('/test-home/', '~/')),
  pathExists: pathExistsMock,
  isDirectory: isDirectoryMock,
  detectCategory: detectCategoryMock,
  sanitizeFilename: sanitizeFilenameMock,
  getDestinationPath: getDestinationPathMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  scanForSecrets: scanForSecretsMock,
  shouldBlockOnSecrets: shouldBlockOnSecretsMock,
  processSecretsForRedaction: vi.fn(),
  redactFile: vi.fn(),
  getSecretsPath: vi.fn(),
}));

vi.mock('../../src/lib/tuckignore.js', () => ({
  isIgnored: isIgnoredMock,
  addToTuckignore: vi.fn(),
}));

vi.mock('../../src/lib/binary.js', () => ({
  shouldExcludeFromBin: shouldExcludeFromBinMock,
}));

vi.mock('../../src/lib/files.js', () => ({
  getDirectoryFileCount: getDirectoryFileCountMock,
  checkFileSizeThreshold: checkFileSizeThresholdMock,
  formatFileSize: vi.fn((size: number) => `${size} B`),
}));

vi.mock('../../src/lib/audit.js', () => ({
  logForceSecretBypass: vi.fn(),
}));

describe('add command behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    isFileTrackedMock.mockResolvedValue(false);
    trackFilesWithProgressMock.mockResolvedValue({
      succeeded: 1,
      failed: 0,
      errors: [],
      sensitiveFiles: [],
    });
    pathExistsMock.mockResolvedValue(true);
    isDirectoryMock.mockResolvedValue(false);
    detectCategoryMock.mockReturnValue('shell');
    sanitizeFilenameMock.mockReturnValue('zshrc');
    getDestinationPathMock.mockReturnValue('/test-home/.tuck/files/shell/zshrc');
    loadConfigMock.mockResolvedValue({
      security: { scanSecrets: true },
    });
    scanForSecretsMock.mockResolvedValue({
      totalSecrets: 0,
      filesWithSecrets: 0,
      results: [],
    });
    shouldBlockOnSecretsMock.mockResolvedValue(true);
    isIgnoredMock.mockResolvedValue(false);
    shouldExcludeFromBinMock.mockResolvedValue(false);
    getDirectoryFileCountMock.mockResolvedValue(1);
    checkFileSizeThresholdMock.mockResolvedValue({ warn: false, block: false, size: 12 });
  });

  it('tracks valid files and returns tracked count', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');

    const count = await addFilesFromPaths(['~/.zshrc']);

    expect(count).toBe(1);
    expect(trackFilesWithProgressMock).toHaveBeenCalledTimes(1);
    expect(scanForSecretsMock).toHaveBeenCalledTimes(1);
  });

  it('throws NotInitializedError when manifest cannot be loaded', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));

    await expect(addFilesFromPaths(['~/.zshrc'])).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('throws FileNotFoundError when source path does not exist', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');
    pathExistsMock.mockResolvedValueOnce(false);

    await expect(addFilesFromPaths(['~/.missing'])).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it('throws FileAlreadyTrackedError when file is already tracked', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');
    isFileTrackedMock.mockResolvedValueOnce(true);

    await expect(addFilesFromPaths(['~/.zshrc'])).rejects.toBeInstanceOf(FileAlreadyTrackedError);
  });

  it('throws SecretsDetectedError when scanner blocks detected secrets', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');
    scanForSecretsMock.mockResolvedValueOnce({
      totalSecrets: 2,
      filesWithSecrets: 1,
      results: [
        {
          path: '/test-home/.zshrc',
          hasSecrets: true,
          matches: [],
        },
      ],
    });
    shouldBlockOnSecretsMock.mockResolvedValueOnce(true);

    await expect(addFilesFromPaths(['~/.zshrc'])).rejects.toBeInstanceOf(SecretsDetectedError);
  });

  it('skips scanning when force flag is enabled', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');

    const count = await addFilesFromPaths(['~/.zshrc'], { force: true });

    expect(count).toBe(1);
    expect(scanForSecretsMock).not.toHaveBeenCalled();
    expect(trackFilesWithProgressMock).toHaveBeenCalledTimes(1);
  });
});
