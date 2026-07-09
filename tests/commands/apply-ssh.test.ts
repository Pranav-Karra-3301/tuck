/**
 * Integration tests for `tuck apply --target/--ssh` (remote apply).
 *
 * The transfer runner is INJECTED, so these exercise the full command flow —
 * manifest load, plan build, confirmation gate, per-file push, JSON envelope —
 * without ever touching the network, a real keychain, or the real $HOME (memfs +
 * a temp tuck dir under the mocked home).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

const loggerWarningMock = vi.fn();
const loggerSuccessMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerFileMock = vi.fn();
const confirmMock = vi.fn().mockResolvedValue(true);

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    note: vi.fn(),
    confirm: confirmMock,
    select: vi.fn(),
    cancel: vi.fn(),
  },
  logger: {
    info: loggerInfoMock,
    success: loggerSuccessMock,
    warning: loggerWarningMock,
    heading: vi.fn(),
    blank: vi.fn(),
    file: loggerFileMock,
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

const seedManifest = (
  files: Record<string, ReturnType<typeof createMockTrackedFile>>
): void => {
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  const manifest = createMockManifest({ files });
  vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
};

const writeRepoFile = (rel: string, content = 'x'): void => {
  const abs = join(TEST_TUCK_DIR, rel);
  vol.mkdirSync(join(abs, '..'), { recursive: true });
  vol.writeFileSync(abs, content);
};

describe('runSshApply', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    const { clearManifestCache } = await import('../../src/lib/manifest.js');
    clearManifestCache();
    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
    confirmMock.mockResolvedValue(true);
  });

  afterEach(async () => {
    vol.reset();
    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
  });

  it('pushes each tracked file to the remote via ssh mkdir + scp', async () => {
    seedManifest({
      a: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
      b: createMockTrackedFile({
        source: '~/.config/nvim/init.lua',
        destination: 'files/editor/nvim/init.lua',
      }),
    });
    writeRepoFile('files/shell/zshrc', 'export A=1');
    writeRepoFile('files/editor/nvim/init.lua', '-- lua');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = vi.fn(async (cmd: 'ssh' | 'scp', args: string[]) => {
      calls.push({ cmd, args });
    });

    const { runSshApply } = await import('../../src/commands/apply.js');
    await runSshApply({ target: 'ssh://me@box:2222', yes: true }, runner);

    // Two files → for the nested one an ssh mkdir precedes the scp; the top-level
    // one is a bare scp. Assert the scp destinations landed at remote home paths.
    const scps = calls.filter((c) => c.cmd === 'scp').map((c) => c.args[c.args.length - 1]);
    expect(scps).toContain("me@box:'.zshrc'");
    expect(scps).toContain("me@box:'.config/nvim/init.lua'");

    // The nested file's parent dir was created first with the -p ssh port flag.
    const mkdir = calls.find((c) => c.cmd === 'ssh');
    expect(mkdir?.args).toEqual(['-p', '2222', 'me@box', "mkdir -p '.config/nvim'"]);

    expect(loggerSuccessMock).toHaveBeenCalledWith('Pushed 2 file(s) to me@box:2222');
  });

  it('does not transfer anything on --dry-run', async () => {
    seedManifest({
      a: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
    });
    writeRepoFile('files/shell/zshrc');

    const runner = vi.fn(async () => {});
    const { runSshApply } = await import('../../src/commands/apply.js');
    await runSshApply({ ssh: 'box', dryRun: true, yes: true }, runner);

    expect(runner).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith('Dry run - would push 1 file(s) to box');
  });

  it('aborts without transferring when the interactive confirm is declined', async () => {
    seedManifest({
      a: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
    });
    writeRepoFile('files/shell/zshrc');
    confirmMock.mockResolvedValue(false);

    const runner = vi.fn(async () => {});
    // Force an interactive session: no --yes/--force/--json, TTY on.
    const originalTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const { runSshApply } = await import('../../src/commands/apply.js');
      await runSshApply({ ssh: 'box' }, runner);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalTty, configurable: true });
    }

    expect(runner).not.toHaveBeenCalled();
  });

  it('emits a JSON envelope with applied count and target', async () => {
    seedManifest({
      a: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
    });
    writeRepoFile('files/shell/zshrc');

    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const runner = vi.fn(async () => {});
    const { runSshApply } = await import('../../src/commands/apply.js');
    await runSshApply({ target: 'box', json: true }, runner);

    writeSpy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck apply');
    expect(env.data.applied).toBe(1);
    expect(env.data.target).toBe('box');
  });

  it('warns and pushes nothing when no tracked files map to a remote path', async () => {
    seedManifest({
      r: createMockTrackedFile({
        source: 'repo-cafef00d:config/x.toml',
        destination: 'files/repos/repo-cafef00d/config/x.toml',
        scope: 'repo',
        repoKey: 'repo-cafef00d',
        repoRelative: 'config/x.toml',
      }),
    });

    const runner = vi.fn(async () => {});
    const { runSshApply } = await import('../../src/commands/apply.js');
    await runSshApply({ ssh: 'box', yes: true }, runner);

    expect(runner).not.toHaveBeenCalled();
    expect(loggerWarningMock).toHaveBeenCalledWith('No files to push');
  });

  it('reports per-file failures without aborting the whole push', async () => {
    seedManifest({
      a: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
      b: createMockTrackedFile({ source: '~/.bashrc', destination: 'files/shell/bashrc' }),
    });
    writeRepoFile('files/shell/zshrc');
    writeRepoFile('files/shell/bashrc');

    const runner = vi.fn(async (_cmd: 'ssh' | 'scp', args: string[]) => {
      if (args[args.length - 1].includes('.bashrc')) {
        throw new Error('scp: connection closed');
      }
    });

    const { runSshApply } = await import('../../src/commands/apply.js');
    await runSshApply({ ssh: 'box', yes: true }, runner);

    expect(loggerWarningMock).toHaveBeenCalledWith('Pushed 1 file(s), 1 failed');
  });
});
