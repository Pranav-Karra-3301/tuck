import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotInitializedError } from '../../src/errors.js';

const loadManifestMock = vi.fn();
const getTrackedFileBySourceMock = vi.fn();
const detectDotfilesMock = vi.fn();
const isIgnoredMock = vi.fn();
const shouldExcludeFromBinMock = vi.fn();
const trackFilesWithProgressMock = vi.fn();

const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();
const loggerSuccessMock = vi.fn();
const loggerDimMock = vi.fn();

const promptsSelectMock = vi.fn();
const promptsConfirmMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  colors: {
    bold: Object.assign((x: string) => x, { cyan: (x: string) => x }),
    dim: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
    cyan: (x: string) => x,
    white: (x: string) => x,
  },
  logger: {
    info: loggerInfoMock,
    warning: loggerWarnMock,
    warn: loggerWarnMock,
    success: loggerSuccessMock,
    dim: loggerDimMock,
  },
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: promptsConfirmMock,
    select: promptsSelectMock,
    multiselect: vi.fn(),
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
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  collapsePath: vi.fn((p: string) => p),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getTrackedFileBySource: getTrackedFileBySourceMock,
}));

vi.mock('../../src/lib/detect.js', () => ({
  detectDotfiles: detectDotfilesMock,
  DETECTION_CATEGORIES: {
    shell: { icon: '$', name: 'Shell', description: 'Shell configuration' },
    git: { icon: '*', name: 'Git', description: 'Git configuration' },
  },
}));

vi.mock('../../src/lib/tuckignore.js', () => ({
  isIgnored: isIgnoredMock,
}));

vi.mock('../../src/lib/binary.js', () => ({
  shouldExcludeFromBin: shouldExcludeFromBinMock,
}));

vi.mock('../../src/lib/fileTracking.js', () => ({
  trackFilesWithProgress: trackFilesWithProgressMock,
}));

describe('scan command behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    getTrackedFileBySourceMock.mockResolvedValue(null);
    detectDotfilesMock.mockResolvedValue([
      {
        path: '~/.zshrc',
        category: 'shell',
        description: 'Shell config',
        sensitive: false,
        isDirectory: false,
      },
    ]);
    isIgnoredMock.mockResolvedValue(false);
    shouldExcludeFromBinMock.mockResolvedValue(false);
    trackFilesWithProgressMock.mockResolvedValue({
      succeeded: 1,
      failed: 0,
      errors: [],
      sensitiveFiles: [],
    });
    promptsSelectMock.mockResolvedValue('preview');
    promptsConfirmMock.mockResolvedValue(false);
  });

  it('throws NotInitializedError when tuck is not initialized', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));
    const { runScan } = await import('../../src/commands/scan.js');

    await expect(runScan({ quick: true })).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('outputs JSON when json mode is enabled', async () => {
    const { runScan } = await import('../../src/commands/scan.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runScan({ json: true });

    expect(logSpy).toHaveBeenCalled();
    const payload = logSpy.mock.calls.flat().map(String).join('\n');
    expect(payload).toContain('~/.zshrc');

    logSpy.mockRestore();
  });

  it('runs quick mode without tracking files', async () => {
    const { runScan } = await import('../../src/commands/scan.js');

    await runScan({ quick: true });

    expect(trackFilesWithProgressMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalled();
  });

  it('tracks files in interactive all mode when user confirms', async () => {
    const { runScan } = await import('../../src/commands/scan.js');
    promptsSelectMock.mockResolvedValueOnce('all');
    promptsConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await runScan({});

    expect(trackFilesWithProgressMock).toHaveBeenCalledTimes(1);
  });
});
