/**
 * Custom Provider Implementation
 *
 * Provides support for any git remote via manual URL entry.
 * This is a fallback for providers without CLI tools.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  GitProvider,
  ProviderUser,
  ProviderRepo,
  CreateRepoOptions,
  ProviderDetection,
} from './types.js';
import { ProviderError } from './types.js';
import {
  validateGitUrl as validateGitUrlUtil,
  GIT_OPERATION_TIMEOUTS,
  sanitizeErrorMessage,
} from '../validation.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Custom Provider
// ============================================================================

export class CustomProvider implements GitProvider {
  readonly mode = 'custom' as const;
  readonly displayName = 'Custom Git Remote';
  readonly cliName = null;
  readonly requiresRemote = true;

  /** The custom remote URL */
  private remoteUrl?: string;

  constructor(remoteUrl?: string) {
    this.remoteUrl = remoteUrl;
  }

  /** Create a provider with a specific URL */
  static withUrl(url: string): CustomProvider {
    const provider = new CustomProvider(url);
    return provider;
  }

  /** Set the remote URL */
  setRemoteUrl(url: string): void {
    this.remoteUrl = url;
  }

  /** Get the configured remote URL */
  getRemoteUrl(): string | undefined {
    return this.remoteUrl;
  }

  // -------------------------------------------------------------------------
  // Detection & Authentication
  // -------------------------------------------------------------------------

  async isCliInstalled(): Promise<boolean> {
    // Custom mode uses standard git, which we assume is installed
    try {
      await execFileAsync('git', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    // We can't really check authentication for arbitrary remotes
    // Return true and let push/pull fail if auth is needed
    return true;
  }

  async getUser(): Promise<ProviderUser | null> {
    // Try to get user from git config
    try {
      const { stdout: name } = await execFileAsync('git', ['config', '--global', 'user.name']);
      const { stdout: email } = await execFileAsync('git', ['config', '--global', 'user.email']);

      const userName = name.trim();
      const userEmail = email.trim();

      if (userName || userEmail) {
        // Safely extract login from email - handle case where email has no @ symbol
        let login = 'user';
        if (userName) {
          login = userName;
        } else if (userEmail) {
          const atIndex = userEmail.indexOf('@');
          login = atIndex > 0 ? userEmail.slice(0, atIndex) : userEmail;
        }

        return {
          login,
          name: userName || null,
          email: userEmail || null,
        };
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  async detect(): Promise<ProviderDetection> {
    const gitInstalled = await this.isCliInstalled();

    return {
      mode: this.mode,
      displayName: this.displayName,
      available: gitInstalled,
      authStatus: {
        cliInstalled: gitInstalled,
        authenticated: true, // Assume authenticated for custom
      },
      unavailableReason: !gitInstalled ? 'Git is not installed' : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Repository Operations
  // -------------------------------------------------------------------------

  async repoExists(repoUrl: string): Promise<boolean> {
    // Try to list remote refs to check if repo exists and is accessible
    try {
      await execFileAsync('git', ['ls-remote', repoUrl], {
        timeout: GIT_OPERATION_TIMEOUTS.LS_REMOTE,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createRepo(_options: CreateRepoOptions): Promise<ProviderRepo> {
    throw new ProviderError('Cannot create repositories with custom provider', 'custom', [
      'Create your repository manually on your git hosting service',
      'Then use: tuck init --remote <your-repo-url>',
    ]);
  }

  async getRepoInfo(repoUrl: string): Promise<ProviderRepo | null> {
    // Extract name from URL
    const name = this.extractRepoName(repoUrl);

    // Check if accessible
    const exists = await this.repoExists(repoUrl);
    if (!exists) {
      return null;
    }

    return {
      name,
      fullName: name,
      url: repoUrl,
      sshUrl: repoUrl.startsWith('git@') ? repoUrl : '',
      httpsUrl: repoUrl.startsWith('http') ? repoUrl : '',
      isPrivate: true, // Assume private, we can't know
    };
  }

  async cloneRepo(repoUrl: string, targetDir: string): Promise<void> {
    try {
      await execFileAsync('git', ['clone', repoUrl, targetDir], {
        timeout: GIT_OPERATION_TIMEOUTS.CLONE,
        maxBuffer: 10 * 1024 * 1024, // 10MB output limit
      });
    } catch (error) {
      // Check if operation timed out
      if (error && typeof error === 'object' && 'killed' in error && error.killed) {
        throw new ProviderError('Clone operation timed out', 'custom', [
          'The repository may be too large or the connection is too slow',
          'Try using git clone directly for large repositories',
        ]);
      }

      // Sanitize error message
      const sanitizedMessage = sanitizeErrorMessage(error, 'Failed to clone repository');
      throw new ProviderError(sanitizedMessage, 'custom', [
        'Check that the URL is correct and you have access',
        'You may need to set up SSH keys or credentials',
      ]);
    }
  }

  async findDotfilesRepo(_username?: string): Promise<string | null> {
    // Can't search for repos with custom provider
    return null;
  }

  // -------------------------------------------------------------------------
  // URL Utilities
  // -------------------------------------------------------------------------

  async getPreferredRepoUrl(repo: ProviderRepo): Promise<string> {
    // Return SSH URL if available, otherwise HTTPS
    return repo.sshUrl || repo.httpsUrl || repo.url;
  }

  validateUrl(url: string): boolean {
    // Use centralized validation with security checks
    return validateGitUrlUtil(url);
  }

  buildRepoUrl(_username: string, _repoName: string, _protocol: 'ssh' | 'https'): string {
    // Can't build URLs for unknown providers
    throw new ProviderError('Cannot build repository URLs for custom provider', 'custom', [
      'Please provide the full repository URL',
    ]);
  }

  // -------------------------------------------------------------------------
  // Instructions
  // -------------------------------------------------------------------------

  getSetupInstructions(): string {
    return `Custom Git Remote

Use any git hosting service by providing the repository URL directly.

Supported URL formats:
- HTTPS: https://git.example.com/user/repo.git
- SSH: git@git.example.com:user/repo.git

Steps:
1. Create a repository on your git hosting service
2. Copy the clone URL (SSH or HTTPS)
3. Run: tuck init --remote <your-repo-url>

Note: You'll need to handle authentication separately:
- For SSH: Set up SSH keys with your hosting service
- For HTTPS: Configure git credentials or use a credential helper`;
  }

  getAltAuthInstructions(): string {
    return `Authentication for Custom Git Remotes

For SSH URLs (git@...):
1. Generate an SSH key: ssh-keygen -t ed25519
2. Add the public key to your git hosting service
3. Test: ssh -T git@your-host.com

For HTTPS URLs:
1. Create a personal access token on your hosting service
2. Configure git credential helper:
   git config --global credential.helper store
3. On first push, enter your token as password

Or use git credential manager for more secure storage.`;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private extractRepoName(url: string): string {
    // Remove .git suffix
    let name = url.replace(/\.git$/, '');

    // Handle SSH format (git@host:user/repo)
    if (name.includes(':') && !name.includes('://')) {
      name = name.split(':').pop() || name;
    }

    // Handle URL format (remove protocol and host)
    if (name.includes('://')) {
      const urlParts = name.split('/');
      name = urlParts.slice(3).join('/'); // Remove protocol + host
    }

    // Get just the repo name (last part)
    const parts = name.split('/');
    return parts[parts.length - 1] || 'repository';
  }
}

// Export singleton instance
export const customProvider = new CustomProvider();
