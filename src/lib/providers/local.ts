/**
 * Local Provider Implementation
 *
 * A no-op provider for local-only git repositories without remote sync.
 * This allows users to track their dotfiles locally without pushing to any remote.
 */

import type {
  GitProvider,
  ProviderUser,
  ProviderRepo,
  CreateRepoOptions,
  ProviderDetection,
} from './types.js';
import { LocalModeError } from './types.js';

// ============================================================================
// Local Provider
// ============================================================================

export class LocalProvider implements GitProvider {
  readonly mode = 'local' as const;
  readonly displayName = 'Local Only';
  readonly cliName = null;
  readonly requiresRemote = false;

  // -------------------------------------------------------------------------
  // Detection & Authentication
  // -------------------------------------------------------------------------

  async isCliInstalled(): Promise<boolean> {
    // Local mode doesn't need any CLI
    return true;
  }

  async isAuthenticated(): Promise<boolean> {
    // Local mode doesn't need authentication
    return true;
  }

  async getUser(): Promise<ProviderUser | null> {
    // Local mode has no user account
    return null;
  }

  async detect(): Promise<ProviderDetection> {
    return {
      mode: this.mode,
      displayName: this.displayName,
      available: true,
      authStatus: {
        cliInstalled: true,
        authenticated: true,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Repository Operations
  // -------------------------------------------------------------------------

  async repoExists(_repoName: string): Promise<boolean> {
    throw new LocalModeError('check if remote repository exists');
  }

  async createRepo(_options: CreateRepoOptions): Promise<ProviderRepo> {
    throw new LocalModeError('create remote repository');
  }

  async getRepoInfo(_repoName: string): Promise<ProviderRepo | null> {
    throw new LocalModeError('get remote repository info');
  }

  async cloneRepo(_repoName: string, _targetDir: string): Promise<void> {
    throw new LocalModeError('clone remote repository');
  }

  async findDotfilesRepo(_username?: string): Promise<string | null> {
    // In local mode, there's no remote to search
    return null;
  }

  // -------------------------------------------------------------------------
  // URL Utilities
  // -------------------------------------------------------------------------

  async getPreferredRepoUrl(_repo: ProviderRepo): Promise<string> {
    throw new LocalModeError('get remote repository URL');
  }

  validateUrl(_url: string): boolean {
    // Local mode doesn't validate remote URLs
    return false;
  }

  buildRepoUrl(_username: string, _repoName: string, _protocol: 'ssh' | 'https'): string {
    throw new LocalModeError('build remote repository URL');
  }

  // -------------------------------------------------------------------------
  // Instructions
  // -------------------------------------------------------------------------

  getSetupInstructions(): string {
    return `Local Only Mode

Your dotfiles are stored in a local git repository without remote sync.
This is useful for:
- Testing tuck before setting up a remote
- Machines that don't need cloud backup
- Air-gapped or offline environments

Your dotfiles are still version controlled with git, so you can:
- Track changes over time
- Restore previous versions
- Manually push to a remote later

To enable remote sync later, run:
  tuck config remote

This will guide you through setting up GitHub, GitLab, or another provider.`;
  }

  getAltAuthInstructions(): string {
    return `To sync your dotfiles to a remote, you'll need to configure a provider.

Run: tuck config remote

Available options:
- GitHub (recommended) - via gh CLI
- GitLab - via glab CLI  
- Custom - any git remote URL`;
  }
}

// Export singleton instance
export const localProvider = new LocalProvider();
