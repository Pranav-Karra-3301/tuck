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
const getDestinationPathFromSourceMock = vi.fn();
const validateSafeSourcePathMock = vi.fn();
const loadConfigMock = vi.fn();
const scanForSecretsMock = vi.fn();
const shouldBlockOnSecretsMock = vi.fn();
const isSecretScanningEnabledMock = vi.fn();
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
  getDestinationPathFromSource: getDestinationPathFromSourceMock,
  validateSafeSourcePath: validateSafeSourcePathMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  scanForSecrets: scanForSecretsMock,
  shouldBlockOnSecrets: shouldBlockOnSecretsMock,
  isSecretScanningEnabled: isSecretScanningEnabledMock,
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
    getDestinationPathFromSourceMock.mockReturnValue('/test-home/.tuck/files/shell/.zshrc');
    validateSafeSourcePathMock.mockImplementation(() => {});
    loadConfigMock.mockResolvedValue({
      security: { scanSecrets: true },
    });
    scanForSecretsMock.mockResolvedValue({
      totalSecrets: 0,
      filesWithSecrets: 0,
      results: [],
    });
    shouldBlockOnSecretsMock.mockResolvedValue(true);
    isSecretScanningEnabledMock.mockResolvedValue(true);
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

  it('uses symlink strategy when requested', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');

    await addFilesFromPaths(['~/.zshrc'], { force: true, symlink: true });

    expect(trackFilesWithProgressMock).toHaveBeenCalledWith(
      [{ path: '~/.zshrc', category: 'shell' }],
      '/test-home/.tuck',
      expect.objectContaining({
        strategy: 'symlink',
      })
    );
  });

  it('passes --template and --encrypt through to tracking', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');

    await addFilesFromPaths(['~/.zshrc'], { force: true, template: true, encrypt: true });

    expect(trackFilesWithProgressMock).toHaveBeenCalledWith(
      [{ path: '~/.zshrc', category: 'shell' }],
      '/test-home/.tuck',
      expect.objectContaining({ template: true, encrypt: true })
    );
  });

  it('runs the full prepare pipeline for --plan and reflects the detected category', async () => {
    // detectCategory returns 'shell' from beforeEach; the plan must surface the
    // detected category, not the (undefined) raw --category input.
    const { addCommand } = await import('../../src/commands/add.js');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await addCommand.parseAsync(['~/.zshrc', '--json', '--plan'], { from: 'user' });

    writeSpy.mockRestore();

    const lines = writes.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const env = JSON.parse(lines[0]);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck add');

    // The plan runs the REAL pipeline: category detection + secret scan ran.
    expect(detectCategoryMock).toHaveBeenCalled();
    expect(scanForSecretsMock).toHaveBeenCalled();

    // Plan entry mirrors a prepared entry (detected category 'shell'), not raw input.
    expect(env.data.plan).toHaveLength(1);
    expect(env.data.plan[0]).toMatchObject({
      source: '~/.zshrc',
      category: 'shell',
      sensitive: false,
    });

    // --plan is dry: nothing is tracked.
    expect(trackFilesWithProgressMock).not.toHaveBeenCalled();
  });

  it('does not write or scan a second time on --plan (dry run)', async () => {
    const { addCommand } = await import('../../src/commands/add.js');

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await addCommand.parseAsync(['~/.zshrc', '--json', '--plan'], { from: 'user' });

    writeSpy.mockRestore();

    expect(trackFilesWithProgressMock).not.toHaveBeenCalled();
  });

  it('forwards --encrypt to tracking on the interactive path (path entered at the prompt)', async () => {
    const { addCommand } = await import('../../src/commands/add.js');
    const { prompts } = await import('../../src/ui/index.js');

    // No positional paths => interactive path; the path is typed at the prompt.
    vi.mocked(prompts.text).mockResolvedValue('~/.zshrc');
    vi.mocked(prompts.select).mockResolvedValue('shell');
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    // The shared `addCommand` singleton retains option values across parseAsync
    // calls (an earlier --json test leaks json=true), so clear the flags this
    // test relies on before parsing.
    addCommand.setOptionValue('json', false);
    addCommand.setOptionValue('plan', false);
    addCommand.setOptionValue('dryRun', false);
    addCommand.setOptionValue('yes', false);

    await addCommand.parseAsync(['--encrypt'], { from: 'user' });

    // Before the fix, addFiles was called with `{}` and --encrypt was dropped,
    // silently storing plaintext. The flag must now reach tracking.
    expect(trackFilesWithProgressMock).toHaveBeenCalledWith(
      expect.any(Array),
      '/test-home/.tuck',
      expect.objectContaining({ encrypt: true })
    );
  });

  it('passes custom --name through to tracking destination generation', async () => {
    const { addFilesFromPaths } = await import('../../src/commands/add.js');
    sanitizeFilenameMock.mockReturnValueOnce('custom-zshrc');

    await addFilesFromPaths(['~/.zshrc'], { force: true, name: 'custom-zshrc' });

    expect(trackFilesWithProgressMock).toHaveBeenCalledWith(
      [{ path: '~/.zshrc', category: 'shell', name: 'custom-zshrc' }],
      '/test-home/.tuck',
      expect.objectContaining({
        strategy: undefined,
      })
    );
  });
});
