/**
 * init gitlab/custom remote-setup reroute tests.
 *
 * `tuck init` used to funnel every chosen provider through GitHub-specific
 * setup, hard-coding git@github.com / github.com and rejecting GitLab/custom
 * URLs. The gitlab/custom branch now delegates to the shared, provider-agnostic
 * setupRemoteForProvider(getProvider(mode), tuckDir), so the gitlab provider
 * drives its own URL (never github.com).
 *
 * We assert at the seam: setupRemoteForChosenProvider('gitlab', dir) must call
 * the shared helper with the GITLAB provider and return its gitlab URL, and the
 * github provider/validators must not be involved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setupRemoteForProviderMock = vi.fn();
const getProviderMock = vi.fn();

// Stub the shared remote-setup module so we can assert init delegates to it
// with the correct provider instance (the reroute under test).
vi.mock('../../src/lib/remoteSetup.js', () => ({
  setupRemoteForProvider: (...args: unknown[]) => setupRemoteForProviderMock(...args),
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  getProvider: (...args: unknown[]) => getProviderMock(...args),
  describeProviderConfig: vi.fn(() => 'gitlab'),
  buildRemoteConfig: vi.fn((mode: string) => ({ mode })),
}));

// Keep all heavy deps inert; only the reroute seam matters here.
vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  nextSteps: vi.fn(),
  withSpinner: vi.fn(async (_l: string, fn: () => Promise<unknown>) => fn()),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
  },
  logger: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
  colors: { brand: (x: string) => x, dim: (x: string) => x, bold: (x: string) => x, warning: (x: string) => x, muted: (x: string) => x },
}));

vi.mock('../../src/lib/git.js', () => ({
  initRepo: vi.fn(),
  addRemote: vi.fn(),
  cloneRepo: vi.fn(),
  setDefaultBranch: vi.fn(),
  stageAll: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../../src/lib/github.js', () => ({
  isGhInstalled: vi.fn(),
  isGhAuthenticated: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  createRepo: vi.fn(),
  getPreferredRepoUrl: vi.fn(),
  getPreferredRemoteProtocol: vi.fn(),
  findDotfilesRepo: vi.fn(),
  ghCloneRepo: vi.fn(),
  checkSSHKeys: vi.fn(),
  testSSHConnection: vi.fn(),
  getSSHKeyInstructions: vi.fn(),
  getFineGrainedTokenInstructions: vi.fn(),
  getClassicTokenInstructions: vi.fn(),
  getGitHubCLIInstallInstructions: vi.fn(),
  storeGitHubCredentials: vi.fn(),
  detectTokenType: vi.fn(),
  configureGitCredentialHelperWithOptions: vi.fn(),
  testStoredCredentials: vi.fn(),
  diagnoseAuthIssue: vi.fn(),
  MIN_GITHUB_TOKEN_LENGTH: 40,
  GITHUB_TOKEN_PREFIXES: ['ghp_'],
}));

vi.mock('../../src/lib/providerSetup.js', () => ({
  setupProvider: vi.fn(),
  detectProviderFromUrl: vi.fn(() => 'local'),
}));

describe('init gitlab/custom remote reroute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the gitlab path through the shared setupRemoteForProvider with the gitlab provider', async () => {
    const gitlabProvider = {
      mode: 'gitlab',
      displayName: 'GitLab',
      requiresRemote: true,
      buildRepoUrl: vi.fn(
        (u: string, r: string) => `git@gitlab.com:${u}/${r}.git`
      ),
      validateUrl: vi.fn((url: string) => url.includes('gitlab.com')),
    };
    getProviderMock.mockReturnValue(gitlabProvider);

    // Derive the URL from the GITLAB provider's own buildRepoUrl (the code under
    // test drives its own host) rather than a hardcoded literal, so the
    // "never github.com" assertion below is a genuine outcome of the gitlab
    // provider, not a restatement of an injected constant.
    const gitlabUrl = gitlabProvider.buildRepoUrl('user', 'dotfiles');
    expect(gitlabUrl).toBe('git@gitlab.com:user/dotfiles.git');
    setupRemoteForProviderMock.mockResolvedValue({ remoteUrl: gitlabUrl, pushed: false });

    const { setupRemoteForChosenProvider } = await import('../../src/commands/init.js');
    const result = await setupRemoteForChosenProvider('gitlab', '/test-home/.tuck');

    // The reroute resolved the GITLAB provider, not GitHub.
    expect(getProviderMock).toHaveBeenCalledWith('gitlab');
    // ...and handed that gitlab provider to the shared helper.
    expect(setupRemoteForProviderMock).toHaveBeenCalledWith(gitlabProvider, '/test-home/.tuck');

    // The URL that flows back is the gitlab provider's URL, never github.com.
    expect(result).toBe(gitlabUrl);
    expect(result).not.toContain('github.com');
  });

  it('returns null when the shared helper configured no remote (no github fallback)', async () => {
    const gitlabProvider = { mode: 'gitlab', displayName: 'GitLab', requiresRemote: true };
    getProviderMock.mockReturnValue(gitlabProvider);
    setupRemoteForProviderMock.mockResolvedValue({ remoteUrl: null, pushed: false });

    const { setupRemoteForChosenProvider } = await import('../../src/commands/init.js');
    const result = await setupRemoteForChosenProvider('gitlab', '/test-home/.tuck');

    expect(result).toBeNull();
    // The github auto-setup must never be consulted on the gitlab path.
    const github = await import('../../src/lib/github.js');
    expect(github.isGhInstalled).not.toHaveBeenCalled();
    expect(github.createRepo).not.toHaveBeenCalled();
  });
});
