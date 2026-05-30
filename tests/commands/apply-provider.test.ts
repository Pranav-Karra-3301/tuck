/**
 * Provider-neutral apply source resolution.
 *
 * `tuck apply <source>` must NOT hard-code github.com. Two behaviours under test:
 *
 *  1. A file:// (custom) source clones through the CUSTOM provider's cloneRepo
 *     (which carries the clone timeout/maxBuffer), never through any github code
 *     path. We mock that provider clone to populate a memfs temp repo, then prove
 *     apply read+applied it with zero github involvement.
 *
 *  2. A bare owner/repo resolves its clone URL via the CONFIGURED provider's
 *     buildRepoUrl (here: gitlab), never via a literal `https://github.com/...`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

const gitCloneRepoMock = vi.fn();
const customCloneRepoMock = vi.fn();
const configuredBuildRepoUrlMock = vi.fn();
const configuredCloneRepoMock = vi.fn();
const ghCloneRepoMock = vi.fn();
const isGhInstalledMock = vi.fn().mockResolvedValue(false);
const loadConfigMock = vi.fn();

const loggerSuccessMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarningMock = vi.fn();

const findPlaceholdersMock = vi.fn();
const restoreContentMock = vi.fn();

// A custom provider whose cloneRepo we can assert on (stands in for file:// /
// full-URL / tarball clones routed away from github).
const customProviderStub = {
  mode: 'custom' as const,
  cloneRepo: customCloneRepoMock,
  buildRepoUrl: vi.fn(),
};

// The "configured" provider (gitlab here) — bare owner/repo must build its URL
// through buildRepoUrl, never a hard-coded github literal.
const configuredProviderStub = {
  mode: 'gitlab' as const,
  cloneRepo: configuredCloneRepoMock,
  buildRepoUrl: configuredBuildRepoUrlMock,
};

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
    info: loggerInfoMock,
    success: loggerSuccessMock,
    warning: loggerWarningMock,
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
    dim: vi.fn(),
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
  cloneRepo: gitCloneRepoMock,
}));

vi.mock('../../src/lib/github.js', () => ({
  isGhInstalled: isGhInstalledMock,
  findDotfilesRepo: vi.fn().mockResolvedValue(null),
  ghCloneRepo: ghCloneRepoMock,
  repoExists: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  getProvider: (mode: string) => (mode === 'custom' ? customProviderStub : configuredProviderStub),
}));

vi.mock('../../src/lib/timemachine.js', () => ({
  createPreApplySnapshot: vi.fn().mockResolvedValue({ id: 'snap' }),
}));

vi.mock('../../src/lib/merge.js', () => ({
  smartMerge: vi.fn(async (_d: string, content: string) => ({ content, preservedBlocks: 0 })),
  isShellFile: vi.fn().mockReturnValue(false),
  generateMergePreview: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  findPlaceholders: findPlaceholdersMock,
  restoreContent: restoreContentMock,
  restoreFiles: vi.fn().mockResolvedValue({ totalRestored: 0, allUnresolved: [] }),
  getAllSecrets: vi.fn().mockResolvedValue({}),
  getSecretCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../src/lib/secretBackends/index.js', () => ({
  createResolver: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/platform.js', () => ({
  IS_WINDOWS: false,
}));

const writeManifestRepo = (dir: string, contents: string): void => {
  const manifest = createMockManifest({
    files: {
      safe: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
    },
  });
  vol.mkdirSync(join(dir, 'files', 'shell'), { recursive: true });
  vol.writeFileSync(join(dir, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
  vol.writeFileSync(join(dir, 'files', 'shell', 'zshrc'), contents);
};

describe('apply provider-neutral source resolution', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    isGhInstalledMock.mockResolvedValue(false);
    findPlaceholdersMock.mockReturnValue([]);
    restoreContentMock.mockImplementation((content: string) => ({
      restoredContent: content,
      unresolved: [],
    }));
    // Configured provider is gitlab — bare owner/repo must route through it.
    loadConfigMock.mockResolvedValue({ remote: { mode: 'gitlab' }, security: { secretBackend: 'local' } });
    configuredBuildRepoUrlMock.mockReturnValue('https://gitlab.com/team/dotfiles.git');

    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
  });

  afterEach(() => {
    vol.reset();
  });

  it('clones a file:// source via the custom provider, never github', async () => {
    // The custom provider clone populates the temp repo dir (no real network).
    customCloneRepoMock.mockImplementation(async (_url: string, dir: string) => {
      vol.mkdirSync(dir, { recursive: true });
      writeManifestRepo(dir, 'export FROM_FILE_URL=1');
    });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('file:///srv/dotfiles.git', { replace: true });

    // Routed through the custom provider's capped clone, with the file:// URL.
    expect(customCloneRepoMock).toHaveBeenCalledTimes(1);
    expect(customCloneRepoMock).toHaveBeenCalledWith(
      'file:///srv/dotfiles.git',
      expect.any(String)
    );

    // Absolutely no github path was taken.
    expect(gitCloneRepoMock).not.toHaveBeenCalled();
    expect(ghCloneRepoMock).not.toHaveBeenCalled();
    expect(isGhInstalledMock).not.toHaveBeenCalled();

    // The cloned manifest was read and the file applied.
    expect(vol.readFileSync(join(TEST_HOME, '.zshrc'), 'utf-8')).toBe('export FROM_FILE_URL=1');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Applied 1 files');
  });

  it('resolves a bare owner/repo URL via the configured provider buildRepoUrl, not github.com', async () => {
    gitCloneRepoMock.mockImplementation(async (_url: string, dir: string) => {
      vol.mkdirSync(dir, { recursive: true });
      writeManifestRepo(dir, 'export FROM_GITLAB=1');
    });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('team/dotfiles', { replace: true });

    // The configured (gitlab) provider built the URL — github.com never appears.
    expect(configuredBuildRepoUrlMock).toHaveBeenCalledWith('team', 'dotfiles', 'https');
    expect(ghCloneRepoMock).not.toHaveBeenCalled();
    // Whatever clone transport is used, it must receive the provider-built URL,
    // never a hard-coded https://github.com/team/dotfiles.git.
    const cloneCalls = [
      ...gitCloneRepoMock.mock.calls,
      ...configuredCloneRepoMock.mock.calls,
      ...customCloneRepoMock.mock.calls,
    ];
    expect(cloneCalls.length).toBeGreaterThan(0);
    for (const call of cloneCalls) {
      expect(call[0]).toBe('https://gitlab.com/team/dotfiles.git');
      expect(String(call[0])).not.toContain('github.com');
    }

    expect(vol.readFileSync(join(TEST_HOME, '.zshrc'), 'utf-8')).toBe('export FROM_GITLAB=1');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Applied 1 files');
  });
});
