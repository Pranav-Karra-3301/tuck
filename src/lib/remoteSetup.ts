/**
 * Remote Setup (provider-agnostic)
 *
 * Drives the "set up a remote repository" step of `tuck init` and
 * `tuck config remote` purely through the {@link GitProvider} interface.
 *
 * Previously this step funneled EVERY chosen provider through GitHub-specific
 * code (`setupGitHubRepo` / `validateGitHubUrl`), which hard-coded
 * `git@github.com` / `github.com` and rejected any GitLab or custom URL. As a
 * result GitLab/custom repo creation only worked via `tuck config remote`,
 * never via `tuck init`.
 *
 * `setupRemoteForProvider` removes that funnel: it uses the provider's own
 * `getSetupInstructions`, `validateUrl`, and `buildRepoUrl`, so github, gitlab,
 * custom, and local each behave correctly. There is no hard-coded host here.
 */

import { prompts } from '../ui/index.js';
import { addRemote } from './git.js';
import type { GitProvider } from './providers/types.js';

/** Result of configuring a remote for the chosen provider. */
export interface RemoteSetupResult {
  /** The configured remote URL, or null if no remote was set up. */
  remoteUrl: string | null;
  /** Whether an initial push was performed (always false here; push is handled by the caller). */
  pushed: boolean;
}

export interface SetupRemoteOptions {
  /** Default repository name used to build the example/placeholder URL. */
  repoName?: string;
}

/**
 * Build an example repository URL for the prompt placeholder using the
 * provider's own URL builder. Falls back to a generic placeholder when the
 * provider cannot build URLs (e.g. custom/local providers throw).
 */
const buildPlaceholderUrl = (
  provider: GitProvider,
  repoName: string,
  protocol: 'ssh' | 'https'
): string => {
  try {
    return provider.buildRepoUrl('username', repoName, protocol);
  } catch {
    return protocol === 'ssh'
      ? 'git@host:user/dotfiles.git'
      : 'https://host/user/dotfiles.git';
  }
};

/**
 * Set up a git remote for the given provider using the provider abstraction.
 *
 * Behavior by provider:
 * - `local` (or any provider where `requiresRemote === false`): no-op,
 *   returns `{ remoteUrl: null, pushed: false }`.
 * - `github` / `gitlab` / `custom`: shows the provider's setup instructions,
 *   asks whether the repo was created, then prompts for a URL validated by the
 *   provider's own `validateUrl` and wires it up as `origin`.
 *
 * Never assumes github.com and never calls GitHub-specific validation.
 */
export const setupRemoteForProvider = async (
  provider: GitProvider,
  tuckDir: string,
  opts: SetupRemoteOptions = {}
): Promise<RemoteSetupResult> => {
  // Local mode (or any provider that doesn't require a remote): nothing to do.
  if (!provider.requiresRemote || provider.mode === 'local') {
    return { remoteUrl: null, pushed: false };
  }

  const repoName = opts.repoName ?? 'dotfiles';

  console.log();
  prompts.note(provider.getSetupInstructions(), 'Repository Setup');
  console.log();

  const created = await prompts.confirm('Have you created the repository?', true);
  if (!created) {
    return { remoteUrl: null, pushed: false };
  }

  // Prefer an SSH example for providers that can build one; gracefully fall
  // back for custom/local which throw from buildRepoUrl.
  const placeholder = buildPlaceholderUrl(provider, repoName, 'ssh');

  const url = await prompts.text('Paste your repository URL:', {
    placeholder,
    validate: (value: string) => {
      if (!value || !value.trim()) return 'Repository URL is required';
      return provider.validateUrl(value)
        ? undefined
        : `Please enter a valid ${provider.displayName} URL`;
    },
  });

  if (!url) {
    return { remoteUrl: null, pushed: false };
  }

  try {
    await addRemote(tuckDir, 'origin', url);
    prompts.log.success('Remote added successfully');
    return { remoteUrl: url, pushed: false };
  } catch (error) {
    prompts.log.error(
      `Failed to add remote: ${error instanceof Error ? error.message : String(error)}`
    );
    return { remoteUrl: null, pushed: false };
  }
};
