import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { GitHubCliError } from '../errors.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Validate repository name/identifier to prevent command injection.
 * Valid formats: "owner/repo", "repo", or full URLs
 */
const validateRepoName = (repoName: string): void => {
  // Allow full URLs (https:// or git@)
  if (repoName.includes('://') || repoName.startsWith('git@')) {
    // Basic URL validation - must not contain shell metacharacters
    if (/[;&|`$(){}[\]<>!#*?]/.test(repoName.replace(/[/:@.]/g, ''))) {
      throw new GitHubCliError(`Invalid repository URL: ${repoName}`);
    }
    return;
  }

  // For owner/repo or repo format, validate strictly
  // Valid: alphanumeric, hyphens, underscores, dots, and single forward slash
  const validPattern = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/;
  if (!validPattern.test(repoName)) {
    throw new GitHubCliError(`Invalid repository name: ${repoName}`, [
      'Repository names can only contain alphanumeric characters, hyphens, underscores, and dots',
      'Format: "owner/repo" or "repo"',
    ]);
  }
};

export interface GitHubUser {
  login: string;
  name: string | null;
  email: string | null;
}

export interface GitHubRepo {
  name: string;
  fullName: string;
  url: string;
  sshUrl: string;
  httpsUrl: string;
  isPrivate: boolean;
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  isPrivate?: boolean;
  homepage?: string;
}

/**
 * Check if the GitHub CLI (gh) is installed
 */
export const isGhInstalled = async (): Promise<boolean> => {
  try {
    await execAsync('gh --version');
    return true;
  } catch {
    return false;
  }
};

/**
 * Check if the user is authenticated with GitHub CLI
 */
export const isGhAuthenticated = async (): Promise<boolean> => {
  try {
    const { stdout } = await execAsync('gh auth status');
    return stdout.includes('Logged in') || !stdout.includes('not logged in');
  } catch (error) {
    // gh auth status returns exit code 1 when not authenticated
    // but still outputs to stderr
    if (error instanceof Error && 'stderr' in error) {
      const stderr = (error as { stderr: string }).stderr;
      return stderr.includes('Logged in');
    }
    return false;
  }
};

/**
 * Get the authenticated GitHub user's information
 */
export const getAuthenticatedUser = async (): Promise<GitHubUser> => {
  if (!(await isGhInstalled())) {
    throw new GitHubCliError('GitHub CLI is not installed');
  }

  if (!(await isGhAuthenticated())) {
    throw new GitHubCliError('Not authenticated with GitHub CLI', [
      'Run `gh auth login` to authenticate',
    ]);
  }

  try {
    const { stdout } = await execAsync('gh api user --jq ".login, .name, .email"');
    const lines = stdout.trim().split('\n');
    return {
      login: lines[0] || '',
      name: lines[1] !== 'null' ? lines[1] : null,
      email: lines[2] !== 'null' ? lines[2] : null,
    };
  } catch (error) {
    throw new GitHubCliError('Failed to get user information', [
      String(error),
      'Check your GitHub CLI authentication',
    ]);
  }
};

/**
 * Check if a repository exists on GitHub
 */
export const repoExists = async (repoName: string): Promise<boolean> => {
  try {
    validateRepoName(repoName);
    await execFileAsync('gh', ['repo', 'view', repoName, '--json', 'name']);
    return true;
  } catch {
    return false;
  }
};

/**
 * Create a new GitHub repository
 */
export const createRepo = async (options: CreateRepoOptions): Promise<GitHubRepo> => {
  if (!(await isGhInstalled())) {
    throw new GitHubCliError('GitHub CLI is not installed');
  }

  if (!(await isGhAuthenticated())) {
    throw new GitHubCliError('Not authenticated with GitHub CLI', [
      'Run `gh auth login` to authenticate',
    ]);
  }

  // Check if repo already exists
  const user = await getAuthenticatedUser();
  const fullName = `${user.login}/${options.name}`;

  if (await repoExists(fullName)) {
    throw new GitHubCliError(`Repository "${fullName}" already exists`, [
      `Use a different name or run \`tuck init --remote ${fullName}\``,
    ]);
  }

  // Validate inputs to prevent command injection
  validateRepoName(options.name);
  
  if (options.description && /[;&|`$(){}[\]<>!#*?]/.test(options.description)) {
    throw new GitHubCliError('Invalid description: contains unsafe characters');
  }
  
  if (options.homepage && /[;&|`$(){}[\]<>!#*?]/.test(options.homepage)) {
    throw new GitHubCliError('Invalid homepage: contains unsafe characters');
  }

  try {
    // Build command arguments array to prevent command injection
    const args: string[] = ['repo', 'create', options.name];
    
    if (options.isPrivate !== false) {
      args.push('--private');
    } else {
      args.push('--public');
    }
    
    if (options.description) {
      args.push('--description', options.description);
    }
    
    if (options.homepage) {
      args.push('--homepage', options.homepage);
    }
    
    args.push('--confirm', '--json', 'name,url,sshUrl');
    
    const { stdout } = await execFileAsync('gh', args);
    const result = JSON.parse(stdout);

    return {
      name: result.name,
      fullName: `${user.login}/${result.name}`,
      url: result.url,
      sshUrl: result.sshUrl,
      httpsUrl: result.url.replace('github.com', 'github.com').replace(/^https?:\/\//, 'https://'),
      isPrivate: options.isPrivate !== false,
    };
  } catch (error) {
    throw new GitHubCliError(`Failed to create repository "${options.name}"`, [
      String(error),
      'Check your GitHub permissions',
    ]);
  }
};

/**
 * Get the preferred remote URL format (SSH or HTTPS)
 */
export const getPreferredRemoteProtocol = async (): Promise<'ssh' | 'https'> => {
  try {
    const { stdout } = await execAsync('gh config get git_protocol');
    const protocol = stdout.trim().toLowerCase();
    return protocol === 'ssh' ? 'ssh' : 'https';
  } catch {
    // Default to HTTPS if we can't determine preference
    return 'https';
  }
};

/**
 * Get repository information from GitHub
 */
export const getRepoInfo = async (repoName: string): Promise<GitHubRepo | null> => {
  try {
    validateRepoName(repoName);
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
};

/**
 * Clone a repository to a specific directory using gh CLI
 */
export const ghCloneRepo = async (repoName: string, targetDir: string): Promise<void> => {
  if (!(await isGhInstalled())) {
    throw new GitHubCliError('GitHub CLI is not installed');
  }

  validateRepoName(repoName);

  try {
    await execFileAsync('gh', ['repo', 'clone', repoName, targetDir]);
  } catch (error) {
    throw new GitHubCliError(`Failed to clone repository "${repoName}"`, [
      String(error),
      'Check that the repository exists and you have access',
    ]);
  }
};

/**
 * Find a user's dotfiles repository (checks common names)
 */
export const findDotfilesRepo = async (username?: string): Promise<string | null> => {
  const user = username || (await getAuthenticatedUser()).login;
  const commonNames = ['dotfiles', 'tuck', '.dotfiles', 'dot-files', 'dots'];

  for (const name of commonNames) {
    const repoName = `${user}/${name}`;
    if (await repoExists(repoName)) {
      return repoName;
    }
  }

  return null;
};

/**
 * Get the remote URL in the user's preferred format (SSH or HTTPS)
 */
export const getPreferredRepoUrl = async (repo: GitHubRepo): Promise<string> => {
  const protocol = await getPreferredRemoteProtocol();
  return protocol === 'ssh' ? repo.sshUrl : repo.httpsUrl;
};
