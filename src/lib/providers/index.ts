/**
 * Git Provider Registry
 *
 * Central registry for managing git providers.
 * Handles provider detection, selection, and instantiation.
 */

import type { GitProvider, ProviderMode, ProviderDetection, RemoteConfig } from './types.js';
import { ProviderNotConfiguredError, LocalModeError } from './types.js';
import { GitLabProvider, gitlabProvider } from './gitlab.js';
import { githubProvider } from './github.js';
import { localProvider } from './local.js';
import { CustomProvider, customProvider } from './custom.js';

// Re-export types and errors
export * from './types.js';
export { GitHubProvider, githubProvider } from './github.js';
export { GitLabProvider, gitlabProvider } from './gitlab.js';
export { LocalProvider, localProvider } from './local.js';
export { CustomProvider, customProvider } from './custom.js';

// ============================================================================
// Provider Registry
// ============================================================================

/** All available provider modes */
export const PROVIDER_MODES: ProviderMode[] = ['github', 'gitlab', 'local', 'custom'];

/** Provider display info for selection UI */
export interface ProviderOption {
  mode: ProviderMode;
  displayName: string;
  description: string;
  available: boolean;
  authStatus?: {
    authenticated: boolean;
    username?: string;
  };
  unavailableReason?: string;
}

/**
 * Get a provider instance by mode
 */
export function getProvider(mode: ProviderMode, config?: RemoteConfig): GitProvider {
  switch (mode) {
    case 'github':
      return githubProvider;

    case 'gitlab':
      // Support self-hosted GitLab
      if (config?.providerUrl) {
        const host = config.providerUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        return GitLabProvider.forHost(host);
      }
      return gitlabProvider;

    case 'local':
      return localProvider;

    case 'custom':
      if (config?.url) {
        return CustomProvider.withUrl(config.url);
      }
      return customProvider;

    default:
      throw new ProviderNotConfiguredError(mode);
  }
}

/**
 * Detect all available providers and their auth status
 */
export async function detectProviders(): Promise<ProviderDetection[]> {
  const detections = await Promise.all([
    githubProvider.detect(),
    gitlabProvider.detect(),
    localProvider.detect(),
    customProvider.detect(),
  ]);

  return detections;
}

/**
 * Get provider options for interactive selection
 * Sorted by recommendation: authenticated providers first, then by preference
 */
export async function getProviderOptions(): Promise<ProviderOption[]> {
  const detections = await detectProviders();

  const options: ProviderOption[] = [
    {
      mode: 'github',
      displayName: 'GitHub',
      description: 'Store dotfiles on GitHub (recommended)',
      available: detections.find((d) => d.mode === 'github')?.available ?? false,
      authStatus: {
        authenticated:
          detections.find((d) => d.mode === 'github')?.authStatus.authenticated ?? false,
        username: detections.find((d) => d.mode === 'github')?.authStatus.user?.login,
      },
      unavailableReason: detections.find((d) => d.mode === 'github')?.unavailableReason,
    },
    {
      mode: 'gitlab',
      displayName: 'GitLab',
      description: 'Store dotfiles on GitLab (supports self-hosted)',
      available: detections.find((d) => d.mode === 'gitlab')?.available ?? false,
      authStatus: {
        authenticated:
          detections.find((d) => d.mode === 'gitlab')?.authStatus.authenticated ?? false,
        username: detections.find((d) => d.mode === 'gitlab')?.authStatus.user?.login,
      },
      unavailableReason: detections.find((d) => d.mode === 'gitlab')?.unavailableReason,
    },
    {
      mode: 'local',
      displayName: 'Local Only',
      description: 'Track dotfiles locally without remote sync',
      available: true,
    },
    {
      mode: 'custom',
      displayName: 'Custom Remote',
      description: 'Use any git remote URL (Bitbucket, Gitea, etc.)',
      available: detections.find((d) => d.mode === 'custom')?.available ?? true,
    },
  ];

  // Sort: authenticated first, then available, then rest
  return options.sort((a, b) => {
    // Authenticated providers first
    if (a.authStatus?.authenticated && !b.authStatus?.authenticated) return -1;
    if (!a.authStatus?.authenticated && b.authStatus?.authenticated) return 1;

    // Then available providers
    if (a.available && !b.available) return -1;
    if (!a.available && b.available) return 1;

    return 0;
  });
}

/**
 * Check if remote operations are available
 * Throws LocalModeError if in local mode
 */
export function assertRemoteAvailable(config: RemoteConfig, operation: string): void {
  if (config.mode === 'local') {
    throw new LocalModeError(operation);
  }
}

/**
 * Get a user-friendly description of the current provider configuration
 */
export function describeProviderConfig(config: RemoteConfig): string {
  switch (config.mode) {
    case 'github':
      return config.username ? `GitHub (@${config.username})` : 'GitHub';

    case 'gitlab':
      if (config.providerUrl) {
        const host = config.providerUrl.replace(/^https?:\/\//, '');
        return config.username ? `GitLab ${host} (@${config.username})` : `GitLab (${host})`;
      }
      return config.username ? `GitLab (@${config.username})` : 'GitLab';

    case 'local':
      return 'Local only (no remote sync)';

    case 'custom':
      return config.url ? `Custom: ${config.url}` : 'Custom remote';

    default:
      return 'Unknown provider';
  }
}

/**
 * Validate that a provider configuration is complete
 */
export function validateProviderConfig(config: RemoteConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.mode) {
    errors.push('Provider mode is not set');
  }

  if (config.mode === 'custom' && !config.url) {
    errors.push('Custom provider requires a remote URL');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Build a RemoteConfig from provider detection and user input
 */
export function buildRemoteConfig(
  mode: ProviderMode,
  options?: {
    url?: string;
    providerUrl?: string;
    username?: string;
    repoName?: string;
  }
): RemoteConfig {
  return {
    mode,
    url: options?.url,
    providerUrl: options?.providerUrl,
    username: options?.username,
    repoName: options?.repoName,
  };
}
