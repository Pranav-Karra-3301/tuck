/**
 * Apply manifest-cache-invalidation regression — BATCH W4-D.
 *
 * `tuck apply` clones/materializes a source repo into a temp dir. The local tuck
 * manifest cache (used elsewhere in the same run, e.g. secret resolution and any
 * later loadManifest) must NOT survive that out-of-band materialization stale.
 * apply.ts now calls clearManifestCache() right after cloneSource populates the
 * temp repo. This test pins that the cache-clear happens during an apply.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

const clearManifestCacheSpy = vi.fn();

// Wrap the real manifest module so loadManifest etc. behave normally, but the
// cache-clear is observable.
vi.mock('../../src/lib/manifest.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/manifest.js')>();
  return {
    ...original,
    clearManifestCache: (...args: unknown[]) => {
      clearManifestCacheSpy(...args);
      return (original.clearManifestCache as (...a: unknown[]) => void)(...args);
    },
  };
});

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    note: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('merge'),
    multiselect: vi.fn().mockResolvedValue([]),
    cancel: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  colors: new Proxy({}, { get: () => (x: string) => x }),
}));

const cloneRepoMock = vi.fn();
vi.mock('../../src/lib/git.js', () => ({ cloneRepo: cloneRepoMock }));

const findPlaceholdersMock = vi.fn(() => [] as string[]);
const restoreContentMock = vi.fn((content: string) => ({ restoredContent: content, unresolved: [] }));

vi.mock('../../src/lib/github.js', () => ({
  isGhInstalled: vi.fn().mockResolvedValue(false),
  findDotfilesRepo: vi.fn().mockResolvedValue(null),
  ghCloneRepo: vi.fn(),
  repoExists: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/lib/timemachine.js', () => ({
  createPreApplySnapshot: vi.fn().mockResolvedValue({ id: 'snapshot-test' }),
}));

vi.mock('../../src/lib/merge.js', () => ({
  smartMerge: vi.fn(async (_d: string, content: string) => ({ content, preservedBlocks: 0 })),
  isShellFile: vi.fn().mockReturnValue(false),
  generateMergePreview: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  findPlaceholders: (...a: unknown[]) => findPlaceholdersMock(...(a as [])),
  restoreContent: (...a: [string]) => restoreContentMock(...a),
  restoreFiles: vi.fn().mockResolvedValue({ totalRestored: 0, allUnresolved: [] }),
  getAllSecrets: vi.fn().mockResolvedValue({}),
  getSecretCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../src/lib/secretBackends/index.js', () => ({ createResolver: vi.fn() }));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ security: { secretBackend: 'local' }, remote: { mode: 'local' } }),
}));

vi.mock('../../src/lib/platform.js', () => ({ IS_WINDOWS: false }));

describe('apply clears the manifest cache after clone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findPlaceholdersMock.mockReturnValue([]);
    restoreContentMock.mockImplementation((content: string) => ({
      restoredContent: content,
      unresolved: [],
    }));
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });

    cloneRepoMock.mockImplementation(async (_url: string, dir: string) => {
      vol.mkdirSync(dir, { recursive: true });
      const manifest = createMockManifest({
        files: {
          safe: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
        },
      });
      vol.mkdirSync(join(dir, 'files', 'shell'), { recursive: true });
      vol.writeFileSync(join(dir, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(dir, 'files', 'shell', 'zshrc'), 'export NEW=1');
    });
  });

  afterEach(() => {
    vol.reset();
  });

  it('calls clearManifestCache during a remote apply', async () => {
    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('user/repo', { replace: true });

    expect(clearManifestCacheSpy).toHaveBeenCalled();
  });

  it('calls clearManifestCache for a local-directory source too', async () => {
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        safe: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'shell'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    vol.writeFileSync(join(localSrc, 'files', 'shell', 'zshrc'), 'export NEW=1');

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    expect(clearManifestCacheSpy).toHaveBeenCalled();
    // No remote clone happened for a local source.
    expect(cloneRepoMock).not.toHaveBeenCalled();
  });
});
