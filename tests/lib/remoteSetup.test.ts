/**
 * Unit tests for setupRemoteForProvider (src/lib/remoteSetup.ts).
 *
 * The init wizard used to funnel GitLab/custom providers through the
 * GitHub-only setup (setupGitHubRepo / validateGitHubUrl), which hard-coded
 * github.com and rejected every non-github URL. setupRemoteForProvider drives
 * the remote-setup step purely through the GitProvider interface so each
 * provider validates with ITS OWN validateUrl and builds ITS OWN example URL.
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
const confirmMock = vi.fn();
const textMock = vi.fn();
const noteMock = vi.fn();

vi.mock('../../src/lib/git.js', () => ({
  addRemote: (...args: unknown[]) => addRemoteMock(...args),
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

describe('setupRemoteForProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubValidatorSpy.mockClear();
  });

  it('returns {remoteUrl:null, pushed:false} for the local provider without prompting', async () => {
    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const local = makeProvider('local', { requiresRemote: false });

    const result = await setupRemoteForProvider(local, '/test-home/.tuck');

    expect(result).toEqual({ remoteUrl: null, pushed: false });
    // Local mode must not touch git remotes or prompt for a URL.
    expect(addRemoteMock).not.toHaveBeenCalled();
    expect(textMock).not.toHaveBeenCalled();
  });

  it('validates a GitLab URL with the gitlab provider validator (never the github validator)', async () => {
    const gitlabValidate = vi.fn((url: string) => /^git@gitlab\.com:/.test(url));
    const gitlab = makeProvider('gitlab', { validateUrl: gitlabValidate });

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

    // Remote was added with the gitlab URL (NOT a github.com URL).
    expect(addRemoteMock).toHaveBeenCalledWith('/test-home/.tuck', 'origin', gitlabUrl);
    expect(addRemoteMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('github.com')
    );

    expect(result.remoteUrl).toBe(gitlabUrl);
    expect(result.pushed).toBe(false);
  });

  it('shows the provider-specific setup instructions, not GitHub instructions', async () => {
    const gitlab = makeProvider('gitlab');
    confirmMock.mockResolvedValue(true);
    textMock.mockResolvedValue('git@gitlab.com:user/dotfiles.git');

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    expect(gitlab.getSetupInstructions).toHaveBeenCalled();
    // The note shown must be the gitlab instructions.
    expect(noteMock).toHaveBeenCalledWith('setup instructions for gitlab', expect.any(String));
  });

  it('returns {remoteUrl:null, pushed:false} when the user has not created the repo', async () => {
    const gitlab = makeProvider('gitlab');
    confirmMock.mockResolvedValue(false); // "Have you created the repository?" -> No

    const { setupRemoteForProvider } = await import('../../src/lib/remoteSetup.js');
    const result = await setupRemoteForProvider(gitlab, '/test-home/.tuck');

    expect(result).toEqual({ remoteUrl: null, pushed: false });
    expect(addRemoteMock).not.toHaveBeenCalled();
  });

  it('accepts any valid git URL for the custom provider via its own validateUrl', async () => {
    const customValidate = vi.fn(() => true);
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

    expect(addRemoteMock).toHaveBeenCalledWith('/test-home/.tuck', 'origin', customUrl);
    expect(result.remoteUrl).toBe(customUrl);
  });
});
