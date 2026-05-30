/**
 * config remote dedup tests.
 *
 * `tuck config remote` had its own ad-hoc remote-setup flow (createRepo +
 * getPreferredRepoUrl + addRemote) separate from init. It now delegates to the
 * SAME shared, provider-agnostic setupRemoteForProvider(provider, tuckDir), so
 * gitlab/custom go through their own provider rather than a github-shaped path.
 *
 * We assert at the seam: when setupProvider() returns a gitlab provider with no
 * remoteUrl, runConfigRemote calls the shared helper with THAT gitlab provider
 * and wires up the gitlab URL it returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setupRemoteForProviderMock = vi.fn();
const setupProviderMock = vi.fn();
const getProviderMock = vi.fn();
const addRemoteMock = vi.fn();
const upsertRemoteMock = vi.fn();
const hasRemoteMock = vi.fn();
const removeRemoteMock = vi.fn();
const saveConfigMock = vi.fn();
const loadConfigMock = vi.fn();

// Hoisted so the ui mock factory can wire them up and tests can assert on the
// final success/warning message that runConfigRemote prints.
const { logSuccessMock, logWarningMock } = vi.hoisted(() => ({
  logSuccessMock: vi.fn(),
  logWarningMock: vi.fn(),
}));

vi.mock('../../src/lib/remoteSetup.js', () => ({
  setupRemoteForProvider: (...args: unknown[]) => setupRemoteForProviderMock(...args),
}));

vi.mock('../../src/lib/providerSetup.js', () => ({
  setupProvider: (...args: unknown[]) => setupProviderMock(...args),
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  getProvider: (...args: unknown[]) => getProviderMock(...args),
  describeProviderConfig: vi.fn(() => 'GitLab'),
}));

vi.mock('../../src/lib/git.js', () => ({
  addRemote: (...args: unknown[]) => addRemoteMock(...args),
  upsertRemote: (...args: unknown[]) => upsertRemoteMock(...args),
  removeRemote: (...args: unknown[]) => removeRemoteMock(...args),
  hasRemote: (...args: unknown[]) => hasRemoteMock(...args),
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
  resetConfig: vi.fn(),
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  getConfigPath: vi.fn((d: string) => `${d}/.tuckrc.json`),
  collapsePath: vi.fn((p: string) => p),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: vi.fn(),
}));

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn(async () => true),
    select: vi.fn(),
    text: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: logSuccessMock, warning: logWarningMock, error: vi.fn() },
  },
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  colors: {
    dim: (x: string) => x,
    bold: { cyan: (x: string) => x },
    cyan: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
    white: (x: string) => x,
  },
}));

describe('runConfigRemote dedup via setupRemoteForProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue({ remote: { mode: 'local' } });
    hasRemoteMock.mockResolvedValue(false);
    upsertRemoteMock.mockResolvedValue(undefined);
    addRemoteMock.mockResolvedValue(undefined);
    saveConfigMock.mockResolvedValue(undefined);
  });

  it('delegates the gitlab no-remoteUrl path to the shared setupRemoteForProvider', async () => {
    const gitlabProvider = {
      mode: 'gitlab',
      displayName: 'GitLab',
      requiresRemote: true,
    };
    getProviderMock.mockReturnValue(gitlabProvider);

    // setupProvider resolves a gitlab provider but NO remoteUrl (the old ad-hoc
    // createRepo branch). The dedup must route this through the shared helper.
    setupProviderMock.mockResolvedValue({
      success: true,
      mode: 'gitlab',
      config: { mode: 'gitlab', username: 'me' },
      provider: gitlabProvider,
    });

    const gitlabUrl = 'git@gitlab.com:me/dotfiles.git';
    setupRemoteForProviderMock.mockResolvedValue({ remoteUrl: gitlabUrl, pushed: false });

    const { runConfigRemote } = await import('../../src/commands/config.js');
    await runConfigRemote();

    // The shared helper was called with the gitlab provider (the dedup). The
    // helper itself owns the addRemote('origin', gitlabUrl) wiring.
    expect(setupRemoteForProviderMock).toHaveBeenCalledWith(gitlabProvider, '/test-home/.tuck');
    expect(getProviderMock).toHaveBeenCalledWith('gitlab', { mode: 'gitlab', username: 'me' });

    // config.ts must NOT itself add a github.com remote on the gitlab path.
    const directRemoteUrls = addRemoteMock.mock.calls.map((c) => c[2]);
    expect(directRemoteUrls.every((u: string) => !String(u).includes('github.com'))).toBe(true);
  });

  it('does not call the shared helper for local mode (no remote needed)', async () => {
    const localProvider = { mode: 'local', displayName: 'Local Only', requiresRemote: false };
    getProviderMock.mockReturnValue(localProvider);
    setupProviderMock.mockResolvedValue({
      success: true,
      mode: 'local',
      config: { mode: 'local' },
      provider: localProvider,
    });

    const { runConfigRemote } = await import('../../src/commands/config.js');
    await runConfigRemote();

    expect(setupRemoteForProviderMock).not.toHaveBeenCalled();
    expect(addRemoteMock).not.toHaveBeenCalled();
    expect(upsertRemoteMock).not.toHaveBeenCalled();
  });

  it('upserts (never remove+add) when reconfiguring an existing origin with a returned URL', async () => {
    const gitlabProvider = { mode: 'gitlab', displayName: 'GitLab', requiresRemote: true };
    getProviderMock.mockReturnValue(gitlabProvider);

    // setupProvider returns a concrete remoteUrl (the line-586 branch), AND an
    // origin already exists — the old code did remove+add (a race window with no
    // origin); the fix must upsert in place.
    hasRemoteMock.mockResolvedValue(true);
    const gitlabUrl = 'git@gitlab.com:me/dotfiles.git';
    setupProviderMock.mockResolvedValue({
      success: true,
      mode: 'gitlab',
      remoteUrl: gitlabUrl,
      config: { mode: 'gitlab', username: 'me' },
      provider: gitlabProvider,
    });

    const { runConfigRemote } = await import('../../src/commands/config.js');
    await runConfigRemote();

    // Reconfigure path upserts the new URL in place; no remove+add race.
    expect(upsertRemoteMock).toHaveBeenCalledWith('/test-home/.tuck', 'origin', gitlabUrl);
    expect(removeRemoteMock).not.toHaveBeenCalled();
    // With a real remote configured, the helper should not be needed.
    expect(setupRemoteForProviderMock).not.toHaveBeenCalled();
  });

  it('warns (does NOT claim success) when the helper configures no remote for a non-local provider', async () => {
    const gitlabProvider = { mode: 'gitlab', displayName: 'GitLab', requiresRemote: true };
    getProviderMock.mockReturnValue(gitlabProvider);

    // setupProvider returns no remoteUrl → routes to the shared helper, which
    // itself returns a NULL remoteUrl (user bailed / no repo created).
    setupProviderMock.mockResolvedValue({
      success: true,
      mode: 'gitlab',
      config: { mode: 'gitlab', username: 'me' },
      provider: gitlabProvider,
    });
    setupRemoteForProviderMock.mockResolvedValue({ remoteUrl: null, pushed: false });

    const { runConfigRemote } = await import('../../src/commands/config.js');
    await runConfigRemote();

    // The shared helper ran but configured nothing; the final message must be a
    // warning, NOT a false "Remote configured" success.
    expect(setupRemoteForProviderMock).toHaveBeenCalledWith(gitlabProvider, '/test-home/.tuck');
    expect(logWarningMock).toHaveBeenCalled();
    const successMessages = logSuccessMock.mock.calls.map((c) => String(c[0]));
    expect(successMessages.some((m) => /remote configured/i.test(m))).toBe(false);
  });
});
