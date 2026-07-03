/**
 * Local-mode push gating via assertRemoteAvailable.
 *
 * When config.remote.mode === 'local', a push must be refused even if a stray
 * git 'origin' remote is present. push.ts consults the provider gate
 * (assertRemoteAvailable) — which throws LocalModeError in local mode — before
 * ever invoking git push. In a non-local mode the push proceeds as normal.
 */

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
const loadConfigMock = vi.fn();
const assertRemoteAvailableMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    confirmDangerous: vi.fn().mockResolvedValue(true),
    text: vi.fn().mockResolvedValue('git@github.com:user/dotfiles.git'),
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
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
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

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  assertRemoteAvailable: assertRemoteAvailableMock,
}));

describe('push command local-mode gating', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    checkLocalModeMock.mockResolvedValue(false);
    showLocalModeWarningForPushMock.mockResolvedValue(undefined);
    pushMock.mockResolvedValue(undefined);
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('git@github.com:user/dotfiles.git');
    getStatusMock.mockResolvedValue({ ahead: 2, behind: 0, tracking: 'origin/main' });
    getCurrentBranchMock.mockResolvedValue('main');
    addRemoteMock.mockResolvedValue(undefined);
    logForcePushMock.mockResolvedValue(undefined);
    // Default: remote mode is github (non-local) and the gate is a no-op.
    loadConfigMock.mockResolvedValue({ remote: { mode: 'github' } });
    assertRemoteAvailableMock.mockImplementation(() => {});
  });

  it('refuses to push in local mode even when a stray origin remote exists', async () => {
    // checkLocalMode is bypassed (stale/false) but config IS local-only and a
    // stray origin is present — the provider gate must still refuse the push.
    checkLocalModeMock.mockResolvedValue(false);
    hasRemoteMock.mockResolvedValue(true);
    loadConfigMock.mockResolvedValue({ remote: { mode: 'local' } });
    assertRemoteAvailableMock.mockImplementation((cfg: { mode: string }, op: string) => {
      if (cfg.mode === 'local') {
        throw new Error(`Cannot ${op} in local-only mode`);
      }
    });

    const { pushCommand } = await import('../../src/commands/push.js');

    await expect(pushCommand.parseAsync(['--set-upstream'], { from: 'user' })).rejects.toThrow(
      /local-only mode/
    );

    // The provider gate was consulted with the push operation.
    expect(assertRemoteAvailableMock).toHaveBeenCalledWith({ mode: 'local' }, 'push');
    // git push was NEVER invoked.
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('proceeds with the push in a non-local mode', async () => {
    loadConfigMock.mockResolvedValue({ remote: { mode: 'github' } });

    const { pushCommand } = await import('../../src/commands/push.js');
    await pushCommand.parseAsync(['--set-upstream'], { from: 'user' });

    expect(assertRemoteAvailableMock).toHaveBeenCalledWith({ mode: 'github' }, 'push');
    expect(pushMock).toHaveBeenCalledWith('/test-home/.tuck', {
      force: undefined,
      setUpstream: true,
      branch: 'main',
    });
  });
});
