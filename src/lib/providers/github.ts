/**
 * GitHub Provider Implementation
 *
 * Provides GitHub integration via the `gh` CLI tool.
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

const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

const COMMON_DOTFILE_REPO_NAMES = ['dotfiles', 'tuck', '.dotfiles', 'dot-files', 'dots'];

// ============================================================================
// GitHub Provider
// ============================================================================

export class GitHubProvider implements GitProvider {
  readonly mode = 'github' as const;
  readonly displayName = 'GitHub';
  readonly cliName = 'gh';
  readonly requiresRemote = true;

  // -------------------------------------------------------------------------
  // Detection & Authentication
  // -------------------------------------------------------------------------

  async isCliInstalled(): Promise<boolean> {
    try {
      await execFileAsync('gh', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status']);
      const output = (stderr || stdout || '').trim();
      return output.includes('Logged in');
    } catch (error) {
      if (error instanceof Error && 'stderr' in error) {
        const stderr = (error as { stderr: string }).stderr;
        return stderr.includes('Logged in');
      }
      return false;
    }
  }

  async getUser(): Promise<ProviderUser | null> {
    if (!(await this.isCliInstalled()) || !(await this.isAuthenticated())) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        'user',
        '--jq',
        '.login, .name, .email',
      ]);
      const lines = stdout.trim().split('\n');
      return {
        login: lines[0] || '',
        name: lines[1] !== 'null' ? lines[1] : null,
        email: lines[2] !== 'null' ? lines[2] : null,
      };
    } catch {
      return null;
    }
  }

  async detect(): Promise<ProviderDetection> {
    const cliInstalled = await this.isCliInstalled();

    if (!cliInstalled) {
      return {
        mode: this.mode,
        displayName: this.displayName,
        available: false,
        authStatus: {
          cliInstalled: false,
          authenticated: false,
        },
        unavailableReason: 'GitHub CLI (gh) is not installed',
      };
    }

    const authenticated = await this.isAuthenticated();
    const user = authenticated ? await this.getUser() : undefined;

    return {
      mode: this.mode,
      displayName: this.displayName,
      available: authenticated,
      authStatus: {
        cliInstalled: true,
        authenticated,
        user: user || undefined,
      },
      unavailableReason: !authenticated ? 'Not logged in to GitHub CLI' : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Repository Operations
  // -------------------------------------------------------------------------

  async repoExists(repoName: string): Promise<boolean> {
    this.validateRepoName(repoName);
    try {
      await execFileAsync('gh', ['repo', 'view', repoName, '--json', 'name']);
      return true;
    } catch {
      return false;
    }
  }

  async createRepo(options: CreateRepoOptions): Promise<ProviderRepo> {
    if (!(await this.isCliInstalled())) {
      throw new ProviderError('GitHub CLI is not installed', 'github', [
        'Install with: brew install gh (macOS) or see https://cli.github.com/',
      ]);
    }

    if (!(await this.isAuthenticated())) {
      throw new ProviderError('Not authenticated with GitHub CLI', 'github', [
        'Run: gh auth login',
      ]);
    }

    const user = await this.getUser();
    if (!user) {
      throw new ProviderError('Could not get GitHub user information', 'github');
    }

    const fullName = `${user.login}/${options.name}`;

    if (await this.repoExists(fullName)) {
      throw new ProviderError(`Repository "${fullName}" already exists`, 'github', [
        `Use a different name or import the existing repo`,
      ]);
    }

    this.validateRepoName(options.name);

    // Validate description if provided
    if (options.description && /[;&|`$(){}[\]<>!#*?]/.test(options.description)) {
      throw new ProviderError('Description contains invalid characters', 'github');
    }

    const args: string[] = ['repo', 'create', options.name];

    if (options.isPrivate !== false) {
      args.push('--private');
    } else {
      args.push('--public');
    }

    if (options.description) {
      args.push('--description', options.description);
    }

    args.push('--confirm', '--json', 'name,url,sshUrl');

    try {
      const { stdout } = await execFileAsync('gh', args);
      const result = JSON.parse(stdout);

      return {
        name: result.name,
        fullName: `${user.login}/${result.name}`,
        url: result.url,
        sshUrl: result.sshUrl,
        httpsUrl: result.url,
        isPrivate: options.isPrivate !== false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`Failed to create repository: ${errorMessage}`, 'github', [
        'Try creating the repository manually at github.com/new',
      ]);
    }
  }

  async getRepoInfo(repoName: string): Promise<ProviderRepo | null> {
    this.validateRepoName(repoName);
    try {
      const { stdout } = await execFileAsync('gh', [
        'repo',
        'view',
        repoName,
        '--json',
        'name,url,sshUrl,isPrivate,owner',
      ]);
      const result = JSON.parse(stdout);

      return {
        name: result.name,
        fullName: `${result.owner.login}/${result.name}`,
        url: result.url,
        sshUrl: result.sshUrl,
        httpsUrl: result.url,
        isPrivate: result.isPrivate,
      };
    } catch {
      return null;
    }
  }

  async cloneRepo(repoName: string, targetDir: string): Promise<void> {
    if (!(await this.isCliInstalled())) {
      throw new ProviderError('GitHub CLI is not installed', 'github');
    }

    this.validateRepoName(repoName);

    try {
      await execFileAsync('gh', ['repo', 'clone', repoName, targetDir]);
    } catch (error) {
      throw new ProviderError(`Failed to clone repository "${repoName}"`, 'github', [
        String(error),
        'Check that the repository exists and you have access',
      ]);
    }
  }

  async findDotfilesRepo(username?: string): Promise<string | null> {
    const user = username || (await this.getUser())?.login;
    if (!user) return null;

    for (const name of COMMON_DOTFILE_REPO_NAMES) {
      const repoName = `${user}/${name}`;
      if (await this.repoExists(repoName)) {
        return repoName;
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // URL Utilities
  // -------------------------------------------------------------------------

  async getPreferredRepoUrl(repo: ProviderRepo): Promise<string> {
    const protocol = await this.getPreferredProtocol();
    return protocol === 'ssh' ? repo.sshUrl : repo.httpsUrl;
  }

  validateUrl(url: string): boolean {
    return (
      url.startsWith('https://github.com/') ||
      url.startsWith('git@github.com:') ||
      url.startsWith('ssh://git@github.com/')
    );
  }

  buildRepoUrl(username: string, repoName: string, protocol: 'ssh' | 'https'): string {
    if (protocol === 'ssh') {
      return `git@github.com:${username}/${repoName}.git`;
    }
    return `https://github.com/${username}/${repoName}.git`;
  }

  // -------------------------------------------------------------------------
  // Instructions
  // -------------------------------------------------------------------------

  getSetupInstructions(): string {
    const { platform } = process;

    let installCmd = '';
    if (platform === 'darwin') {
      installCmd = 'brew install gh';
    } else if (platform === 'linux') {
      installCmd = `# Debian/Ubuntu:
sudo apt install gh

# Fedora:
sudo dnf install gh

# Arch Linux:
sudo pacman -S github-cli`;
    } else if (platform === 'win32') {
      installCmd = `# Using winget:
winget install GitHub.cli

# Using scoop:
scoop install gh`;
    }

    return `GitHub CLI (gh) - Recommended for the best experience

Installation:
${installCmd}

After installing, authenticate:
gh auth login

Benefits:
- Automatic repository creation
- No manual token management
- Easy authentication refresh

Learn more: https://cli.github.com/`;
  }

  getAltAuthInstructions(): string {
    return `Alternative authentication methods for GitHub:

1. SSH Keys (recommended if gh CLI unavailable)
   - Generate: ssh-keygen -t ed25519
   - Add to GitHub: https://github.com/settings/ssh/new
   - Test: ssh -T git@github.com

2. Personal Access Token
   - Create at: https://github.com/settings/tokens
   - Required scope: "repo" for private repositories
   - Use as password when pushing

For detailed instructions, see:
https://docs.github.com/en/authentication`;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private validateRepoName(repoName: string): void {
    // Allow full URLs
    if (repoName.includes('://') || repoName.startsWith('git@')) {
      if (/[;&|`$(){}[\]<>!#*?]/.test(repoName.replace(/[/:@.]/g, ''))) {
        throw new ProviderError(`Invalid repository URL: ${repoName}`, 'github');
      }
      return;
    }

    // For owner/repo or repo format, validate strictly
    const validPattern = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/;
    if (!validPattern.test(repoName)) {
      throw new ProviderError(`Invalid repository name: ${repoName}`, 'github', [
        'Repository names can only contain alphanumeric characters, hyphens, underscores, and dots',
        'Format: "owner/repo" or "repo"',
      ]);
    }
  }

  private async getPreferredProtocol(): Promise<'ssh' | 'https'> {
    try {
      const { stdout } = await execFileAsync('gh', ['config', 'get', 'git_protocol']);
      return stdout.trim().toLowerCase() === 'ssh' ? 'ssh' : 'https';
    } catch {
      return 'https';
    }
  }
}

// Export singleton instance
export const githubProvider = new GitHubProvider();
