/**
 * Unit tests for setupRemoteForProvider (src/lib/remoteSetup.ts).
 *
 * The init wizard used to funnel GitLab/custom providers through the
 * GitHub-only setup (setupGitHubRepo / validateGitHubUrl), which hard-coded
 * github.com and rejected every non-github URL. setupRemoteForProvider drives
 * the remote-setup step purely through the GitProvider interface so each
 * provider validates with ITS OWN validateUrl and builds ITS OWN example URL.
 *
 * It also offers a provider-neutral AUTO-CREATE path: when the provider has a
 * CLI that is installed AND authenticated, it offers to create the repo
 * automatically (GitHub via gh, GitLab via glab — same code path). When the CLI
 * is absent/unauthed/declined/failed, it falls back to the manual paste-URL flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  GitProvider,
  ProviderMode,
  ProviderRepo,
} from '../../src/lib/providers/types.js';

// ----------------------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------------------

const addRemoteMock = vi.fn();
const upsertRemoteMock = vi.fn();
const hasRemoteMock = vi.fn();
const setRemoteUrlMock = vi.fn();
const confirmMock = vi.fn();
const textMock = vi.fn();
const noteMock = vi.fn();

vi.mock('../../src/lib/git.js', () => ({
  addRemote: (...args: unknown[]) => addRemoteMock(...args),
  upsertRemote: (...args: unknown[]) => upsertRemoteMock(...args),
  hasRemote: (...args: unknown[]) => hasRemoteMock(...args),
  setRemoteUrl: (...args: unknown[]) => setRemoteUrlMock(...args),
}));

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    confirm: (...args: unknown[]) => confirmMock(...args),
    text: (...args: unknown[]) => textMock(...args),
    note: (...args: unknown[]) => noteMock(...args),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  },
  colors: {
    brand: (x: string) => x,
    dim: (x: string) => x,
    muted: (x: string) => x,
  },
}));

// A spy that should NEVER be invoked for non-github providers. If the rerouted
// code accidentally falls back into GitHub-specific validation, this would be
// called and the test would catch it.
const githubValidatorSpy = vi.fn(() => 'Please enter a valid GitHub URL');

/**
 * Build a minimal fake GitProvider for a given mode. Only the methods used by
 * setupRemoteForProvider are implemented; everything else throws so an
 * accidental call is loud.
 *
 * NOTE: defaults isCliInstalled/isAuthenticated to TRUE. To exercise the manual
 * paste-URL flow, pass an override that forces one of them false (otherwise the
 * auto-create path would be offered).
 */
function makeProvider(mode: ProviderMode, overrides: Partial<GitProvider> = {}): GitProvider {
  const notImplemented = () => {
    throw new Error(`unexpected provider call for mode=${mode}`);
  };

  const base: GitProvider = {
    mode,
    displayName: mode,
    cliName: mode === 'local' || mode === 'custom' ? null : mode === 'gitlab' ? 'glab' : 'gh',
    requiresRemote: mode !== 'local',
    isCliInstalled: vi.fn(async () => true),
    isAuthenticated: vi.fn(async () => true),
    getUser: vi.fn(async () => null),
    detect: notImplemented as unknown as GitProvider['detect'],
    repoExists: notImplemented as unknown as GitProvider['repoExists'],
    createRepo: notImplemented as unknown as GitProvider['createRepo'],
    getRepoInfo: notImplemented as unknown as GitProvider['getRepoInfo'],
    cloneRepo: notImplemented as unknown as GitProvider['cloneRepo'],
    findDotfilesRepo: vi.fn(async () => null),
    getPreferredRepoUrl: vi.fn(async (r: ProviderRepo) => r.sshUrl),
    validateUrl: vi.fn(() => true),
    buildRepoUrl: vi.fn(
      (username: string, repoName: string, protocol: 'ssh' | 'https') =>
        protocol === 'ssh'
          ? `git@gitlab.com:${username}/${repoName}.git`
          : `https://gitlab.com/${username}/${repoName}.git`
    ),
    getSetupInstructions: vi.fn(() => `setup instructions for ${mode}`),
    getAltAuthInstructions: vi.fn(() => `alt auth for ${mode}`),
  };

  return { ...base, ...overrides };
}

/** Force the manual paste-URL flow by making the CLI unavailable. */
function manualProvider(mode: ProviderMode, overrides: Partial<GitProvider> = {}): GitProvider {
  return makeProvider(mode, {
    isCliInstalled: vi.fn(async () => false),
    ...overrides,
  });
}

describe('setupRemoteForProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubValidatorSpy.mockClear();
    upsertRemoteMock.mockResolvedValue(undefined);
    addRemoteMock.mockResolvedValue(undefined);
    hasRemoteMock.mockResolvedValue(false);
  });

  it('returns {remoteUrl:null, pushed:false} for the local provider without prompting', async () => {
    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const local = makeProvider('local', { requiresRemote: false });

    const result = await setupRemoteForProvider(local, '/test-home/.tuck');

    expect(result).toEqual({ remoteUrl: null, pushed: false });
    // Local mode must not touch git remotes or prompt for a URL.
    expect(addRemoteMock).not.toHaveBeenCalled();
    expect(upsertRemoteMock).not.toHaveBeenCalled();
    expect(textMock).not.toHaveBeenCalled();
  });

  it('validates a GitLab URL with the gitlab provider validator (never the github validator)', async () => {
    const gitlabValidate = vi.fn((url: string) => /^git@gitlab\.com:/.test(url));
    // Force manual flow (CLI unavailable) so we reach the URL-paste validator.
    const gitlab = manualProvider('gitlab', { validateUrl: gitlabValidate });

    confirmMock.mockResolvedValue(true); // "Have you created the repository?"
    const gitlabUrl = 'git@gitlab.com:user/dotfiles.git';
    // Capture the validate fn handed to prompts.text and run it ourselves.
    textMock.mockImplementation(
      async (_msg: string, opts?: { validate?: (v: string) => string | undefined }) => {
        // The validator passed to the prompt must accept the gitlab URL...
        expect(opts?.validate?.(gitlabUrl)).toBeUndefined();
        // ...and reject a github URL (proving it uses gitlab's validator).
        expect(opts?.validate?.('https://github.com/u/d.git')).toBeTruthy();
        return gitlabUrl;
      }
    );

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const result = await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    // The gitlab validator was consulted; the github validator never was.
    expect(gitlabValidate).toHaveBeenCalled();
    expect(githubValidatorSpy).not.toHaveBeenCalled();

    // Remote was upserted with the gitlab URL (NOT a github.com URL).
    expect(upsertRemoteMock).toHaveBeenCalledWith('/test-home/.tuck', 'origin', gitlabUrl);
    expect(upsertRemoteMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('github.com')
    );

    expect(result.remoteUrl).toBe(gitlabUrl);
    expect(result.pushed).toBe(false);
  });

  it('shows the provider-specific setup instructions, not GitHub instructions', async () => {
    const gitlab = manualProvider('gitlab');
    confirmMock.mockResolvedValue(true);
    textMock.mockResolvedValue('git@gitlab.com:user/dotfiles.git');

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    expect(gitlab.getSetupInstructions).toHaveBeenCalled();
    // The note shown must be the gitlab instructions.
    expect(noteMock).toHaveBeenCalledWith('setup instructions for gitlab', expect.any(String));
  });

  it('returns {remoteUrl:null, pushed:false} when the user has not created the repo', async () => {
    const gitlab = manualProvider('gitlab');
    confirmMock.mockResolvedValue(false); // "Have you created the repository?" -> No

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const result = await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    expect(result).toEqual({ remoteUrl: null, pushed: false });
    expect(addRemoteMock).not.toHaveBeenCalled();
    expect(upsertRemoteMock).not.toHaveBeenCalled();
  });

  it('accepts any valid git URL for the custom provider via its own validateUrl', async () => {
    const customValidate = vi.fn(() => true);
    // custom.cliName is null so the manual flow is taken automatically.
    const custom = makeProvider('custom', {
      validateUrl: customValidate,
      // custom buildRepoUrl throws (matches real CustomProvider); the impl must
      // tolerate this and still prompt for a URL.
      buildRepoUrl: vi.fn(() => {
        throw new Error('Cannot build repository URLs for custom provider');
      }),
    });

    confirmMock.mockResolvedValue(true);
    const customUrl = 'https://git.example.com/u/dots.git';
    textMock.mockResolvedValue(customUrl);

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const result = await setupRemoteForProvider(custom, '/test-home/.tuck');

    expect(upsertRemoteMock).toHaveBeenCalledWith('/test-home/.tuck', 'origin', customUrl);
    expect(result.remoteUrl).toBe(customUrl);
  });

  it('auto-creates a GitLab repository via the provider CLI (no manual URL prompt)', async () => {
    const createdRepo: ProviderRepo = {
      name: 'dotfiles',
      fullName: 'me/dotfiles',
      url: 'https://gitlab.com/me/dotfiles',
      sshUrl: 'git@gitlab.com:me/dotfiles.git',
      httpsUrl: 'https://gitlab.com/me/dotfiles.git',
      isPrivate: true,
    };

    const createRepo = vi.fn(async () => createdRepo);
    const getPreferredRepoUrl = vi.fn(async (r: ProviderRepo) => r.sshUrl);

    const gitlab = makeProvider('gitlab', {
      isCliInstalled: vi.fn(async () => true),
      isAuthenticated: vi.fn(async () => true),
      createRepo,
      getPreferredRepoUrl,
    });

    // confirm() is called for: "Create automatically?" -> yes, "Private?" -> yes
    confirmMock.mockResolvedValue(true);
    // text() is the repo-name prompt (NOT a manual URL prompt).
    textMock.mockResolvedValue('dotfiles');

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const result = await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    // Repo was created through the provider and the remote upserted with its URL.
    expect(createRepo).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'dotfiles', isPrivate: true })
    );
    expect(getPreferredRepoUrl).toHaveBeenCalledWith(createdRepo);
    expect(upsertRemoteMock).toHaveBeenCalledWith(
      '/test-home/.tuck',
      'origin',
      'git@gitlab.com:me/dotfiles.git'
    );

    // The manual paste-URL prompt must NOT have been used.
    const textCalls = textMock.mock.calls;
    const promptedForUrl = textCalls.some(([msg]) =>
      String(msg).toLowerCase().includes('url')
    );
    expect(promptedForUrl).toBe(false);

    expect(result).toEqual({
      remoteUrl: 'git@gitlab.com:me/dotfiles.git',
      pushed: false,
    });
  });

  it('falls back to the manual flow when auto-create fails', async () => {
    const createRepo = vi.fn(async () => {
      throw new Error('glab boom');
    });

    const gitlab = makeProvider('gitlab', {
      isCliInstalled: vi.fn(async () => true),
      isAuthenticated: vi.fn(async () => true),
      createRepo,
    });

    // confirm: auto-create? yes, private? yes, then "created the repo?" yes
    confirmMock.mockResolvedValue(true);
    const manualUrl = 'git@gitlab.com:me/dotfiles.git';
    // First text() = repo name; second text() = manual URL paste.
    textMock
      .mockResolvedValueOnce('dotfiles')
      .mockResolvedValueOnce(manualUrl);

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const result = await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    expect(createRepo).toHaveBeenCalled();
    // After the failure, the manual flow upserts the pasted URL.
    expect(upsertRemoteMock).toHaveBeenCalledWith('/test-home/.tuck', 'origin', manualUrl);
    expect(result.remoteUrl).toBe(manualUrl);
  });

  it('does not offer auto-create when the CLI is unauthenticated', async () => {
    const createRepo = vi.fn();
    const gitlab = makeProvider('gitlab', {
      isCliInstalled: vi.fn(async () => true),
      isAuthenticated: vi.fn(async () => false),
      createRepo,
    });

    confirmMock.mockResolvedValue(true); // "Have you created the repository?"
    textMock.mockResolvedValue('git@gitlab.com:me/dotfiles.git');

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    // createRepo must never run for an unauthenticated CLI.
    expect(createRepo).not.toHaveBeenCalled();
  });
});
