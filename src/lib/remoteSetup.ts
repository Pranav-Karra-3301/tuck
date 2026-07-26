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
import { upsertRemote } from './git.js';
import type { GitProvider } from './providers/types.js';

/** Result of configuring a remote for the chosen provider. */
export interface RemoteSetupResult {
  /** The configured remote URL, or null if no remote was set up. */
  remoteUrl: string | null;
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
 * Safely probe whether the provider's CLI is both installed and authenticated.
 *
 * `isCliInstalled`/`isAuthenticated` may be absent on a partial provider or may
 * throw (CLI invocation failure); any problem is treated as "not available" so
 * we fall back to the manual flow rather than crashing the wizard.
 */
const cliAvailable = async (provider: GitProvider): Promise<boolean> => {
  if (!provider.cliName) return false;
  try {
    const installed =
      typeof provider.isCliInstalled === 'function'
        ? await provider.isCliInstalled().catch(() => false)
        : false;
    if (!installed) return false;
    const authed =
      typeof provider.isAuthenticated === 'function'
        ? await provider.isAuthenticated().catch(() => false)
        : false;
    return authed;
  } catch {
    return false;
  }
};

/**
 * Provider-neutral auto-create: prompt to create a repository through the
 * provider's own CLI (gh for GitHub, glab for GitLab — same code path), then
 * upsert the resulting URL as `origin`.
 *
 * Returns the configured result on success, or `null` to signal the caller to
 * fall through to the manual paste-URL flow (user declined, or createRepo /
 * getPreferredRepoUrl failed — never throws).
 */
const tryAutoCreate = async (
  provider: GitProvider,
  tuckDir: string,
  defaultRepoName: string
): Promise<RemoteSetupResult | null> => {
  const wantsAuto = await prompts.confirm(
    `Create a ${provider.displayName} repository automatically?`,
    true
  );
  if (!wantsAuto) return null;

  const name = await prompts.text('Repository name:', {
    placeholder: defaultRepoName,
    defaultValue: defaultRepoName,
    validate: (value: string) =>
      value && value.trim() ? undefined : 'Repository name is required',
  });
  const repoName = (name && name.trim()) || defaultRepoName;

  const isPrivate = await prompts.confirm('Make it private?', true);

  try {
    const repo = await provider.createRepo({
      name: repoName,
      isPrivate,
      description: 'Dotfiles managed by tuck',
    });
    const url = await provider.getPreferredRepoUrl(repo);
    await upsertRemote(tuckDir, 'origin', url);
    prompts.log.success(`Created ${provider.displayName} repository`);
    return { remoteUrl: url };
  } catch (error) {
    // Auto-create failed: warn and fall back to the manual flow (do not throw).
    prompts.log.warning(
      `Could not create repository automatically: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
};

/**
 * Set up a git remote for the given provider using the provider abstraction.
 *
 * Behavior by provider:
 * - `local` (or any provider where `requiresRemote === false`): no-op,
 *   returns `{ remoteUrl: null }`.
 * - `github` / `gitlab`: if the provider's CLI is installed AND authenticated,
 *   offers to create the repo automatically (provider-neutral — gh and glab use
 *   the identical code path). On decline/failure, falls back to the manual flow.
 * - `custom` / CLI-less / unauthenticated: shows the provider's setup
 *   instructions, asks whether the repo was created, then prompts for a URL
 *   validated by the provider's own `validateUrl` and wires it up as `origin`.
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
    return { remoteUrl: null };
  }

  const repoName = opts.repoName ?? 'dotfiles';

  // Provider-neutral AUTO-CREATE: if the provider's CLI is installed and
  // authenticated, offer to create the repo for the user. This gives GitLab
  // (glab) the same first-class experience GitHub (gh) already had.
  if (await cliAvailable(provider)) {
    const auto = await tryAutoCreate(provider, tuckDir, repoName);
    if (auto) {
      return auto;
    }
    // Declined or failed → fall through to the manual flow below.
  }

  console.log();
  prompts.note(provider.getSetupInstructions(), 'Repository Setup');
  console.log();

  const created = await prompts.confirm('Have you created the repository?', true);
  if (!created) {
    return { remoteUrl: null };
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
    return { remoteUrl: null };
  }

  try {
    // Upsert (set-url if origin exists, else add) so reconfiguring an existing
    // repo doesn't hit the remove-then-add race.
    await upsertRemote(tuckDir, 'origin', url);
    prompts.log.success('Remote added successfully');
    return { remoteUrl: url };
  } catch (error) {
    prompts.log.error(
      `Failed to add remote: ${error instanceof Error ? error.message : String(error)}`
    );
    return { remoteUrl: null };
  }
};
