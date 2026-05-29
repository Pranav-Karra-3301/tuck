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

  it('emits a JSON envelope with applied count and source when --json is set', async () => {
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

    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('user/repo', { json: true, yes: true } as never);

    writeSpy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck apply');
    expect(env.data.applied).toBe(1);
    expect(env.data.source).toBe('user/repo');

    // JSON mode must not print human success output.
    expect(loggerSuccessMock).not.toHaveBeenCalled();
  });

  it('applies from a local directory source without cloning a remote', async () => {
    // A provider-free local source: a directory containing a manifest + files.
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        safe: createMockTrackedFile({
          source: '~/.zshrc',
          destination: 'files/shell/zshrc',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'shell'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    vol.writeFileSync(join(localSrc, 'files', 'shell', 'zshrc'), 'export FROM_LOCAL=1');

    // jsonMode is module-level state; ensure a prior --json test does not leak in.
    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    // No remote was cloned — the local-dir branch of cloneSource was taken.
    expect(cloneRepoMock).not.toHaveBeenCalled();
    // The file landed at the home-relative destination.
    expect(vol.readFileSync(join(TEST_HOME, '.zshrc'), 'utf-8')).toBe('export FROM_LOCAL=1');
    expect(loggerInfoMock).toHaveBeenCalledWith('Reading local source...');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Applied 1 files');
  });

  it('emits a JSON envelope with source and dryRun when applying from a local directory', async () => {
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        safe: createMockTrackedFile({
          source: '~/.zshrc',
          destination: 'files/shell/zshrc',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'shell'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    vol.writeFileSync(join(localSrc, 'files', 'shell', 'zshrc'), 'export FROM_LOCAL=1');

    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { json: true, dryRun: true } as never);

    writeSpy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck apply');
    expect(env.data.applied).toBe(1);
    expect(env.data.source).toBe(localSrc);
    expect(env.data.dryRun).toBe(true);

    // Dry run must not write the destination file.
    expect(vol.existsSync(join(TEST_HOME, '.zshrc'))).toBe(false);
    expect(cloneRepoMock).not.toHaveBeenCalled();
    expect(loggerSuccessMock).not.toHaveBeenCalled();
  });

  it('emits applied: 0 in JSON mode when the local source manifest matches no files', async () => {
    // Manifest references a file that is absent from the source tree → 0 to apply.
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        missing: createMockTrackedFile({
          source: '~/.zshrc',
          destination: 'files/shell/zshrc',
        }),
      },
    });
    vol.mkdirSync(localSrc, { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    // Intentionally do NOT create files/shell/zshrc in the source.

    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { json: true } as never);

    writeSpy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck apply');
    expect(env.data.applied).toBe(0);
    expect(env.data.source).toBe(localSrc);
    // The no-files early-return envelope omits dryRun.
    expect(env.data.dryRun).toBeUndefined();
  });

  it('writes a BOUND repo-scoped file to the local checkout, not into $HOME', async () => {
    // Bind the repoKey to an out-of-home checkout on THIS machine before applying.
    const { bindRepo } = await import('../../src/lib/repoScope.js');
    const { getRepoScopedDestination } = await import('../../src/lib/paths.js');
    const repoKey = 'myrepo-deadbeef';
    const repoRoot = '/work/myrepo';
    const repoRelative = 'config/app.toml';
    await bindRepo(repoKey, repoRoot);

    const dest = getRepoScopedDestination(repoKey, repoRelative);

    cloneSetup = (dir: string) => {
      const manifest = createMockManifest({
        files: {
          repofile: createMockTrackedFile({
            source: `${repoKey}:${repoRelative}`,
            destination: dest,
            scope: 'repo',
            repoKey,
            repoRelative,
          }),
        },
      });

      vol.mkdirSync(join(dir, 'files', 'repos', repoKey, 'config'), { recursive: true });
      vol.writeFileSync(join(dir, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(dir, dest), 'from-repo = true');
    };

    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('user/repo', { replace: true });

    // The file landed inside the bound checkout, NOT under $HOME.
    expect(vol.readFileSync(join(repoRoot, repoRelative), 'utf-8')).toBe('from-repo = true');
    expect(vol.existsSync(join(TEST_HOME, repoKey + ':' + repoRelative))).toBe(false);
    expect(loggerSuccessMock).toHaveBeenCalledWith('Applied 1 files');
  });

  it('skips an UNBOUND repo-scoped file and lists it in the JSON envelope', async () => {
    // No bindRepo() call → the repo is unbound on this machine. resolveLiveTarget
    // returns null, so the file must be SKIPPED (never guessed / written) and
    // surfaced in the envelope's `skipped` list.
    const { getRepoScopedDestination } = await import('../../src/lib/paths.js');
    const repoKey = 'otherrepo-cafef00d';
    const repoRelative = 'settings/keys.json';
    const dest = getRepoScopedDestination(repoKey, repoRelative);

    cloneSetup = (dir: string) => {
      const manifest = createMockManifest({
        files: {
          repofile: createMockTrackedFile({
            source: `${repoKey}:${repoRelative}`,
            destination: dest,
            scope: 'repo',
            repoKey,
            repoRelative,
          }),
        },
      });

      vol.mkdirSync(join(dir, 'files', 'repos', repoKey, 'settings'), { recursive: true });
      vol.writeFileSync(join(dir, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(dir, dest), '{"k":1}');
    };

    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('user/repo', { json: true, yes: true } as never);

    writeSpy.mockRestore();
    const env = JSON.parse(writes.join('').trim());

    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck apply');
    // Nothing applied; the unbound repo file is reported as skipped.
    expect(env.data.applied).toBe(0);
    expect(Array.isArray(env.data.skipped)).toBe(true);
    expect(env.data.skipped).toContain(`${repoKey}:${repoRelative}`);
    expect(loggerSuccessMock).not.toHaveBeenCalled();
  });

  it('binds an unbound repo via --repo-root then writes the repo file there', async () => {
    // On a fresh machine the repo is unbound; --repo-root binds the single repoKey
    // present so the apply can place the file in the freshly-linked checkout.
    const { getRepoScopedDestination } = await import('../../src/lib/paths.js');
    const repoKey = 'freshrepo-12345678';
    const repoRoot = '/freshly/cloned/repo';
    const repoRelative = 'config/init.lua';
    const dest = getRepoScopedDestination(repoKey, repoRelative);

    cloneSetup = (dir: string) => {
      const manifest = createMockManifest({
        files: {
          repofile: createMockTrackedFile({
            source: `${repoKey}:${repoRelative}`,
            destination: dest,
            scope: 'repo',
            repoKey,
            repoRelative,
          }),
        },
      });

      vol.mkdirSync(join(dir, 'files', 'repos', repoKey, 'config'), { recursive: true });
      vol.writeFileSync(join(dir, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
      vol.writeFileSync(join(dir, dest), '-- lua config');
    };

    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('user/repo', { replace: true, repoRoot } as never);

    expect(vol.readFileSync(join(repoRoot, repoRelative), 'utf-8')).toBe('-- lua config');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Applied 1 files');
  });

  it('supports explicit GitLab-prefixed apply sources', async () => {
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

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply('gitlab:team/dotfiles', { dryRun: true });

    expect(cloneRepoMock).toHaveBeenCalledWith('https://gitlab.com/team/dotfiles.git', expect.any(String));
  });
});
