import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitHubCliError } from '../errors.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

/** API request timeout in milliseconds (10 seconds) */
const API_REQUEST_TIMEOUT_MS = 10000;

/**
 * Git credential helper fallback cache timeout in seconds (24 hours).
 * This is used when the git credential helper falls back to cache mode on Linux.
 */
const GIT_CREDENTIAL_CACHE_FALLBACK_TIMEOUT_SECONDS = 86400;

/** Days threshold for warning about potentially expired tokens (85 days, before typical 90-day expiration) */
const TOKEN_EXPIRATION_WARNING_DAYS = 85;

/** Minimum length for a valid GitHub token */
export const MIN_GITHUB_TOKEN_LENGTH = 20;

/**
 * Valid GitHub token prefixes for validation purposes.
 * Note: detectTokenType() only distinguishes between fine-grained (github_pat_)
 * and classic (ghp_) tokens, but GitHub issues other token types that should
 * still be accepted as valid (gho_, ghu_, ghs_, ghr_).
 */
export const GITHUB_TOKEN_PREFIXES = [
  'github_pat_', // Fine-grained PAT
  'ghp_', // Classic PAT
  'gho_', // OAuth token
  'ghu_', // User token
  'ghs_', // Server token
  'ghr_', // Refresh token
] as const;

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
    await execFileAsync('gh', ['--version']);
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
    // gh auth status outputs to stderr, not stdout
    // execFileAsync provides both stdout and stderr even on success
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status']);
    // Check stderr (where gh auth status outputs) and stdout (as fallback)
    const output = (stderr || stdout || '').trim();
    // Only return true if we can definitively confirm authentication
    // Check for positive indicator, not absence of negative indicator
    return output.includes('Logged in');
  } catch (error) {
    // gh auth status returns exit code 1 when not authenticated
    // and outputs error message to stderr
    if (error instanceof Error && 'stderr' in error) {
      const stderr = (error as { stderr: string }).stderr;
      // Only return true if stderr explicitly confirms authentication
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
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login, .name, .email']);
    const lines = stdout.trim().split('\n');

    // Handle empty response from GitHub API
    if (lines.length === 0 || !lines[0]) {
      throw new GitHubCliError('Empty response from GitHub API', [
        'Check your GitHub CLI authentication: gh auth status',
        'Try re-authenticating: gh auth login',
      ]);
    }

    return {
      login: lines[0] || '',
      name: lines[1] !== 'null' ? lines[1] : null,
      email: lines[2] !== 'null' ? lines[2] : null,
    };
  } catch (error) {
    // Re-throw GitHubCliError as-is (from empty response check above)
    if (error instanceof GitHubCliError) {
      throw error;
    }
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

interface RepoCreationDiagnosis {
  reason: string;
  suggestions: string[];
}

/**
 * Diagnose why repository creation failed and provide helpful suggestions
 */
const diagnoseRepoCreationFailure = async (
  repoName: string,
  errorMessage: string
): Promise<RepoCreationDiagnosis> => {
  const errorLower = errorMessage.toLowerCase();

  // Check if repo already exists (double-check in case of race condition)
  try {
    const user = await getAuthenticatedUser();
    const fullName = `${user.login}/${repoName}`;
    if (await repoExists(fullName)) {
      return {
        reason: `Repository "${fullName}" already exists`,
        suggestions: [
          `Use the existing repository: tuck init --from ${fullName}`,
          `Delete it first at github.com/${fullName}/settings`,
          'Choose a different name for your dotfiles repository',
        ],
      };
    }
  } catch {
    // Ignore - continue with other checks
  }

  // Permission errors
  if (errorLower.includes('permission') || errorLower.includes('forbidden') || errorLower.includes('403')) {
    return {
      reason: 'Insufficient permissions to create repository',
      suggestions: [
        'Check your GitHub CLI authentication: gh auth status',
        'Re-authenticate with repo scope: gh auth login --scopes repo',
        'Create the repository manually at github.com/new',
      ],
    };
  }

  // Name already taken (in an org or different context)
  if (errorLower.includes('name already exists') || errorLower.includes('already exists')) {
    return {
      reason: `Repository name "${repoName}" is already taken`,
      suggestions: [
        'Choose a different name (e.g., "my-dotfiles", "dotfiles-backup")',
        'Check if you already have this repository: gh repo list',
        'Create the repository manually at github.com/new',
      ],
    };
  }

  // Rate limiting
  if (errorLower.includes('rate limit') || errorLower.includes('429') || errorLower.includes('too many')) {
    return {
      reason: 'GitHub API rate limit exceeded',
      suggestions: [
        'Wait a few minutes and try again',
        'Create the repository manually at github.com/new',
      ],
    };
  }

  // Network issues
  if (
    errorLower.includes('network') ||
    errorLower.includes('enotfound') ||
    errorLower.includes('timeout') ||
    errorLower.includes('econnrefused')
  ) {
    return {
      reason: 'Network error - could not reach GitHub',
      suggestions: [
        'Check your internet connection',
        'Try again in a moment',
        'Create the repository manually at github.com/new',
      ],
    };
  }

  // Authentication expired or invalid
  if (errorLower.includes('401') || errorLower.includes('unauthorized') || errorLower.includes('bad credentials')) {
    return {
      reason: 'GitHub authentication expired or invalid',
      suggestions: [
        'Re-authenticate: gh auth login',
        'Check your token: gh auth status',
      ],
    };
  }

  // Generic fallback with manual instructions
  return {
    reason: `Failed to create repository "${repoName}"`,
    suggestions: [
      'Create the repository manually:',
      '  1. Go to github.com/new',
      `  2. Name: ${repoName}`,
      '  3. Visibility: Private (recommended)',
      '  4. Do NOT initialize with README/.gitignore',
      '  5. Click "Create repository"',
      '  6. Copy the URL and paste when prompted',
    ],
  };
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnosis = await diagnoseRepoCreationFailure(options.name, errorMessage);
    throw new GitHubCliError(diagnosis.reason, diagnosis.suggestions);
  }
};

/**
 * Get the preferred remote URL format (SSH or HTTPS)
 */
export const getPreferredRemoteProtocol = async (): Promise<'ssh' | 'https'> => {
  try {
    const { stdout } = await execFileAsync('gh', ['config', 'get', 'git_protocol']);
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

// ============================================================================
// Alternative Authentication Methods (when GitHub CLI is not available)
// ============================================================================

export interface SSHKeyInfo {
  exists: boolean;
  path: string;
  publicKeyPath: string;
  publicKey?: string;
}

/**
 * Check if SSH keys exist for GitHub
 */
export const checkSSHKeys = async (): Promise<SSHKeyInfo> => {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { readFile } = await import('fs/promises');
  const { pathExists } = await import('./paths.js');

  const sshDir = join(homedir(), '.ssh');
  const keyTypes = ['id_ed25519', 'id_rsa', 'id_ecdsa'];

  for (const keyType of keyTypes) {
    const privateKeyPath = join(sshDir, keyType);
    const publicKeyPath = `${privateKeyPath}.pub`;

    if (await pathExists(publicKeyPath)) {
      try {
        const publicKey = await readFile(publicKeyPath, 'utf-8');
        return {
          exists: true,
          path: privateKeyPath,
          publicKeyPath,
          publicKey: publicKey.trim(),
        };
      } catch {
        return {
          exists: true,
          path: privateKeyPath,
          publicKeyPath,
        };
      }
    }
  }

  return {
    exists: false,
    path: join(sshDir, 'id_ed25519'),
    publicKeyPath: join(sshDir, 'id_ed25519.pub'),
  };
};

/**
 * Determine the appropriate StrictHostKeyChecking option for GitHub SSH tests.
 * Uses "yes" if github.com is already in known_hosts, otherwise "accept-new".
 */
const getStrictHostKeyCheckingOption = async (): Promise<string> => {
  try {
    const { homedir } = await import('os');
    const { join } = await import('path');
    const { readFile } = await import('fs/promises');

    const sshDir = join(homedir(), '.ssh');
    const knownHostsPath = join(sshDir, 'known_hosts');

    const knownHostsContent = await readFile(knownHostsPath, 'utf-8');

    // Check if github.com already has a plain-text entry by looking for lines that start with 'github.com'
    // Note: We don't check hashed entries (|1|...) because we can't verify the hostname without
    // attempting the SSH connection. For security purposes, we only trust explicit github.com entries.
    // Format: "github.com[,port] key-type key-data [comment]" or "@marker github.com[,port] key-type..."
    const hasGitHubEntry = knownHostsContent.split('\n').some((line) => {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) return false;

      // Handle @marker entries (e.g., @cert-authority or @revoked)
      const fields = trimmed.split(/\s+/);
      // Handle empty fields array edge case
      if (fields.length === 0) return false;

      const hostnamePart = trimmed.startsWith('@')
        ? fields.length > 1
          ? fields[1]
          : undefined // Get second field after marker, if exists
        : fields[0]; // Get first field for regular entries

      // Check for exact hostname match (github.com or github.com,port)
      if (!hostnamePart) return false;
      return hostnamePart === 'github.com' || hostnamePart.startsWith('github.com,');
    });

    if (hasGitHubEntry) {
      return 'yes';
    }
  } catch {
    // If known_hosts doesn't exist or can't be read, fall back to accept-new
    // to preserve existing behavior for first-time setups.
  }

  // Use accept-new for better UX on first connection. This will automatically
  // trust a new host key, which can weaken protection against MITM attacks during
  // initial key establishment. However, since the target is hard-coded to github.com,
  // whose SSH host keys are well-known and documented, the practical risk is low.
  return 'accept-new';
};

/**
 * Test if SSH connection to GitHub works
 */
export const testSSHConnection = async (): Promise<{ success: boolean; username?: string }> => {
  try {
    const strictHostKeyChecking = await getStrictHostKeyCheckingOption();
    // ssh -T git@github.com returns exit code 1 even on success, but outputs the username
    const { stderr } = await execFileAsync('ssh', ['-T', '-o', `StrictHostKeyChecking=${strictHostKeyChecking}`, 'git@github.com']);
    const match = stderr.match(/Hi ([^!]+)!/);
    if (match) {
      return { success: true, username: match[1] };
    }
    return { success: false };
  } catch (error) {
    // SSH returns exit code 1 even on successful auth, check stderr for success message
    if (error instanceof Error && 'stderr' in error) {
      const stderr = (error as { stderr: string }).stderr;
      const match = stderr.match(/Hi ([^!]+)!/);
      if (match) {
        return { success: true, username: match[1] };
      }
    }
    return { success: false };
  }
};

/**
 * Get instructions for generating SSH keys
 */
export const getSSHKeyInstructions = (email?: string): string => {
  const emailFlag = email ? ` -C "${email}"` : '';

  return `
To set up SSH authentication with GitHub:

1. Generate a new SSH key (recommended: Ed25519):
   ssh-keygen -t ed25519${emailFlag}

   Press Enter to accept the default file location
   Enter a passphrase (recommended) or press Enter for none

2. Start the SSH agent:
   eval "$(ssh-agent -s)"

3. Add your SSH key to the agent:
   ssh-add ~/.ssh/id_ed25519

4. Copy your public key:
   - macOS: pbcopy < ~/.ssh/id_ed25519.pub
   - Linux: cat ~/.ssh/id_ed25519.pub

5. Add the key to GitHub:
   - Go to: https://github.com/settings/ssh/new
   - Title: Your computer name (e.g., "MacBook Pro")
   - Key type: Authentication Key
   - Key: Paste your public key
   - Click "Add SSH key"

6. Test the connection:
   ssh -T git@github.com

   You should see: "Hi username! You've successfully authenticated..."
`.trim();
};

/**
 * Get instructions for creating a fine-grained personal access token
 */
export const getFineGrainedTokenInstructions = (repoName?: string): string => {
  return `
To create a Fine-grained Personal Access Token (recommended):

1. Go to: https://github.com/settings/tokens?type=beta

2. Click "Generate new token"

3. Configure the token:
   - Token name: "tuck-dotfiles" (or any descriptive name)
   - Expiration: 90 days (or custom, can be renewed)
   - Description: "Token for tuck dotfiles manager"

4. Repository access:
   - Select "Only select repositories"
   - Choose your dotfiles repository${repoName ? ` (${repoName})` : ''}
   - Or select "All repositories" if you haven't created it yet

5. Permissions needed (under "Repository permissions"):
   ┌─────────────────────────┬─────────────────┐
   │ Permission              │ Access Level    │
   ├─────────────────────────┼─────────────────┤
   │ Contents                │ Read and write  │
   │ Metadata                │ Read-only       │
   └─────────────────────────┴─────────────────┘

   That's it! Only 2 permissions needed.

6. Click "Generate token"

7. IMPORTANT: Copy the token immediately!
   It won't be shown again.

8. Configure git to use the token:
   When pushing, use this as your password:
   - Username: your-github-username
   - Password: github_pat_xxxxxxxxxxxx (your token)

   Or configure credential storage:
   git config --global credential.helper store

   Then on first push, enter your token as the password
   and it will be saved for future use.
`.trim();
};

/**
 * Get instructions for creating a classic personal access token
 */
export const getClassicTokenInstructions = (): string => {
  return `
To create a Classic Personal Access Token:

Note: Fine-grained tokens are recommended for better security,
but classic tokens work if you need broader access.

1. Go to: https://github.com/settings/tokens/new

2. Configure the token:
   - Note: "tuck-dotfiles" (or any descriptive name)
   - Expiration: 90 days (or "No expiration" - less secure)

3. Select scopes (permissions):
   ┌─────────────────────────┬─────────────────────────────────────┐
   │ Scope                   │ Why it's needed                     │
   ├─────────────────────────┼─────────────────────────────────────┤
   │ ☑ repo                  │ Full access to private repositories │
   │   ☑ repo:status         │ Access commit status                │
   │   ☑ repo_deployment     │ Access deployment status            │
   │   ☑ public_repo         │ Access public repositories          │
   │   ☑ repo:invite         │ Access repository invitations       │
   └─────────────────────────┴─────────────────────────────────────┘

   Just check the top-level "repo" box - it selects all sub-items.

4. Click "Generate token"

5. IMPORTANT: Copy the token immediately!
   It starts with "ghp_" and won't be shown again.

6. Configure git to use the token:
   When pushing, use this as your password:
   - Username: your-github-username
   - Password: ghp_xxxxxxxxxxxx (your token)

   Or configure credential storage:
   git config --global credential.helper store

   Then on first push, enter your token as the password.
`.trim();
};

/**
 * Get instructions for installing GitHub CLI
 */
export const getGitHubCLIInstallInstructions = (): string => {
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
scoop install gh

# Using chocolatey:
choco install gh`;
  }

  return `
GitHub CLI (gh) - Recommended for the best experience

The GitHub CLI provides the easiest authentication and
lets tuck automatically create repositories for you.

Installation:
${installCmd}

After installing, authenticate:
gh auth login

Benefits:
- Automatic repository creation
- No manual token management
- Easy authentication refresh
- Works with SSH or HTTPS

Learn more: https://cli.github.com/
`.trim();
};

export type AuthMethod = 'gh-cli' | 'ssh' | 'fine-grained-token' | 'classic-token';

export interface AuthMethodInfo {
  id: AuthMethod;
  name: string;
  description: string;
  recommended: boolean;
  instructions: string;
}

/**
 * Get all available authentication methods with instructions
 */
export const getAuthMethods = (repoName?: string, email?: string): AuthMethodInfo[] => {
  return [
    {
      id: 'gh-cli',
      name: 'GitHub CLI (gh)',
      description: 'Easiest option - automatic repo creation, no token management',
      recommended: true,
      instructions: getGitHubCLIInstallInstructions(),
    },
    {
      id: 'ssh',
      name: 'SSH Key',
      description: 'Secure, no password needed after setup, works everywhere',
      recommended: false,
      instructions: getSSHKeyInstructions(email),
    },
    {
      id: 'fine-grained-token',
      name: 'Fine-grained Token',
      description: 'Limited permissions, more secure, repository-specific',
      recommended: false,
      instructions: getFineGrainedTokenInstructions(repoName),
    },
    {
      id: 'classic-token',
      name: 'Classic Token',
      description: 'Broader access, simpler setup, works with all repos',
      recommended: false,
      instructions: getClassicTokenInstructions(),
    },
  ];
};

/**
 * Configure git credential helper for HTTPS authentication
 */
export const configureGitCredentialHelper = async (): Promise<void> => {
  const { platform } = process;

  // Check if a credential helper is already configured
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', 'credential.helper']);
    if (stdout.trim()) {
      // User already has a credential helper configured, don't override it
      return;
    }
  } catch {
    // No credential helper configured, proceed with setup
  }

  try {
    if (platform === 'darwin') {
      // macOS - use Keychain
      await execFileAsync('git', ['config', '--global', 'credential.helper', 'osxkeychain']);
    } else if (platform === 'linux') {
      // Linux - use libsecret if available, otherwise cache
      try {
        await execFileAsync('git', ['config', '--global', 'credential.helper', 'libsecret']);
      } catch (error) {
        console.info(
          'git-credential-libsecret is not available; falling back to git credential cache helper with timeout of ' +
            `${GIT_CREDENTIAL_CACHE_FALLBACK_TIMEOUT_SECONDS} seconds.`
        );
        await execFileAsync('git', ['config', '--global', 'credential.helper', `cache --timeout=${GIT_CREDENTIAL_CACHE_FALLBACK_TIMEOUT_SECONDS}`]);
      }
    } else if (platform === 'win32') {
      // Windows - use credential manager
      await execFileAsync('git', ['config', '--global', 'credential.helper', 'manager']);
    }
  } catch {
    // Fallback to store (less secure but works everywhere)
    await execFileAsync('git', ['config', '--global', 'credential.helper', 'store']);
  }
};

// ============================================================================
// Secure Credential Management
// ============================================================================

export interface StoredCredential {
  username: string;
  token: string;
  createdAt: string;
  type: 'fine-grained' | 'classic';
}

/**
 * Get the path to the tuck credentials file
 */
const getCredentialsPath = async (): Promise<string> => {
  const { homedir } = await import('os');
  const { join } = await import('path');
  return join(homedir(), '.tuck', '.credentials.json');
};

/**
 * Store GitHub credentials securely
 * Uses git credential helper for the actual token storage
 * Stores metadata (type, creation date) in tuck config
 */
export const storeGitHubCredentials = async (
  username: string,
  token: string,
  type: 'fine-grained' | 'classic'
): Promise<void> => {
  const { writeFile, mkdir } = await import('fs/promises');
  const { dirname } = await import('path');

  // First, configure the credential helper
  await configureGitCredentialHelper();

  // Validate that username and token do not contain newline characters,
  // which would break the git credential helper protocol format.
  if (/[\r\n]/.test(username) || /[\r\n]/.test(token)) {
    throw new GitHubCliError('Username or token contains invalid newline characters.', [
      "Newline characters are not allowed in GitHub usernames or tokens because git's credential helper protocol is line-based.",
      'Each credential field is sent as "key=value" on its own line; embedded newlines would corrupt this format and cause git credential storage to fail.',
      'If you copied the token from a password manager or web page, ensure it is a single line with no trailing line breaks, then paste it again or regenerate a new token.',
    ]);
  }

  // Store the credential using git credential helper
  // This pipes the credential to git credential approve
  const credentialInput = `protocol=https\nhost=github.com\nusername=${username}\npassword=${token}\n\n`; // Note: git credential protocol requires input to be terminated with a blank line (\n\n)

  try {
    const { spawn } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', ['credential', 'approve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdin.write(credentialInput);
      proc.stdin.end();

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('git credential approve failed'));
        }
      });

      proc.on('error', reject);
    });
  } catch (error) {
    // If git credential helper fails, we can still continue.
    // The user will just be prompted for credentials on push.
    const warningMessage =
      'Failed to store GitHub credentials via `git credential approve`. ' +
      'Credentials will not be cached and you may be prompted again on push.';

    // Emit a process warning so this is visible in a non-blocking way.
    try {
      process.emitWarning(warningMessage, {
        code: 'GIT_CREDENTIAL_HELPER_FAILED',
      });
    } catch {
      // Fallback: emitting a warning should never break the main flow.
    }

    // Also log to console for environments that rely on standard output logging.
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.warn(`Warning: ${warningMessage} Error: ${errorMessage}`);
  }

  // Store metadata (not the token itself) for expiration tracking
  const credentialsPath = await getCredentialsPath();
  const metadata = {
    username,
    type,
    createdAt: new Date().toISOString(),
    // Don't store the actual token - just track that we have one
    hasToken: true,
  };

  try {
    await mkdir(dirname(credentialsPath), { recursive: true });
    // Note: File permissions (0o600) protect this metadata file on the filesystem,
    // but the username stored in this file is in plaintext and may be readable by
    // any process running as the same OS user. Only non-secret metadata such as
    // the username and token presence/creation time are stored here; the actual
    // token is stored securely via the git credential helper (e.g., osxkeychain,
    // libsecret, manager) which uses OS-level secure storage. The security of the
    // token itself depends on the credential helper implementation, not this file.
    await writeFile(credentialsPath, JSON.stringify(metadata, null, 2), {
      mode: 0o600, // Read/write only for owner
    });
  } catch (error) {
    // Non-critical - metadata storage failed, but surface a warning as this affects
    // security-relevant file permissions/metadata and token expiration tracking.
    const warningMessage =
      `Failed to store GitHub credential metadata at "${credentialsPath}". ` +
      'Token expiration tracking and verification of restricted file permissions ' +
      '(0o600) may not work as expected.';

    // Emit a process warning so this is visible to the user in a non-blocking way.
    try {
      process.emitWarning(warningMessage, {
        code: 'GITHUB_CREDENTIAL_METADATA_WRITE_FAILED',
      });
    } catch {
      // Fallback: emitting a warning should never break the main flow.
    }

    // Also log to console for environments that rely on standard output logging,
    // but avoid exposing full filesystem paths by default. Detailed information,
    // including the credential metadata path and underlying error, is only logged
    // when an explicit debug flag is enabled.
    const isDebugLoggingEnabled =
      process.env.GITHUB_DEBUG_CREDENTIALS_METADATA === '1';
    if (isDebugLoggingEnabled) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `Warning: ${warningMessage} Error: ${errorMessage}`,
      );
    } else {
      console.warn(
        'Warning: Failed to store GitHub credential metadata. ' +
          'Token expiration tracking and verification of restricted file ' +
          'permissions (0o600) may not work as expected.',
      );
    }
  }
};

/**
 * Get stored credential metadata
 */
export const getStoredCredentialMetadata = async (): Promise<{
  username?: string;
  type?: 'fine-grained' | 'classic';
  createdAt?: Date;
  hasToken?: boolean;
} | null> => {
  const { readFile } = await import('fs/promises');
  const { pathExists } = await import('./paths.js');

  const credentialsPath = await getCredentialsPath();

  if (!(await pathExists(credentialsPath))) {
    return null;
  }

  try {
    const content = await readFile(credentialsPath, 'utf-8');
    const data = JSON.parse(content);
    return {
      username: data.username,
      type: data.type,
      createdAt: data.createdAt ? new Date(data.createdAt) : undefined,
      hasToken: data.hasToken,
    };
  } catch {
    return null;
  }
};

/**
 * Remove stored credentials (both from git helper and metadata)
 */
export const removeStoredCredentials = async (): Promise<void> => {
  const { unlink } = await import('fs/promises');
  const { pathExists } = await import('./paths.js');

  // Remove from git credential helper
  try {
    const { spawn } = await import('child_process');
    await new Promise<void>((resolve) => {
      const proc = spawn('git', ['credential', 'reject'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Note: git credential protocol requires input to be terminated with a blank line (\n\n)
      proc.stdin.write('protocol=https\nhost=github.com\n\n');
      proc.stdin.end();

      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
  } catch {
    // Ignore errors
  }

  // Remove metadata file
  const credentialsPath = await getCredentialsPath();
  if (await pathExists(credentialsPath)) {
    try {
      await unlink(credentialsPath);
    } catch {
      // Ignore errors
    }
  }
};

/**
 * Test if stored credentials are still valid
 * Uses GitHub API /user endpoint which requires authentication
 */
export const testStoredCredentials = async (): Promise<{
  valid: boolean;
  reason?: 'expired' | 'invalid' | 'network' | 'unknown';
  username?: string;
}> => {
  const metadata = await getStoredCredentialMetadata();

  if (!metadata?.hasToken) {
    return { valid: false, reason: 'unknown' };
  }

  // Get credentials from git credential helper
  let username: string | null = null;
  let password: string | null = null;

  try {
    const { spawn } = await import('child_process');
    const credentialOutput = await new Promise<string>((resolve, reject) => {
      const proc = spawn('git', ['credential', 'fill'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Request credentials for github.com
      proc.stdin.write('protocol=https\nhost=github.com\n\n');
      proc.stdin.end();

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error('git credential fill failed'));
        }
      });

      proc.on('error', reject);
    });

    // Parse credential output (format: key=value\n). Values may contain '=' characters,
    // so split into at most two parts: key and the full remaining value.
    for (const line of credentialOutput.trim().split('\n')) {
      const [key, value] = line.split('=', 2);
      if (value === undefined) {
        continue;
      }
      if (key === 'username') {
        username = value;
      } else if (key === 'password') {
        password = value;
      }
    }
  } catch {
    // If we can't get credentials, they're not valid
    return { valid: false, reason: 'unknown', username: metadata.username };
  }

  if (!username || !password) {
    return { valid: false, reason: 'unknown', username: metadata.username };
  }

  // Test credentials against GitHub API /user endpoint (requires authentication)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

    // Prefer Bearer token auth when the "password" looks like a GitHub token,
    // but fall back to Basic auth for traditional username/password credentials.
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tuck-dotfiles-manager',
    };

    const looksLikeToken =
      typeof password === 'string' &&
      password.length >= MIN_GITHUB_TOKEN_LENGTH &&
      GITHUB_TOKEN_PREFIXES.some((prefix) => password.startsWith(prefix));

    if (looksLikeToken) {
      headers.Authorization = `Bearer ${password}`;
    } else {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      headers.Authorization = `Basic ${auth}`;
    }

    try {
      const response = await fetch('https://api.github.com/user', {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 200 OK means credentials are valid
      if (response.status === 200) {
        try {
          // Parse user data to extract username (in case it differs from metadata)
          const userData = (await response.json()) as { login?: string };
          const apiUsername = userData.login || username;
          return { valid: true, username: apiUsername };
        } catch {
          // Even if we can't parse, 200 OK means auth succeeded
          // Use username from credentials if valid, otherwise fall back to metadata username
          const effectiveUsername = (username && username.trim()) || metadata.username;
          return { valid: true, username: effectiveUsername };
        }
      }

      // 401 Unauthorized means invalid credentials
      if (response.status === 401) {
        // Check if token might be expired based on creation date
        if (metadata.createdAt) {
          const daysSinceCreation = Math.floor(
            (Date.now() - metadata.createdAt.getTime()) / (1000 * 60 * 60 * 24)
          );

          // Fine-grained tokens often expire in 90 days, classic can vary
          if (daysSinceCreation > TOKEN_EXPIRATION_WARNING_DAYS) {
            return { valid: false, reason: 'expired', username: metadata.username };
          }
        }
        return { valid: false, reason: 'invalid', username: metadata.username };
      }

      // 403 Forbidden could mean token is invalid or lacks permissions
      if (response.status === 403) {
        return { valid: false, reason: 'invalid', username: metadata.username };
      }

      // Other status codes are unexpected
      return { valid: false, reason: 'unknown', username: metadata.username };
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error) {
    const errorStr = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    // Check for timeout/abort errors
    if (errorStr.includes('aborted') || errorStr.includes('timeout')) {
      return { valid: false, reason: 'network', username: metadata.username };
    }

    // Check for network-related errors
    if (
      errorStr.includes('network') ||
      errorStr.includes('enotfound') ||
      errorStr.includes('econnrefused') ||
      errorStr.includes('could not resolve') ||
      errorStr.includes('fetch failed') ||
      errorStr.includes('getaddrinfo')
    ) {
      return { valid: false, reason: 'network', username: metadata.username };
    }

    return { valid: false, reason: 'unknown', username: metadata.username };
  }
};

/**
 * Diagnose authentication issues and provide helpful suggestions
 */
export const diagnoseAuthIssue = async (): Promise<{
  issue: string;
  suggestions: string[];
}> => {
  const metadata = await getStoredCredentialMetadata();

  if (!metadata?.hasToken) {
    return {
      issue: 'No GitHub credentials configured',
      suggestions: [
        'Set up authentication using one of the methods below',
        'Run `tuck init` to configure GitHub access',
      ],
    };
  }

  const testResult = await testStoredCredentials();

  if (testResult.valid) {
    return {
      issue: 'Credentials appear to be working',
      suggestions: ['Try the operation again'],
    };
  }

  switch (testResult.reason) {
    case 'expired':
      return {
        issue: `Your ${metadata.type || 'GitHub'} token has likely expired`,
        suggestions: [
          metadata.type === 'fine-grained'
            ? 'Create a new fine-grained token at: https://github.com/settings/tokens?type=beta'
            : 'Create a new token at: https://github.com/settings/tokens/new',
          'Use the same permissions as before',
          'Run `tuck init` to update your credentials',
        ],
      };

    case 'invalid':
      return {
        issue: 'Your GitHub credentials are invalid',
        suggestions: [
          'The token may have been revoked or is incorrect',
          'Check your tokens at: https://github.com/settings/tokens',
          'Create a new token and run `tuck init` to update',
        ],
      };

    case 'network':
      return {
        issue: 'Could not connect to GitHub',
        suggestions: [
          'Check your internet connection',
          'GitHub may be experiencing issues - check https://githubstatus.com',
          'Try again in a moment',
        ],
      };

    default:
      return {
        issue: 'Unknown authentication issue',
        suggestions: [
          'Try creating a new token',
          'Check https://github.com/settings/tokens for your existing tokens',
          'Run `tuck init` to reconfigure authentication',
        ],
      };
  }
};

/**
 * Update stored credentials with a new token
 */
export const updateStoredCredentials = async (
  token: string,
  type?: 'fine-grained' | 'classic'
): Promise<void> => {
  const metadata = await getStoredCredentialMetadata();
  const username = metadata?.username;

  if (!username) {
    throw new Error(
      'GitHub credential metadata is incomplete or corrupted (missing username). ' +
      'Please remove the credential file and re-authenticate by running `tuck config` or `tuck init`.'
    );
  }

  // Determine token type, preferring explicit type, then stored metadata, then detection
  const detectedType = detectTokenType(token);
  const tokenType = type ?? metadata?.type ?? detectedType;

  // Ensure we have a valid token type (not 'unknown')
  if (tokenType !== 'fine-grained' && tokenType !== 'classic') {
    throw new Error(
      'Could not determine GitHub token type. The token format is not recognized. ' +
      'Please verify your token starts with "github_pat_" (fine-grained) or "ghp_" (classic), ' +
      'or generate a new token at https://github.com/settings/tokens'
    );
  }

  // Remove old credentials first
  await removeStoredCredentials();

  // Store new credentials
  await storeGitHubCredentials(username, token, tokenType);
};

/**
 * Detect token type from the token format
 */
export const detectTokenType = (token: string): 'fine-grained' | 'classic' | 'unknown' => {
  // Fine-grained tokens start with github_pat_
  if (token.startsWith('github_pat_')) {
    return 'fine-grained';
  }
  // Classic tokens start with ghp_
  if (token.startsWith('ghp_')) {
    return 'classic';
  }
  return 'unknown';
};
