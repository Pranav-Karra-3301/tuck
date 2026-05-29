import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadManifestMock = vi.fn();
const checkLocalModeMock = vi.fn();
const showLocalModeWarningForPullMock = vi.fn();
const pullMock = vi.fn();
const fetchMock = vi.fn();
const hasRemoteMock = vi.fn();
const getRemoteUrlMock = vi.fn();
const getStatusMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const runRestoreMock = vi.fn();
const loggerSuccessMock = vi.fn();
const loggerInfoMock = vi.fn();
const promptsIntroMock = vi.fn();
const promptsOutroMock = vi.fn();
const promptsConfirmMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: promptsIntroMock,
    outro: promptsOutroMock,
    confirm: promptsConfirmMock,
    note: vi.fn(),
    cancel: vi.fn(),
    log: {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
  },
  logger: {
    success: loggerSuccessMock,
    info: loggerInfoMock,
  },
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  colors: {
    dim: (x: string) => x,
    yellow: (x: string) => x,
  },
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
}));

vi.mock('../../src/lib/remoteChecks.js', () => ({
  checkLocalMode: checkLocalModeMock,
  showLocalModeWarningForPull: showLocalModeWarningForPullMock,
}));

vi.mock('../../src/lib/git.js', () => ({
  pull: pullMock,
  fetch: fetchMock,
  hasRemote: hasRemoteMock,
  getRemoteUrl: getRemoteUrlMock,
  getStatus: getStatusMock,
  getCurrentBranch: getCurrentBranchMock,
}));

vi.mock('../../src/commands/restore.js', () => ({
  runRestore: runRestoreMock,
}));

describe('pull command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    checkLocalModeMock.mockResolvedValue(false);
    showLocalModeWarningForPullMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(undefined);
    pullMock.mockResolvedValue(undefined);
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('https://github.com/example/dotfiles.git');
    getCurrentBranchMock.mockResolvedValue('main');
    runRestoreMock.mockResolvedValue(undefined);
    promptsConfirmMock.mockResolvedValue(true);
    getStatusMock.mockResolvedValue({
      behind: 0,
      ahead: 0,
      modified: [],
      staged: [],
    });
  });

  it('throws NOT_INITIALIZED when manifest is missing', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));
    const { pullCommand } = await import('../../src/commands/pull.js');

    await expect(pullCommand.parseAsync(['node', 'pull', '--rebase'], { from: 'user' })).rejects.toMatchObject({
      code: 'NOT_INITIALIZED',
    });
  });

  it('pulls with rebase in non-interactive mode', async () => {
    const { pullCommand } = await import('../../src/commands/pull.js');

    await pullCommand.parseAsync(['node', 'pull', '--rebase'], { from: 'user' });

    expect(fetchMock).toHaveBeenCalledWith('/test-home/.tuck');
    expect(pullMock).toHaveBeenCalledWith('/test-home/.tuck', { rebase: true });
    expect(loggerSuccessMock).toHaveBeenCalledWith('Pulled successfully!');
  });

  it('restores tracked files after non-interactive pull when --restore is passed', async () => {
    const { pullCommand } = await import('../../src/commands/pull.js');

    await pullCommand.parseAsync(['node', 'pull', '--restore'], { from: 'user' });

    expect(fetchMock).toHaveBeenCalledWith('/test-home/.tuck');
    expect(pullMock).toHaveBeenCalledWith('/test-home/.tuck', { rebase: undefined });
    expect(runRestoreMock).toHaveBeenCalledWith({ all: true });
  });

  it('runs interactive flow when no flags are provided', async () => {
    const { pullCommand } = await import('../../src/commands/pull.js');

    await pullCommand.parseAsync(['node', 'pull'], { from: 'user' });

    expect(promptsIntroMock).toHaveBeenCalledWith('tuck pull');
    expect(fetchMock).toHaveBeenCalledWith('/test-home/.tuck');
  });

  it('restores tracked files when interactive pull confirmation is accepted', async () => {
    getStatusMock.mockResolvedValueOnce({
      behind: 1,
      ahead: 0,
      modified: [],
      staged: [],
    });
    promptsConfirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { pullCommand } = await import('../../src/commands/pull.js');

    await pullCommand.parseAsync(['node', 'pull'], { from: 'user' });

    expect(pullMock).toHaveBeenCalledWith('/test-home/.tuck', { rebase: false });
    expect(runRestoreMock).toHaveBeenCalledWith({ all: true });
  });

  it('skips restore when interactive pull confirmation is declined', async () => {
    getStatusMock.mockResolvedValueOnce({
      behind: 1,
      ahead: 0,
      modified: [],
      staged: [],
    });
    promptsConfirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const { pullCommand } = await import('../../src/commands/pull.js');

    await pullCommand.parseAsync(['node', 'pull'], { from: 'user' });

    expect(pullMock).toHaveBeenCalledWith('/test-home/.tuck', { rebase: false });
    expect(runRestoreMock).not.toHaveBeenCalled();
  });

  it('throws when in local-only mode', async () => {
    checkLocalModeMock.mockResolvedValueOnce(true);
    const { pullCommand } = await import('../../src/commands/pull.js');

    await expect(pullCommand.parseAsync(['node', 'pull', '--rebase'], { from: 'user' })).rejects.toMatchObject({
      code: 'GIT_ERROR',
    });
  });

  it('emits a JSON envelope on a successful --json pull', async () => {
    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { pullCommand } = await import('../../src/commands/pull.js');
    await pullCommand.parseAsync(['node', 'pull', '--rebase', '--json'], { from: 'user' });

    writeSpy.mockRestore();

    expect(fetchMock).toHaveBeenCalledWith('/test-home/.tuck');
    expect(pullMock).toHaveBeenCalledWith('/test-home/.tuck', { rebase: true });

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck pull');
    expect(env.data.pulled).toBe(true);

    // Human output must be suppressed on the JSON path.
    expect(loggerSuccessMock).not.toHaveBeenCalled();
  });

  it('reflects restore in the --json --restore envelope without printing human output', async () => {
    const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    __resetJsonEmitState();

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { pullCommand } = await import('../../src/commands/pull.js');
    await pullCommand.parseAsync(['node', 'pull', '--restore', '--json'], { from: 'user' });

    writeSpy.mockRestore();

    expect(pullMock).toHaveBeenCalledWith('/test-home/.tuck', { rebase: undefined });
    expect(runRestoreMock).toHaveBeenCalledWith({ all: true });

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck pull');
    expect(env.data.pulled).toBe(true);
    expect(loggerSuccessMock).not.toHaveBeenCalled();
  });
});
