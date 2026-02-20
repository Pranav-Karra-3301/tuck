import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

const cloneRepoMock = vi.fn();
const createPreApplySnapshotMock = vi.fn();
const findPlaceholdersMock = vi.fn();
const restoreContentMock = vi.fn();
const restoreSecretsMock = vi.fn();
const getAllSecretsMock = vi.fn();
const getSecretCountMock = vi.fn();

const loggerInfoMock = vi.fn();
const loggerSuccessMock = vi.fn();
const loggerWarningMock = vi.fn();
const loggerHeadingMock = vi.fn();
const loggerBlankMock = vi.fn();
const loggerFileMock = vi.fn();
const loggerDimMock = vi.fn();

let cloneSetup: ((dir: string) => void) | null = null;
let clonedDir: string | null = null;

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
    note: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('merge'),
    multiselect: vi.fn().mockResolvedValue([]),
    cancel: vi.fn(),
  },
  logger: {
    info: loggerInfoMock,
    success: loggerSuccessMock,
    warning: loggerWarningMock,
    heading: loggerHeadingMock,
    blank: loggerBlankMock,
    file: loggerFileMock,
    dim: loggerDimMock,
    debug: vi.fn(),
  },
  colors: {
    yellow: (x: string) => x,
    dim: (x: string) => x,
    bold: (x: string) => x,
    green: (x: string) => x,
    cyan: (x: string) => x,
  },
}));

vi.mock('../../src/lib/git.js', () => ({
  cloneRepo: cloneRepoMock,
}));

vi.mock('../../src/lib/github.js', () => ({
  isGhInstalled: vi.fn().mockResolvedValue(false),
  findDotfilesRepo: vi.fn().mockResolvedValue(null),
  ghCloneRepo: vi.fn(),
  repoExists: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/lib/timemachine.js', () => ({
  createPreApplySnapshot: createPreApplySnapshotMock,
}));

vi.mock('../../src/lib/merge.js', () => ({
  smartMerge: vi.fn(async (_destination: string, content: string) => ({
    content,
    preservedBlocks: 0,
  })),
  isShellFile: vi.fn().mockReturnValue(false),
  generateMergePreview: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  findPlaceholders: findPlaceholdersMock,
  restoreContent: restoreContentMock,
  restoreFiles: restoreSecretsMock,
  getAllSecrets: getAllSecretsMock,
  getSecretCount: getSecretCountMock,
}));

vi.mock('../../src/lib/secretBackends/index.js', () => ({
  createResolver: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    security: {
      secretBackend: 'local',
    },
  }),
}));

vi.mock('../../src/lib/platform.js', () => ({
  IS_WINDOWS: false,
}));

describe('apply command behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vol.reset();
    cloneSetup = null;
    clonedDir = null;

    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });

    cloneRepoMock.mockImplementation(async (_url: string, dir: string) => {
      clonedDir = dir;
      vol.mkdirSync(dir, { recursive: true });
      if (cloneSetup) {
        cloneSetup(dir);
      }
    });

    findPlaceholdersMock.mockReturnValue([]);
    restoreContentMock.mockImplementation((content: string) => ({
      restoredContent: content,
      unresolved: [],
    }));
    restoreSecretsMock.mockResolvedValue({ totalRestored: 0, allUnresolved: [] });
    getAllSecretsMock.mockResolvedValue({});
    getSecretCountMock.mockResolvedValue(0);
    createPreApplySnapshotMock.mockResolvedValue({ id: 'snapshot-test' });
  });

  afterEach(() => {
    vol.reset();
  });

  it('applies only safe manifest entries in dry-run mode', async () => {
    cloneSetup = (dir: string) => {
      const manifest = createMockManifest({
        files: {
          safe: createMockTrackedFile({
            source: '~/.zshrc',
            destination: 'files/shell/zshrc',
          }),
          unsafeSource: createMockTrackedFile({
            source: '~/../etc/passwd',
            destination: 'files/misc/passwd',
          }),
          unsafeDestination: createMockTrackedFile({
            source: '~/.gitconfig',
            destination: '../../evil',
          }),
        },
      });

      vol.mkdirSync(join(dir, 'files', 'shell'), { recursive: true });
      vol.writeFileSync(join(dir, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(dir, 'files', 'shell', 'zshrc'), 'export SAFE=1');
    };

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('user/repo', { dryRun: true });

    expect(cloneRepoMock).toHaveBeenCalledWith(
      'https://github.com/user/repo.git',
      expect.any(String)
    );
    expect(createPreApplySnapshotMock).not.toHaveBeenCalled();
    expect(loggerWarningMock).toHaveBeenCalledWith('Skipping unsafe manifest entry: ~/../etc/passwd');
    expect(loggerWarningMock).toHaveBeenCalledWith('Skipping unsafe manifest entry: ~/.gitconfig');
    expect(loggerInfoMock).toHaveBeenCalledWith('Would apply 1 files');

    if (clonedDir) {
      expect(vol.existsSync(clonedDir)).toBe(false);
    }
  });

  it('creates a snapshot and writes files in replace mode', async () => {
    cloneSetup = (dir: string) => {
      const manifest = createMockManifest({
        files: {
          safe: createMockTrackedFile({
            source: '~/.zshrc',
            destination: 'files/shell/zshrc',
          }),
        },
      });

      vol.mkdirSync(join(dir, 'files', 'shell'), { recursive: true });
      vol.writeFileSync(join(dir, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(dir, 'files', 'shell', 'zshrc'), 'export NEW=1');
    };

    vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'export OLD=1');

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('user/repo', { replace: true });

    expect(createPreApplySnapshotMock).toHaveBeenCalledTimes(1);
    expect(createPreApplySnapshotMock).toHaveBeenCalledWith(
      [join(TEST_HOME, '.zshrc')],
      'user/repo'
    );
    expect(vol.readFileSync(join(TEST_HOME, '.zshrc'), 'utf-8')).toBe('export NEW=1');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Applied 1 files');

    if (clonedDir) {
      expect(vol.existsSync(clonedDir)).toBe(false);
    }
  });

  it('throws when cloned repository has no tuck manifest', async () => {
    cloneSetup = (_dir: string) => {
      // Intentionally leave out .tuckmanifest.json
    };

    const { runApply } = await import('../../src/commands/apply.js');

    await expect(runApply('user/repo', {})).rejects.toThrow('No tuck manifest found in repository');

    if (clonedDir) {
      expect(vol.existsSync(clonedDir)).toBe(false);
    }
  });
});
