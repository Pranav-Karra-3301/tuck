/**
 * Provider Setup Utilities
 *
 * Handles the interactive provider selection and setup flow.
 * Used during `tuck init` and `tuck config remote`.
 */

import { prompts, colors as c } from '../ui/index.js';
import {
  getProviderOptions,
  getProvider,
  buildRemoteConfig,
  type ProviderMode,
  type RemoteConfig,
  type GitProvider,
  type ProviderOption,
} from './providers/index.js';
import { validateHostname, sanitizeErrorMessage } from './validation.js';

// ============================================================================
// Types
// ============================================================================

export interface ProviderSetupResult {
  /** Whether setup completed successfully */
  success: boolean;
  /** The selected provider mode */
  mode: ProviderMode;
  /** The remote configuration to save */
  config: RemoteConfig;
  /** The provider instance */
  provider: GitProvider;
  /** Remote URL if configured */
  remoteUrl?: string;
  /** Whether initial push was completed */
  pushed?: boolean;
}

// ============================================================================
// Provider Selection UI
// ============================================================================

/**
 * Display available providers with their status
 */
function displayProviderStatus(options: ProviderOption[]): void {
  console.log();
  console.log(c.brand('  Available Git Providers:'));
  console.log();

  for (const opt of options) {
    const status = getProviderStatusIcon(opt);
    const authInfo = opt.authStatus?.username ? c.muted(` (@${opt.authStatus.username})`) : '';

    console.log(`  ${status} ${opt.displayName}${authInfo}`);

    if (opt.unavailableReason) {
      console.log(c.muted(`      ${opt.unavailableReason}`));
    }
  }

  console.log();
}

/**
 * Get a status icon for a provider option
 */
function getProviderStatusIcon(opt: ProviderOption): string {
  if (opt.authStatus?.authenticated) {
    return c.success('✓'); // Authenticated
  }
  if (opt.available) {
    return c.warning('○'); // Available but not authenticated
  }
  return c.muted('✗'); // Not available
}

/**
 * Prompt user to select a git provider
 */
export async function selectProvider(): Promise<ProviderMode | null> {
  // Detect available providers
  const spinner = prompts.spinner();
  spinner.start('Detecting available git providers...');

  const options = await getProviderOptions();

  spinner.stop('Provider detection complete');

  // Display provider status
  displayProviderStatus(options);

  // Build selection options with explicit type
  type SelectValue = ProviderMode | 'skip';

  const selectOptions: Array<{ value: SelectValue; label: string; hint: string }> = options.map(
    (opt) => {
      let hint = opt.description;

      if (opt.authStatus?.authenticated && opt.authStatus.username) {
        hint = `Logged in as @${opt.authStatus.username}`;
      } else if (opt.unavailableReason) {
        hint = opt.unavailableReason;
      }

      return {
        value: opt.mode as SelectValue,
        label: opt.displayName,
        hint,
      };
    }
  );

  // Add "Skip for now" option
  selectOptions.push({
    value: 'skip',
    label: 'Skip for now',
    hint: 'Set up remote later with tuck config remote',
  });

  const selected = await prompts.select<SelectValue>(
    'Where would you like to store your dotfiles?',
    selectOptions
  );

  if (selected === 'skip') {
    return null;
  }

  return selected;
}

/**
 * Run the full provider setup flow
 */
export async function setupProvider(
  initialMode?: ProviderMode
): Promise<ProviderSetupResult | null> {
  // Select provider if not specified
  const mode = initialMode ?? (await selectProvider());

  if (!mode) {
    // User chose to skip
    return {
      success: true,
      mode: 'local',
      config: buildRemoteConfig('local'),
      provider: getProvider('local'),
    };
  }

  const provider = getProvider(mode);

  // Handle each provider type
  switch (mode) {
    case 'local':
      return await setupLocalProvider();

    case 'github':
      return await setupGitHubProvider(provider);

    case 'gitlab':
      return await setupGitLabProvider(provider);

    case 'custom':
      return await setupCustomProvider(provider);

    default:
      prompts.log.error(`Unknown provider: ${mode}`);
      return null;
  }
}

// ============================================================================
// Provider-Specific Setup
// ============================================================================

/**
 * Setup local-only mode (no remote)
 */
async function setupLocalProvider(): Promise<ProviderSetupResult> {
  prompts.log.info('Your dotfiles will be tracked locally without remote sync.');
  prompts.log.info("You can set up a remote later with 'tuck config remote'.");

  return {
    success: true,
    mode: 'local',
    config: buildRemoteConfig('local'),
    provider: getProvider('local'),
  };
}

/**
 * Setup GitHub provider
 */
async function setupGitHubProvider(provider: GitProvider): Promise<ProviderSetupResult | null> {
  const detection = await provider.detect();

  // Check if CLI is installed
  if (!detection.authStatus.cliInstalled) {
    prompts.log.warning('GitHub CLI (gh) is not installed.');
    console.log();
    prompts.note(provider.getSetupInstructions(), 'Installation Instructions');
    console.log();

    const altChoice = await prompts.select('How would you like to proceed?', [
      { value: 'install', label: 'I will install gh CLI', hint: 'Run tuck init again after' },
      { value: 'custom', label: 'Use custom URL instead', hint: 'Manual repository setup' },
      { value: 'local', label: 'Stay local for now', hint: 'No remote sync' },
    ]);

    if (altChoice === 'local') {
      return setupLocalProvider();
    }

    if (altChoice === 'custom') {
      return setupCustomProvider(getProvider('custom'));
    }

    // User will install CLI
    prompts.log.info("After installing, run 'tuck init' again.");
    return null;
  }

  // Check if authenticated
  if (!detection.authStatus.authenticated) {
    prompts.log.warning('GitHub CLI is installed but not authenticated.');

    const authChoice = await prompts.select('Would you like to authenticate now?', [
      { value: 'auth', label: 'Run gh auth login', hint: 'Authenticate via browser' },
      { value: 'custom', label: 'Use custom URL instead', hint: 'Manual repository setup' },
      { value: 'local', label: 'Stay local for now', hint: 'No remote sync' },
    ]);

    if (authChoice === 'local') {
      return setupLocalProvider();
    }

    if (authChoice === 'custom') {
      return setupCustomProvider(getProvider('custom'));
    }

    // Run gh auth login
    prompts.log.info('Opening browser for GitHub authentication...');
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('gh', ['auth', 'login', '--web']);

      // Re-check authentication
      const recheck = await provider.detect();
      if (!recheck.authStatus.authenticated) {
        prompts.log.warning('Authentication may have failed. Please try again.');
        return null;
      }

      prompts.log.success(`Authenticated as @${recheck.authStatus.user?.login}`);
    } catch (error) {
      // Sanitize error message to prevent information disclosure
      prompts.log.error('Authentication failed. Please try again or run `gh auth login` manually.');
      return null;
    }
  }

  // Get user info
  const user = await provider.getUser();
  if (!user) {
    prompts.log.error('Could not get GitHub user information.');
    return null;
  }

  // Confirm account
  const confirmAccount = await prompts.confirm(`Use GitHub account @${user.login}?`, true);

  if (!confirmAccount) {
    prompts.log.info("Run 'gh auth logout' then 'gh auth login' to switch accounts.");
    return null;
  }

  return {
    success: true,
    mode: 'github',
    config: buildRemoteConfig('github', { username: user.login }),
    provider,
  };
}

/**
 * Setup GitLab provider
 */
async function setupGitLabProvider(provider: GitProvider): Promise<ProviderSetupResult | null> {
  // Ask about self-hosted first
  const hostType = await prompts.select('Which GitLab instance?', [
    { value: 'cloud', label: 'gitlab.com', hint: 'GitLab cloud service' },
    { value: 'self-hosted', label: 'Self-hosted', hint: 'Custom GitLab server' },
  ]);

  let providerUrl: string | undefined;

  if (hostType === 'self-hosted') {
    const host = await prompts.text('Enter your GitLab host:', {
      placeholder: 'gitlab.example.com',
      validate: (value) => {
        try {
          validateHostname(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid hostname';
        }
      },
    });

    providerUrl = `https://${host}`;

    // Warn about self-signed certificates
    prompts.log.info(
      'For self-hosted instances with self-signed certificates, ' +
        'you may need to configure git to skip SSL verification'
    );

    // Create provider for this host
    const { GitLabProvider } = await import('./providers/gitlab.js');
    provider = GitLabProvider.forHost(host);
  }

  const detection = await provider.detect();

  // Check if CLI is installed
  if (!detection.authStatus.cliInstalled) {
    prompts.log.warning('GitLab CLI (glab) is not installed.');
    console.log();
    prompts.note(provider.getSetupInstructions(), 'Installation Instructions');
    console.log();

    const altChoice = await prompts.select('How would you like to proceed?', [
      { value: 'install', label: 'I will install glab CLI', hint: 'Run tuck init again after' },
      { value: 'custom', label: 'Use custom URL instead', hint: 'Manual repository setup' },
      { value: 'local', label: 'Stay local for now', hint: 'No remote sync' },
    ]);

    if (altChoice === 'local') {
      return setupLocalProvider();
    }

    if (altChoice === 'custom') {
      return setupCustomProvider(getProvider('custom'));
    }

    prompts.log.info("After installing, run 'tuck init' again.");
    return null;
  }

  // Check if authenticated
  if (!detection.authStatus.authenticated) {
    prompts.log.warning(
      `GitLab CLI is installed but not authenticated${providerUrl ? ` for ${providerUrl}` : ''}.`
    );

    const authChoice = await prompts.select('Would you like to authenticate now?', [
      { value: 'auth', label: 'Run glab auth login', hint: 'Authenticate via browser' },
      { value: 'custom', label: 'Use custom URL instead', hint: 'Manual repository setup' },
      { value: 'local', label: 'Stay local for now', hint: 'No remote sync' },
    ]);

    if (authChoice === 'local') {
      return setupLocalProvider();
    }

    if (authChoice === 'custom') {
      return setupCustomProvider(getProvider('custom'));
    }

    // Run glab auth login
    prompts.log.info('Opening browser for GitLab authentication...');
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const args = ['auth', 'login', '--web'];
      if (providerUrl) {
        args.push('-h', providerUrl.replace(/^https?:\/\//, ''));
      }

      await execFileAsync('glab', args);

      // Re-check authentication
      const recheck = await provider.detect();
      if (!recheck.authStatus.authenticated) {
        prompts.log.warning('Authentication may have failed. Please try again.');
        return null;
      }

      prompts.log.success(`Authenticated as @${recheck.authStatus.user?.login}`);
    } catch (error) {
      // Sanitize error message to prevent information disclosure
      prompts.log.error('Authentication failed. Please try again or run `glab auth login` manually.');
      return null;
    }
  }

  // Get user info
  const user = await provider.getUser();
  if (!user) {
    prompts.log.error('Could not get GitLab user information.');
    return null;
  }

  // Confirm account
  const confirmAccount = await prompts.confirm(
    `Use GitLab account @${user.login}${providerUrl ? ` on ${providerUrl}` : ''}?`,
    true
  );

  if (!confirmAccount) {
    prompts.log.info("Run 'glab auth logout' then 'glab auth login' to switch accounts.");
    return null;
  }

  return {
    success: true,
    mode: 'gitlab',
    config: buildRemoteConfig('gitlab', { username: user.login, providerUrl }),
    provider,
  };
}

/**
 * Setup custom provider (manual URL)
 */
async function setupCustomProvider(provider: GitProvider): Promise<ProviderSetupResult | null> {
  prompts.log.info('You can use any git remote URL.');
  console.log();
  prompts.note(provider.getSetupInstructions(), 'Custom Remote Setup');
  console.log();

  const hasRepo = await prompts.confirm('Do you have a repository URL ready?');

  if (!hasRepo) {
    prompts.log.info("Create a repository first, then run 'tuck config remote' to add it.");
    return setupLocalProvider();
  }

  const url = await prompts.text('Enter the repository URL:', {
    placeholder: 'https://git.example.com/user/dotfiles.git',
    validate: (value) => {
      if (!value) return 'URL is required';
      if (!provider.validateUrl(value)) {
        return 'Invalid git URL format';
      }
      return undefined;
    },
  });

  return {
    success: true,
    mode: 'custom',
    config: buildRemoteConfig('custom', { url }),
    provider,
    remoteUrl: url,
  };
}

// ============================================================================
// Provider Configuration
// ============================================================================

/**
 * Validate and suggest provider based on existing remote URL
 */
export function detectProviderFromUrl(url: string): ProviderMode {
  if (url.includes('github.com')) {
    return 'github';
  }
  if (url.includes('gitlab.com') || url.includes('gitlab')) {
    return 'gitlab';
  }
  return 'custom';
}

/**
 * Get user-friendly message for local mode warning
 */
export function getLocalModeWarning(operation: string): string {
  return (
    `Cannot ${operation}: tuck is configured for local-only mode.\n\n` +
    `Your dotfiles are tracked locally but not synced to a remote.\n` +
    `To enable remote sync, run: tuck config remote`
  );
}
