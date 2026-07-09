import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadManifestMock = vi.fn();
const checkLocalModeMock = vi.fn();
const showLocalModeWarningForPushMock = vi.fn();
const pushMock = vi.fn();
const fetchMock = vi.fn();
const hasRemoteMock = vi.fn();
const getRemoteUrlMock = vi.fn();
const getStatusMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const addRemoteMock = vi.fn();
const logForcePushMock = vi.fn();

const promptsIntroMock = vi.fn();
const promptsOutroMock = vi.fn();
const promptsConfirmMock = vi.fn();
const promptsConfirmDangerousMock = vi.fn();
const promptsTextMock = vi.fn();
const promptsCancelMock = vi.fn();

const promptsLogInfoMock = vi.fn();
const promptsLogSuccessMock = vi.fn();
const promptsLogWarningMock = vi.fn();
const promptsLogErrorMock = vi.fn();

const loggerSuccessMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarningMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: promptsIntroMock,
    outro: promptsOutroMock,
    confirm: promptsConfirmMock,
    confirmDangerous: promptsConfirmDangerousMock,
    text: promptsTextMock,
    cancel: promptsCancelMock,
    note: vi.fn(),
    log: {
      info: promptsLogInfoMock,
      success: promptsLogSuccessMock,
      warning: promptsLogWarningMock,
      error: promptsLogErrorMock,
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
  fetch: fetchMock,
  hasRemote: hasRemoteMock,
  getRemoteUrl: getRemoteUrlMock,
  getStatus: getStatusMock,
  getCurrentBranch: getCurrentBranchMock,
  addRemote: addRemoteMock,
}));

vi.mock('../../src/lib/audit.js', () => ({
  logForcePush: logForcePushMock,
}));

// push.ts loads config and consults the provider gate before pushing. Mock both
// so these tests exercise the (non-local) happy path without touching real config.
const loadConfigMock = vi.fn();
const assertRemoteAvailableMock = vi.fn();

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  assertRemoteAvailable: assertRemoteAvailableMock,
}));

const originalStdinTTY = process.stdin.isTTY;
const setStdinTTY = (value: boolean): void => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    writable: true,
    configurable: true,
  });
};

describe('push command', () => {
  afterEach(() => {
    setStdinTTY(originalStdinTTY as boolean);
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Default to a simulated interactive TTY so the prompt paths are reachable;
    // the non-interactive regression tests below flip this off explicitly.
    setStdinTTY(true);

    loadManifestMock.mockResolvedValue({ files: {} });
    checkLocalModeMock.mockResolvedValue(false);
    loadConfigMock.mockResolvedValue({ remote: { mode: 'github' } });
    assertRemoteAvailableMock.mockImplementation(() => {});
    showLocalModeWarningForPushMock.mockResolvedValue(undefined);
    pushMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(undefined);
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('git@github.com:user/dotfiles.git');
    getStatusMock.mockResolvedValue({
      ahead: 2,
      behind: 0,
      tracking: undefined,
    });
    getCurrentBranchMock.mockResolvedValue('main');
    addRemoteMock.mockResolvedValue(undefined);
    logForcePushMock.mockResolvedValue(undefined);
    promptsConfirmMock.mockResolvedValue(true);
    promptsConfirmDangerousMock.mockResolvedValue(true);
    promptsTextMock.mockResolvedValue('git@github.com:user/dotfiles.git');
  });

  it('throws NOT_INITIALIZED when the manifest is missing', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));
    const { pushCommand } = await import('../../src/commands/push.js');

    await expect(pushCommand.parseAsync(['--force'], { from: 'user' })).rejects.toMatchObject({
      code: 'NOT_INITIALIZED',
    });
  });

  it('throws when in local-only mode', async () => {
    checkLocalModeMock.mockResolvedValueOnce(true);
    const { pushCommand } = await import('../../src/commands/push.js');

    await expect(
      pushCommand.parseAsync(['--set-upstream'], { from: 'user' })
    ).rejects.toMatchObject({
      code: 'GIT_ERROR',
    });
  });

  it('sets upstream on the current branch in non-interactive mode', async () => {
    // --set-upstream is a boolean trigger: it always pushes the CURRENT branch,
    // never a ref named after a flag value.
    getCurrentBranchMock.mockResolvedValue('main');
    const { pushCommand } = await import('../../src/commands/push.js');

    await pushCommand.parseAsync(['--set-upstream'], { from: 'user' });

    expect(pushMock).toHaveBeenCalledWith('/test-home/.tuck', {
      force: undefined,
      setUpstream: true,
      branch: 'main',
    });
    expect(loggerSuccessMock).toHaveBeenCalledWith('Pushed successfully!');
  });

  it('cancels force pushes when dangerous confirmation is denied', async () => {
    promptsConfirmDangerousMock.mockResolvedValueOnce(false);
    const { pushCommand } = await import('../../src/commands/push.js');

    await pushCommand.parseAsync(['--force'], { from: 'user' });

    expect(pushMock).not.toHaveBeenCalled();
    expect(logForcePushMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith('Push cancelled');
  });

  it('fails non-zero on --force in non-interactive mode instead of a false success', async () => {
    // `tuck push --force` on a non-TTY (agent/CI) cannot confirm the dangerous
    // op and was NOT pre-authorized via --yes/--json. It must throw a typed,
    // non-zero error rather than print "Push cancelled" and exit 0 having pushed
    // nothing.
    setStdinTTY(false);
    const { pushCommand } = await import('../../src/commands/push.js');

    await expect(pushCommand.parseAsync(['--force'], { from: 'user' })).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
      exitCode: 1,
    });

    // Never pushed, never audited, never falsely reported success.
    expect(pushMock).not.toHaveBeenCalled();
    expect(logForcePushMock).not.toHaveBeenCalled();
    expect(promptsConfirmDangerousMock).not.toHaveBeenCalled();
  });

  it('surfaces an actionable --yes hint in the non-interactive --force error', async () => {
    setStdinTTY(false);
    const { pushCommand } = await import('../../src/commands/push.js');

    await expect(pushCommand.parseAsync(['--force'], { from: 'user' })).rejects.toThrow(/--yes/);
  });

  it('force pushes without prompting when --force --yes is passed non-interactively', async () => {
    // --yes is the explicit opt-in: it must skip the confirmation AND actually
    // push (never route through the non-interactive throw above).
    setStdinTTY(false);
    getStatusMock.mockResolvedValue({ ahead: 1, behind: 0, tracking: 'origin/main' });
    const { pushCommand } = await import('../../src/commands/push.js');

    await pushCommand.parseAsync(['--force', '--yes'], { from: 'user' });

    expect(promptsConfirmDangerousMock).not.toHaveBeenCalled();
    expect(logForcePushMock).toHaveBeenCalledWith('main');
    expect(pushMock).toHaveBeenCalledWith('/test-home/.tuck', {
      force: true,
      setUpstream: false,
      branch: 'main',
    });
  });

  it('runs the interactive push flow and sets upstream when needed', async () => {
    const { pushCommand } = await import('../../src/commands/push.js');

    await pushCommand.parseAsync([], { from: 'user' });

    expect(promptsIntroMock).toHaveBeenCalledWith('tuck push');
    expect(pushMock).toHaveBeenCalledWith('/test-home/.tuck', {
      setUpstream: true,
      branch: 'main',
    });
    expect(promptsLogSuccessMock).toHaveBeenCalledWith('Pushed successfully!');
  });

  it('fetches before evaluating divergence in the interactive push flow', async () => {
    const { pushCommand } = await import('../../src/commands/push.js');

    await pushCommand.parseAsync([], { from: 'user' });

    // Divergence must be measured against fresh remote-tracking refs, not the
    // last fetch — otherwise the "behind remote" safety offer never fires.
    expect(fetchMock).toHaveBeenCalledWith('/test-home/.tuck');
  });

  it('takes the deterministic (non-interactive) path for --yes without other flags', async () => {
    getStatusMock.mockResolvedValue({ ahead: 1, behind: 0, tracking: 'origin/main' });
    const { pushCommand } = await import('../../src/commands/push.js');

    await pushCommand.parseAsync(['--yes'], { from: 'user' });

    // `tuck push --yes` must not route into runInteractivePush (which would
    // throw on a non-TTY telling the user to pass --yes, the flag they passed).
    expect(promptsIntroMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith('/test-home/.tuck', {
      force: undefined,
      setUpstream: false,
      branch: 'main',
    });
    expect(loggerSuccessMock).toHaveBeenCalledWith('Pushed successfully!');
  });

  it('emits a JSON envelope on a successful --json --force push', async () => {
    getStatusMock.mockResolvedValue({ ahead: 3, behind: 0, tracking: 'origin/main' });
    getCurrentBranchMock.mockResolvedValue('main');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { pushCommand } = await import('../../src/commands/push.js');
    await pushCommand.parseAsync(['--json', '--force'], { from: 'user' });

    writeSpy.mockRestore();

    expect(pushMock).toHaveBeenCalled();
    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck push');
    expect(env.data.pushed).toBe(true);
    expect(env.data.ahead).toBe(3);
    expect(env.data.branch).toBe('main');

    // Human output must be suppressed on the JSON path.
    expect(loggerSuccessMock).not.toHaveBeenCalled();
  });

  it('emits a JSON envelope on a plain --json push without going interactive', async () => {
    getStatusMock.mockResolvedValue({ ahead: 1, behind: 0, tracking: 'origin/main' });
    getCurrentBranchMock.mockResolvedValue('main');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    const { pushCommand } = await import('../../src/commands/push.js');
    await pushCommand.parseAsync(['--json'], { from: 'user' });

    writeSpy.mockRestore();

    // Must not invoke the interactive flow.
    expect(promptsIntroMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalled();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck push');
    expect(env.data.pushed).toBe(true);
    expect(env.data.ahead).toBe(1);
    expect(env.data.branch).toBe('main');
  });
});
