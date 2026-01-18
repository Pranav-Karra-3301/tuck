/**
 * GitLab Provider Implementation
 *
 * Provides GitLab integration via the `glab` CLI tool.
 * Supports both gitlab.com and self-hosted instances.
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
  validateRepoName as validateRepoNameUtil,
  validateDescription as validateDescriptionUtil,
  sanitizeErrorMessage,
} from '../validation.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

const COMMON_DOTFILE_REPO_NAMES = ['dotfiles', 'tuck', '.dotfiles', 'dot-files', 'dots'];
const DEFAULT_GITLAB_HOST = 'gitlab.com';

// ============================================================================
// GitLab Provider
// ============================================================================

export class GitLabProvider implements GitProvider {
  readonly mode = 'gitlab' as const;
  readonly displayName = 'GitLab';
  readonly cliName = 'glab';
  readonly requiresRemote = true;

  /** The GitLab host (gitlab.com or self-hosted URL) */
  private host: string;

  constructor(host: string = DEFAULT_GITLAB_HOST) {
    // Normalize host - remove protocol if present
    this.host = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  /** Create a provider for a specific host */
  static forHost(host: string): GitLabProvider {
    return new GitLabProvider(host);
  }

  // -------------------------------------------------------------------------
  // Detection & Authentication
  // -------------------------------------------------------------------------

  async isCliInstalled(): Promise<boolean> {
    try {
      await execFileAsync('glab', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const { stdout, stderr } = await execFileAsync('glab', ['auth', 'status', '-h', this.host]);
      const output = (stderr || stdout || '').trim();
      // glab outputs "Logged in to <host> as <username>" on success
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
      // glab api returns user info
      const { stdout } = await execFileAsync('glab', ['api', 'user', '-h', this.host]);
      const data = JSON.parse(stdout);
      return {
        login: data.username || '',
        name: data.name || null,
        email: data.email || null,
      };
    } catch (error) {
      // Primary API call failed - try fallback method
      // This is expected if user doesn't have API access
      try {
        const { stdout, stderr } = await execFileAsync('glab', ['auth', 'status', '-h', this.host]);
        const output = stderr || stdout || '';
        // Parse "Logged in to gitlab.com as username" format
        const match = output.match(/Logged in to .+ as (\S+)/);
        if (match) {
          return {
            login: match[1],
            name: null,
            email: null,
          };
        }
      } catch (fallbackError) {
        // Both methods failed - gracefully return null
        // This allows the application to continue with limited user info
      }
      return null;
    }
  }

  async detect(): Promise<ProviderDetection> {
    const cliInstalled = await this.isCliInstalled();

    if (!cliInstalled) {
      return {
        mode: this.mode,
        displayName: this.getDisplayNameWithHost(),
        available: false,
        authStatus: {
          cliInstalled: false,
          authenticated: false,
          instanceUrl: this.getInstanceUrl(),
        },
        unavailableReason: 'GitLab CLI (glab) is not installed',
      };
    }

    const authenticated = await this.isAuthenticated();
    const user = authenticated ? await this.getUser() : undefined;

    return {
      mode: this.mode,
      displayName: this.getDisplayNameWithHost(),
      available: authenticated,
      authStatus: {
        cliInstalled: true,
        authenticated,
        user: user || undefined,
        instanceUrl: this.getInstanceUrl(),
      },
      unavailableReason: !authenticated ? `Not logged in to GitLab (${this.host})` : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Repository Operations
  // -------------------------------------------------------------------------

  async repoExists(repoName: string): Promise<boolean> {
    this.validateRepoName(repoName);
    try {
      await execFileAsync('glab', ['repo', 'view', repoName, '-h', this.host]);
      return true;
    } catch {
      return false;
    }
  }

  async createRepo(options: CreateRepoOptions): Promise<ProviderRepo> {
    if (!(await this.isCliInstalled())) {
      throw new ProviderError('GitLab CLI is not installed', 'gitlab', [
        'Install with: brew install glab (macOS)',
        'Or see: https://gitlab.com/gitlab-org/cli',
      ]);
    }

    if (!(await this.isAuthenticated())) {
      throw new ProviderError(`Not authenticated with GitLab (${this.host})`, 'gitlab', [
        `Run: glab auth login -h ${this.host}`,
      ]);
    }

    const user = await this.getUser();
    if (!user) {
      throw new ProviderError('Could not get GitLab user information', 'gitlab');
    }

    // Validate inputs BEFORE checking if repo exists (to fail fast)
    this.validateRepoName(options.name);

    // Validate description if provided (improved validation)
    if (options.description) {
      try {
        validateDescriptionUtil(options.description, 2000); // GitLab allows 2000 chars
      } catch (error) {
        throw new ProviderError(
          error instanceof Error ? error.message : 'Invalid description',
          'gitlab'
        );
      }
    }

    const fullName = `${user.login}/${options.name}`;

    if (await this.repoExists(fullName)) {
      throw new ProviderError(`Repository "${fullName}" already exists`, 'gitlab', [
        `Use a different name or import the existing repo`,
      ]);
    }

    const args: string[] = ['repo', 'create', options.name, '-h', this.host];

    // GitLab uses --private and --public flags
    if (options.isPrivate !== false) {
      args.push('--private');
    } else {
      args.push('--public');
    }

    if (options.description) {
      args.push('--description', options.description);
    }

    // Add --confirm to skip prompts (glab calls it -y or --yes)
    args.push('-y');

    try {
      const { stdout } = await execFileAsync('glab', args);

      // Parse the output to get repo info
      // glab outputs the URL of the created repo
      const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
      const repoUrl = urlMatch ? urlMatch[0] : `https://${this.host}/${fullName}`;

      return {
        name: options.name,
        fullName,
        url: repoUrl,
        sshUrl: `git@${this.host}:${fullName}.git`,
        httpsUrl: `https://${this.host}/${fullName}.git`,
        isPrivate: options.isPrivate !== false,
      };
    } catch (error) {
      // Sanitize error message to prevent information disclosure
      const sanitizedMessage = sanitizeErrorMessage(error, 'Failed to create repository');
      throw new ProviderError(sanitizedMessage, 'gitlab', [
        `Try creating the repository manually at https://${this.host}/projects/new`,
      ]);
    }
  }

  async getRepoInfo(repoName: string): Promise<ProviderRepo | null> {
    this.validateRepoName(repoName);
    try {
      const { stdout } = await execFileAsync('glab', [
        'repo',
        'view',
        repoName,
        '-h',
        this.host,
        '-o',
        'json',
      ]);
      const result = JSON.parse(stdout);

      const pathWithNamespace = result.path_with_namespace || repoName;

      return {
        name: result.name || repoName.split('/').pop() || repoName,
        fullName: pathWithNamespace,
        url: result.web_url || `https://${this.host}/${pathWithNamespace}`,
        sshUrl: result.ssh_url_to_repo || `git@${this.host}:${pathWithNamespace}.git`,
        httpsUrl: result.http_url_to_repo || `https://${this.host}/${pathWithNamespace}.git`,
        isPrivate: result.visibility === 'private',
      };
    } catch {
      return null;
    }
  }

  async cloneRepo(repoName: string, targetDir: string): Promise<void> {
    if (!(await this.isCliInstalled())) {
      throw new ProviderError('GitLab CLI is not installed', 'gitlab');
    }

    this.validateRepoName(repoName);

    try {
      await execFileAsync('glab', ['repo', 'clone', repoName, targetDir, '-h', this.host]);
    } catch (error) {
      throw new ProviderError(`Failed to clone repository "${repoName}"`, 'gitlab', [
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
    const host = this.host.replace(/\./g, '\\.');
    const httpsPattern = new RegExp(`^https://${host}/`);
    const sshPattern = new RegExp(`^git@${host}:`);
    const sshUrlPattern = new RegExp(`^ssh://git@${host}/`);

    return httpsPattern.test(url) || sshPattern.test(url) || sshUrlPattern.test(url);
  }

  buildRepoUrl(username: string, repoName: string, protocol: 'ssh' | 'https'): string {
    if (protocol === 'ssh') {
      return `git@${this.host}:${username}/${repoName}.git`;
    }
    return `https://${this.host}/${username}/${repoName}.git`;
  }

  // -------------------------------------------------------------------------
  // Instructions
  // -------------------------------------------------------------------------

  getSetupInstructions(): string {
    const { platform } = process;

    let installCmd = '';
    if (platform === 'darwin') {
      installCmd = 'brew install glab';
    } else if (platform === 'linux') {
      installCmd = `# Debian/Ubuntu:
# Download from https://gitlab.com/gitlab-org/cli/-/releases

# Or using brew:
brew install glab`;
    } else if (platform === 'win32') {
      installCmd = `# Using winget:
winget install GitLab.glab

# Using scoop:
scoop install glab`;
    }

    const hostInstructions =
      this.host !== DEFAULT_GITLAB_HOST
        ? `
For self-hosted GitLab (${this.host}):
glab auth login -h ${this.host}`
        : '';

    return `GitLab CLI (glab) - Official GitLab command line tool

Installation:
${installCmd}

After installing, authenticate:
glab auth login
${hostInstructions}

Benefits:
- Automatic repository creation
- No manual token management
- Works with self-hosted GitLab

Learn more: https://gitlab.com/gitlab-org/cli`;
  }

  getAltAuthInstructions(): string {
    return `Alternative authentication methods for GitLab:

1. SSH Keys (recommended if glab CLI unavailable)
   - Generate: ssh-keygen -t ed25519
   - Add to GitLab: https://${this.host}/-/user_settings/ssh_keys
   - Test: ssh -T git@${this.host}

2. Personal Access Token
   - Create at: https://${this.host}/-/user_settings/personal_access_tokens
   - Required scopes: "api", "read_repository", "write_repository"
   - Use as password when pushing

For detailed instructions, see:
https://docs.gitlab.com/ee/user/ssh.html`;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private validateRepoName(repoName: string): void {
    try {
      validateRepoNameUtil(repoName, 'gitlab');
    } catch (error) {
      throw new ProviderError(
        error instanceof Error ? error.message : 'Invalid repository name',
        'gitlab'
      );
    }
  }

  private async getPreferredProtocol(): Promise<'ssh' | 'https'> {
    try {
      const { stdout } = await execFileAsync('glab', [
        'config',
        'get',
        'git_protocol',
        '-h',
        this.host,
      ]);
      return stdout.trim().toLowerCase() === 'ssh' ? 'ssh' : 'https';
    } catch {
      return 'https';
    }
  }

  private getDisplayNameWithHost(): string {
    if (this.host === DEFAULT_GITLAB_HOST) {
      return 'GitLab';
    }
    return `GitLab (${this.host})`;
  }

  private getInstanceUrl(): string {
    return `https://${this.host}`;
  }
}

// Export default instance for gitlab.com
export const gitlabProvider = new GitLabProvider();
