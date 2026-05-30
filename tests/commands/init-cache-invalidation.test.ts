/**
 * Init manifest-cache-invalidation regression — BATCH W4-D.
 *
 * `tuck init --from <url>` clones a repo into the tuck dir, rewriting the
 * manifest out-of-band. The in-memory manifest cache must be dropped after the
 * clone so a later loadManifest in the SAME run (e.g. the restore step) reads the
 * freshly-cloned manifest rather than stale cached state. init.ts now calls
 * clearManifestCache() after the clone path populates the repo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cloneRepoMock = vi.fn();
const createManifestMock = vi.fn();
const saveConfigMock = vi.fn();
const pathExistsMock = vi.fn();
const clearManifestCacheMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  nextSteps: vi.fn(),
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn(), message: vi.fn() },
  },
  logger: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
  colors: { brand: (x: string) => x, dim: (x: string) => x, bold: (x: string) => x },
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  getManifestPath: vi.fn((tuckDir: string) => `${tuckDir}/.tuckmanifest.json`),
  getConfigPath: vi.fn((tuckDir: string) => `${tuckDir}/.tuckrc.json`),
  getFilesDir: vi.fn((tuckDir: string) => `${tuckDir}/files`),
  getCategoryDir: vi.fn((tuckDir: string, category: string) => `${tuckDir}/files/${category}`),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  pathExists: pathExistsMock,
  collapsePath: vi.fn((path: string) => path.replace('/test-home', '~')),
}));

vi.mock('../../src/lib/config.js', () => ({ saveConfig: saveConfigMock }));

vi.mock('../../src/lib/manifest.js', () => ({
  createManifest: createManifestMock,
  clearManifestCache: clearManifestCacheMock,
}));

vi.mock('../../src/lib/git.js', () => ({
  initRepo: vi.fn(),
  addRemote: vi.fn(),
  cloneRepo: cloneRepoMock,
  setDefaultBranch: vi.fn(),
  stageAll: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../../src/lib/providerSetup.js', () => ({
  setupProvider: vi.fn(),
  detectProviderFromUrl: vi.fn(() => 'local'),
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  getProvider: vi.fn(),
  describeProviderConfig: vi.fn(() => 'local'),
  buildRemoteConfig: vi.fn(() => ({ mode: 'local' })),
}));

vi.mock('../../src/lib/github.js', () => ({
  isGhInstalled: vi.fn(),
  isGhAuthenticated: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  getPreferredRemoteProtocol: vi.fn(),
  findDotfilesRepo: vi.fn(),
  ghCloneRepo: vi.fn(),
}));

vi.mock('../../src/lib/detect.js', () => ({
  detectDotfiles: vi.fn().mockResolvedValue([]),
  DETECTION_CATEGORIES: {},
}));

vi.mock('../../src/lib/validation.js', () => ({
  errorToMessage: vi.fn((error: unknown) => String(error)),
}));

describe('init clears the manifest cache after a clone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneRepoMock.mockResolvedValue(undefined);
    createManifestMock.mockResolvedValue(undefined);
    saveConfigMock.mockResolvedValue(undefined);
  });

  it('calls clearManifestCache after `init --from` clones the repo', async () => {
    // Cloned repo already has both manifest and config present.
    pathExistsMock.mockResolvedValue(true);
    const { runInit } = await import('../../src/commands/init.js');

    await runInit({ from: 'https://github.com/acme/dotfiles.git' });

    expect(cloneRepoMock).toHaveBeenCalledWith(
      'https://github.com/acme/dotfiles.git',
      '/test-home/.tuck'
    );
    expect(clearManifestCacheMock).toHaveBeenCalled();
  });
});
