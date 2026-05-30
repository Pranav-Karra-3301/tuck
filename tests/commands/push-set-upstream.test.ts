import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadManifestMock = vi.fn();
const checkLocalModeMock = vi.fn();
const showLocalModeWarningForPushMock = vi.fn();
const pushMock = vi.fn();
const hasRemoteMock = vi.fn();
const getRemoteUrlMock = vi.fn();
const getStatusMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const addRemoteMock = vi.fn();
const logForcePushMock = vi.fn();

const loggerSuccessMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarningMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    confirmDangerous: vi.fn().mockResolvedValue(true),
    text: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  },
  logger: {
    success: loggerSuccessMock,
    info: loggerInfoMock,
    warning: loggerWarningMock,
  },
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  colors: {
    dim: (value: string) => value,
    yellow: (value: string) => value,
    green: (value: string) => value,
    cyan: (value: string) => value,
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
  showLocalModeWarningForPush: showLocalModeWarningForPushMock,
}));

vi.mock('../../src/lib/git.js', () => ({
  push: pushMock,
  hasRemote: hasRemoteMock,
  getRemoteUrl: getRemoteUrlMock,
  getStatus: getStatusMock,
  getCurrentBranch: getCurrentBranchMock,
  addRemote: addRemoteMock,
}));

vi.mock('../../src/lib/audit.js', () => ({
  logForcePush: logForcePushMock,
}));

describe('push --set-upstream (boolean trigger)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    checkLocalModeMock.mockResolvedValue(false);
    showLocalModeWarningForPushMock.mockResolvedValue(undefined);
    pushMock.mockResolvedValue(undefined);
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('git@github.com:user/dotfiles.git');
    getStatusMock.mockResolvedValue({ ahead: 2, behind: 0, tracking: undefined });
    getCurrentBranchMock.mockResolvedValue('main');
    addRemoteMock.mockResolvedValue(undefined);
    logForcePushMock.mockResolvedValue(undefined);
  });

  it('pushes the CURRENT branch, never a ref named after the flag value', async () => {
    // The current branch is `main`. Passing `--set-upstream` must set upstream
    // for `main` — it must NOT push a branch literally named "main" only by
    // accident, and crucially must NOT push some other ref derived from a flag
    // string. We prove this by making the current branch distinct from any
    // plausible flag string.
    getCurrentBranchMock.mockResolvedValue('feature/work');

    const { pushCommand } = await import('../../src/commands/push.js');
    await pushCommand.parseAsync(['--set-upstream'], { from: 'user' });

    expect(pushMock).toHaveBeenCalledWith('/test-home/.tuck', {
      force: undefined,
      setUpstream: true,
      branch: 'feature/work',
    });
    // The flag value must never leak into the branch ref.
    const call = pushMock.mock.calls[0][1];
    expect(call.branch).toBe('feature/work');
    expect(typeof call.setUpstream).toBe('boolean');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Pushed successfully!');
  });
});
