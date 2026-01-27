import { Command } from 'commander';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { ensureDir } from 'fs-extra';
import { banner, nextSteps, prompts, withSpinner, logger, colors as c } from '../ui/index.js';
import {
  getTuckDir,
  getManifestPath,
  getConfigPath,
  getFilesDir,
  getCategoryDir,
  pathExists,
  collapsePath,
} from '../lib/paths.js';
import { saveConfig } from '../lib/config.js';
import { createManifest } from '../lib/manifest.js';
import type { TuckManifest, RemoteConfig } from '../types.js';
import {
  initRepo,
  addRemote,
  cloneRepo,
  setDefaultBranch,
  stageAll,
  commit,
  push,
} from '../lib/git.js';
import {
  setupProvider,
  detectProviderFromUrl,
  type ProviderSetupResult,
} from '../lib/providerSetup.js';
import { getProvider, describeProviderConfig, buildRemoteConfig } from '../lib/providers/index.js';
import {
  isGhInstalled,
  isGhAuthenticated,
  getAuthenticatedUser,
  createRepo,
  getPreferredRepoUrl,
  getPreferredRemoteProtocol,
  findDotfilesRepo,
  ghCloneRepo,
  checkSSHKeys,
  testSSHConnection,
  getSSHKeyInstructions,
  getFineGrainedTokenInstructions,
  getClassicTokenInstructions,
  getGitHubCLIInstallInstructions,
  storeGitHubCredentials,
  detectTokenType,
  configureGitCredentialHelper,
  testStoredCredentials,
  diagnoseAuthIssue,
  MIN_GITHUB_TOKEN_LENGTH,
  GITHUB_TOKEN_PREFIXES,
} from '../lib/github.js';
import { detectDotfiles, DetectedFile, DETECTION_CATEGORIES } from '../lib/detect.js';
import { copy } from 'fs-extra';
import { tmpdir } from 'os';
import { readFile, rm } from 'fs/promises';
import { AlreadyInitializedError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import { defaultConfig } from '../schemas/config.schema.js';
import type { InitOptions } from '../types.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { errorToMessage } from '../lib/validation.js';

const GITIGNORE_TEMPLATE = `# OS generated files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db

# Backup files
*.bak
*.backup
*~

# Secret files (add patterns for files you want to exclude)
# *.secret
# .env.local
`;

/**
 * Track selected files with beautiful progress display
 */
const trackFilesWithProgressInit = async (
  selectedPaths: string[],
  tuckDir: string
): Promise<number> => {
  // Convert paths to FileToTrack
  const filesToTrack: FileToTrack[] = selectedPaths.map((path) => ({
    path,
  }));

  // Use the shared tracking utility
  const result = await trackFilesWithProgress(filesToTrack, tuckDir, {
    showCategory: true,
    actionVerb: 'Tracking',
  });

  return result.succeeded;
};

const README_TEMPLATE = (machine?: string) => `# Dotfiles

Managed with [tuck](https://github.com/Pranav-Karra-3301/tuck) - Modern Dotfiles Manager

${machine ? `## Machine: ${machine}\n` : ''}

## Quick Start

\`\`\`bash
# Restore dotfiles to a new machine
tuck init --from <this-repo-url>

# Or clone and restore manually
git clone <this-repo-url> ~/.tuck
tuck restore --all
\`\`\`

## Commands

| Command | Description |
|---------|-------------|
| \`tuck add <paths>\` | Track new dotfiles |
| \`tuck sync\` | Sync changes to repository |
| \`tuck push\` | Push to remote |
| \`tuck pull\` | Pull from remote |
| \`tuck restore\` | Restore dotfiles to system |
| \`tuck status\` | Show tracking status |
| \`tuck list\` | List tracked files |

## Structure

\`\`\`
.tuck/
├── files/           # Tracked dotfiles organized by category
│   ├── shell/       # Shell configs (.zshrc, .bashrc, etc.)
│   ├── git/         # Git configs (.gitconfig, etc.)
│   ├── editors/     # Editor configs (nvim, vim, etc.)
│   ├── terminal/    # Terminal configs (tmux, alacritty, etc.)
│   └── misc/        # Other dotfiles
├── .tuckmanifest.json  # Tracks all managed files
└── .tuckrc.json        # Tuck configuration
\`\`\`
`;

/**
 * Validates a GitHub repository URL (HTTPS or SSH format) and checks for owner/repo pattern
 * @param value The URL to validate
 * @returns undefined if valid, or an error message string if invalid
 */
const validateGitHubUrl = (value: string): string | undefined => {
  if (!value) return 'Repository URL is required';

  const isGitHubHttps = value.startsWith('https://github.com/');
  const isGitHubSsh = value.startsWith('git@github.com:');

  if (!isGitHubHttps && !isGitHubSsh) {
    return 'Please enter a valid GitHub URL';
  }

  // Validate URL contains owner/repo pattern
  if (isGitHubHttps) {
    // HTTPS format: https://github.com/owner/repo[.git]
    const pathPart = value.substring('https://github.com/'.length);
    if (!pathPart.includes('/') || pathPart === '/') {
      return 'GitHub URL must include owner and repository name (e.g., https://github.com/owner/repo)';
    }
  } else if (isGitHubSsh) {
    // SSH format: git@github.com:owner/repo[.git]
    const pathPart = value.substring('git@github.com:'.length);
    if (!pathPart.includes('/') || pathPart === '/') {
      return 'GitHub URL must include owner and repository name (e.g., git@github.com:owner/repo.git)';
    }
  }

  return undefined;
};

/**
 * Validate any Git repository URL (not just GitHub)
 * Used when cloning existing repositories that may be hosted anywhere
 */
const validateGitUrl = (value: string): string | undefined => {
  if (!value) return 'Repository URL is required';

  const trimmed = value.trim();

  // Check for common Git URL patterns
  const isHttps = /^https?:\/\/.+\/.+/.test(trimmed); // Must have at least host/path
  const isSshScp = /^[^@]+@[^@:]+:[^:]+\/.+/.test(trimmed); // e.g. git@host:user/repo.git
  const isSshUrl = /^ssh:\/\/.+\/.+/.test(trimmed); // e.g. ssh://git@host/user/repo.git

  if (!isHttps && !isSshScp && !isSshUrl) {
    return 'Please enter a valid Git repository URL (HTTPS or SSH format)';
  }

  return undefined;
};

const createDirectoryStructure = async (tuckDir: string): Promise<void> => {
  // Create main directories
  await ensureDir(tuckDir);
  await ensureDir(getFilesDir(tuckDir));

  // Create category directories
  for (const category of Object.keys(CATEGORIES)) {
    await ensureDir(getCategoryDir(tuckDir, category));
  }
};

const createDefaultFiles = async (tuckDir: string, machine?: string): Promise<void> => {
  // Create .gitignore only if it doesn't exist
  const gitignorePath = join(tuckDir, '.gitignore');
  if (!(await pathExists(gitignorePath))) {
    await writeFile(gitignorePath, GITIGNORE_TEMPLATE, 'utf-8');
  }

  // Create README.md only if it doesn't exist
  const readmePath = join(tuckDir, 'README.md');
  if (!(await pathExists(readmePath))) {
    await writeFile(readmePath, README_TEMPLATE(machine), 'utf-8');
  }
};

const initFromScratch = async (
  tuckDir: string,
  options: { remote?: string; bare?: boolean; remoteConfig?: RemoteConfig }
): Promise<void> => {
  // Check if already initialized
  if (await pathExists(getManifestPath(tuckDir))) {
    throw new AlreadyInitializedError(tuckDir);
  }

  // Create directory structure
  await withSpinner('Creating directory structure...', async () => {
    await createDirectoryStructure(tuckDir);
  });

  // Initialize git repository
  await withSpinner('Initializing git repository...', async () => {
    await initRepo(tuckDir);
    await setDefaultBranch(tuckDir, 'main');
  });

  // Create manifest
  await withSpinner('Creating manifest...', async () => {
    const hostname = (await import('os')).hostname();
    await createManifest(tuckDir, hostname);
  });

  // Create config with remote settings
  await withSpinner('Creating configuration...', async () => {
    await saveConfig(
      {
        ...defaultConfig,
        repository: { ...defaultConfig.repository, path: tuckDir },
        remote: options.remoteConfig || defaultConfig.remote,
      },
      tuckDir
    );
  });

  // Create default files unless --bare
  if (!options.bare) {
    await withSpinner('Creating default files...', async () => {
      const hostname = (await import('os')).hostname();
      await createDefaultFiles(tuckDir, hostname);
    });
  }

  // Add remote if provided
  if (options.remote) {
    await withSpinner('Adding remote...', async () => {
      await addRemote(tuckDir, 'origin', options.remote!);
    });
  }
};

interface GitHubSetupResult {
  remoteUrl: string | null;
  pushed: boolean;
}

/**
 * Set up alternative authentication (SSH or tokens)
 */
const setupAlternativeAuth = async (tuckDir: string): Promise<GitHubSetupResult> => {
  console.log();
  prompts.log.info("GitHub CLI not available. Let's set up authentication another way.");
  console.log();

  // Check for existing credentials and test them
  const credTest = await testStoredCredentials();
  if (credTest.valid && credTest.username) {
    prompts.log.success(`Found existing valid credentials for ${credTest.username}`);
    const useExisting = await prompts.confirm('Use these credentials?', true);
    if (useExisting) {
      // Credentials work - ask for repo URL
      return await promptForManualRepoUrl(tuckDir, credTest.username);
    }
  } else if (credTest.username && credTest.reason) {
    // Had credentials but they failed
    const diagnosis = await diagnoseAuthIssue();
    prompts.log.warning(diagnosis.issue);
    for (const suggestion of diagnosis.suggestions) {
      console.log(c.muted(`  ${suggestion}`));
    }
    console.log();
  }

  // Check for existing SSH keys
  const sshInfo = await checkSSHKeys();
  const sshConnection = sshInfo.exists ? await testSSHConnection() : { success: false };

  // Build auth method options
  const authOptions: Array<{ value: string; label: string; hint: string }> = [];

  if (sshInfo.exists && sshConnection.success) {
    authOptions.push({
      value: 'ssh-existing',
      label: 'Use existing SSH key',
      hint: `Connected as ${sshConnection.username}`,
    });
  }

  authOptions.push(
    {
      value: 'gh-cli',
      label: 'Install GitHub CLI (recommended)',
      hint: 'Easiest option - automatic repo creation',
    },
    {
      value: 'ssh-new',
      label: 'Set up SSH key',
      hint: sshInfo.exists ? 'Configure existing key' : 'Generate new SSH key',
    },
    {
      value: 'fine-grained',
      label: 'Use Fine-grained Token',
      hint: 'More secure - limited permissions',
    },
    {
      value: 'classic',
      label: 'Use Classic Token',
      hint: 'Broader access - simpler setup',
    },
    {
      value: 'skip',
      label: 'Skip for now',
      hint: 'Set up authentication later',
    }
  );

  const authMethod = await prompts.select('Choose an authentication method:', authOptions);

  if (authMethod === 'skip') {
    return { remoteUrl: null, pushed: false };
  }

  if (authMethod === 'gh-cli') {
    // Show GitHub CLI install instructions
    console.log();
    prompts.note(getGitHubCLIInstallInstructions(), 'GitHub CLI Installation');
    console.log();
    prompts.log.info('After installing and authenticating, run `tuck init` again');
    prompts.log.info('Or continue with token-based authentication below');

    const continueWithToken = await prompts.confirm('Set up token authentication instead?', true);
    if (!continueWithToken) {
      return { remoteUrl: null, pushed: false };
    }
    // Fall through to token setup
    return await setupTokenAuth(tuckDir);
  }

  if (authMethod === 'ssh-existing') {
    // SSH key already works - just need repo URL
    prompts.log.success(`SSH authenticated as ${sshConnection.username}`);
    return await promptForManualRepoUrl(tuckDir, sshConnection.username, 'ssh');
  }

  if (authMethod === 'ssh-new') {
    // Show SSH setup instructions
    console.log();
    prompts.note(getSSHKeyInstructions(), 'SSH Key Setup');
    console.log();

    if (sshInfo.exists) {
      prompts.log.info(`Found existing SSH key at ${sshInfo.path}`);
      if (sshInfo.publicKey) {
        console.log();
        prompts.log.info('Your public key (copy this to GitHub):');
        console.log(c.brand(sshInfo.publicKey));
        console.log();
      }
    }

    const sshReady = await prompts.confirm('Have you added your SSH key to GitHub?');
    if (sshReady) {
      // Test connection
      const testSpinner = prompts.spinner();
      testSpinner.start('Testing SSH connection...');
      const testResult = await testSSHConnection();
      if (testResult.success) {
        testSpinner.stop(`SSH authenticated as ${testResult.username}`);
        return await promptForManualRepoUrl(tuckDir, testResult.username, 'ssh');
      } else {
        testSpinner.stop('SSH connection failed');
        prompts.log.warning('Could not connect to GitHub via SSH');
        prompts.log.info('Make sure you added the public key and try again');

        const useTokenInstead = await prompts.confirm('Use token authentication instead?', true);
        if (useTokenInstead) {
          return await setupTokenAuth(tuckDir);
        }
      }
    }
    return { remoteUrl: null, pushed: false };
  }

  if (authMethod === 'fine-grained' || authMethod === 'classic') {
    return await setupTokenAuth(
      tuckDir,
      authMethod === 'fine-grained' ? 'fine-grained' : 'classic'
    );
  }

  return { remoteUrl: null, pushed: false };
};

/**
 * Set up token-based authentication
 */
const setupTokenAuth = async (
  tuckDir: string,
  preferredType?: 'fine-grained' | 'classic'
): Promise<GitHubSetupResult> => {
  const tokenType =
    preferredType ??
    (await prompts.select('Which type of token?', [
      {
        value: 'fine-grained',
        label: 'Fine-grained Token (recommended)',
        hint: 'Limited permissions, more secure',
      },
      {
        value: 'classic',
        label: 'Classic Token',
        hint: 'Full repo access, simpler',
      },
    ]));

  // Show instructions for the selected token type
  console.log();
  if (tokenType === 'fine-grained') {
    prompts.note(getFineGrainedTokenInstructions(), 'Fine-grained Token Setup');
  } else {
    prompts.note(getClassicTokenInstructions(), 'Classic Token Setup');
  }
  console.log();

  // Ask for username
  const username = await prompts.text('Enter your GitHub username:', {
    validate: (value) => {
      if (!value) return 'Username is required';
      // GitHub username rules: 1-39 characters total, start with alphanumeric, may contain hyphens
      // (no consecutive or trailing hyphens).
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(value)) {
        return 'Invalid GitHub username (must start with a letter or number, be 1-39 characters, and may include hyphens but not consecutively or at the end).';
      }
      return undefined;
    },
  });

  // Ask for token
  const token = await prompts.password('Paste your token (hidden):');

  if (!token) {
    prompts.log.warning('No token provided');
    return { remoteUrl: null, pushed: false };
  }

  // Basic token format validation
  if (token.length < MIN_GITHUB_TOKEN_LENGTH) {
    prompts.log.error('Invalid token: Token appears too short');
    return { remoteUrl: null, pushed: false };
  }

  // Check if token starts with expected GitHub token prefixes
  const hasValidPrefix = GITHUB_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix));

  if (!hasValidPrefix) {
    const prefixList = GITHUB_TOKEN_PREFIXES.join(', ');
    prompts.log.warning(
      `Warning: Token does not start with a recognized GitHub prefix (${prefixList}). ` +
        'This may cause authentication to fail.'
    );

    const proceedWithUnrecognizedToken = await prompts.confirm(
      'The value you entered does not look like a typical GitHub personal access token. ' +
        'Are you sure this is a GitHub token and not, for example, a password or another secret?'
    );

    if (!proceedWithUnrecognizedToken) {
      prompts.log.error(
        'Aborting setup to avoid storing a value that may not be a GitHub token. ' +
          'Please generate a GitHub personal access token and try again.'
      );
      return { remoteUrl: null, pushed: false };
    }
  }

  // Auto-detect token type
  const detectedType = detectTokenType(token);
  const finalType =
    detectedType !== 'unknown' ? detectedType : (tokenType as 'fine-grained' | 'classic');

  if (detectedType !== 'unknown' && detectedType !== tokenType) {
    prompts.log.info(
      `Detected ${detectedType === 'fine-grained' ? 'fine-grained' : 'classic'} token`
    );
  }

  // Store credentials securely
  const storeSpinner = prompts.spinner();
  storeSpinner.start('Storing credentials securely...');

  try {
    await storeGitHubCredentials(username, token, finalType);
    storeSpinner.stop('Credentials stored');
    prompts.log.success('Authentication configured successfully');
  } catch (error) {
    storeSpinner.stop('Failed to store credentials');
    prompts.log.warning(
      `Could not store credentials: ${error instanceof Error ? error.message : String(error)}`
    );
    prompts.log.info('You may be prompted for credentials when pushing');
  }

  // Configure git credential helper (best-effort; Git can still prompt for credentials if this fails)
  await configureGitCredentialHelper().catch((error) => {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger?.debug?.(`Failed to configure git credential helper (non-fatal): ${errorMsg}`);
  });

  return await promptForManualRepoUrl(tuckDir, username, 'https');
};

/**
 * Prompt user for a repository URL and configure remote
 */
const promptForManualRepoUrl = async (
  tuckDir: string,
  username?: string,
  preferredProtocol: 'ssh' | 'https' = 'https'
): Promise<GitHubSetupResult> => {
  const suggestedName = 'dotfiles';
  const exampleUrl =
    preferredProtocol === 'ssh'
      ? `git@github.com:${username || 'username'}/${suggestedName}.git`
      : `https://github.com/${username || 'username'}/${suggestedName}.git`;

  console.log();
  prompts.note(
    `Create a repository on GitHub:\n\n` +
      `1. Go to: https://github.com/new\n` +
      `2. Name: ${suggestedName}\n` +
      `3. Visibility: Private (recommended)\n` +
      `4. Do NOT add README or .gitignore\n` +
      `5. Click "Create repository"\n` +
      `6. Copy the ${preferredProtocol.toUpperCase()} URL`,
    'Manual Repository Setup'
  );
  console.log();

  const hasRepo = await prompts.confirm('Have you created the repository?');
  if (!hasRepo) {
    prompts.log.info('Create a repository first, then run `tuck init` again');
    return { remoteUrl: null, pushed: false };
  }

  const repoUrl = await prompts.text('Paste the repository URL:', {
    placeholder: exampleUrl,
    validate: validateGitHubUrl,
  });

  // Add remote
  try {
    await addRemote(tuckDir, 'origin', repoUrl);
    prompts.log.success('Remote configured');
    return { remoteUrl: repoUrl, pushed: false };
  } catch (error) {
    prompts.log.error(
      `Failed to add remote: ${error instanceof Error ? error.message : String(error)}`
    );
    return { remoteUrl: null, pushed: false };
  }
};

const setupGitHubRepo = async (tuckDir: string): Promise<GitHubSetupResult> => {
  // Check if GitHub CLI is available
  const ghInstalled = await isGhInstalled();
  if (!ghInstalled) {
    // Offer alternative authentication methods
    return await setupAlternativeAuth(tuckDir);
  }

  const ghAuth = await isGhAuthenticated();
  if (!ghAuth) {
    prompts.log.info('GitHub CLI is installed but not authenticated');

    const authChoice = await prompts.select('How would you like to authenticate?', [
      {
        value: 'gh-login',
        label: 'Run `gh auth login` now',
        hint: 'Opens browser to authenticate',
      },
      {
        value: 'alternative',
        label: 'Use alternative method',
        hint: 'SSH key or personal access token',
      },
      {
        value: 'skip',
        label: 'Skip for now',
        hint: 'Set up authentication later',
      },
    ]);

    if (authChoice === 'skip') {
      return { remoteUrl: null, pushed: false };
    }

    if (authChoice === 'alternative') {
      return await setupAlternativeAuth(tuckDir);
    }

    // Run gh auth login
    prompts.log.info('Please complete the authentication in your browser...');
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('gh', ['auth', 'login', '--web']);

      // Re-check auth status
      if (!(await isGhAuthenticated())) {
        prompts.log.warning('Authentication may have failed');
        return await setupAlternativeAuth(tuckDir);
      }
    } catch (error) {
      prompts.log.warning(
        `Authentication failed: ${error instanceof Error ? error.message : String(error)}`
      );
      const useAlt = await prompts.confirm('Try alternative authentication?', true);
      if (useAlt) {
        return await setupAlternativeAuth(tuckDir);
      }
      return { remoteUrl: null, pushed: false };
    }
  }

  // Get authenticated user
  const user = await getAuthenticatedUser();
  prompts.log.success(`Detected GitHub account: ${user.login}`);

  // Ask if they want to auto-create repo
  const createGhRepo = await prompts.confirm('Create a GitHub repository automatically?', true);

  if (!createGhRepo) {
    return { remoteUrl: null, pushed: false };
  }

  // Ask for repo name
  const repoName = await prompts.text('Repository name:', {
    defaultValue: 'dotfiles',
    placeholder: 'dotfiles',
    validate: (value) => {
      if (!value) return 'Repository name is required';
      if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
        return 'Invalid repository name';
      }
      return undefined;
    },
  });

  // Ask for visibility
  const visibility = await prompts.select('Repository visibility:', [
    { value: 'private', label: 'Private (recommended)', hint: 'Only you can see it' },
    { value: 'public', label: 'Public', hint: 'Anyone can see it' },
  ]);

  // Create the repository
  let repo;
  try {
    const spinner = prompts.spinner();
    spinner.start(`Creating repository ${user.login}/${repoName}...`);

    repo = await createRepo({
      name: repoName,
      description: 'My dotfiles managed with tuck',
      isPrivate: visibility === 'private',
    });

    spinner.stop(`Repository created: ${repo.fullName}`);
  } catch (error) {
    prompts.log.error(
      `Failed to create repository: ${error instanceof Error ? error.message : String(error)}`
    );
    return { remoteUrl: null, pushed: false };
  }

  // Get the remote URL in preferred format
  const remoteUrl = await getPreferredRepoUrl(repo);

  // Add as remote
  await addRemote(tuckDir, 'origin', remoteUrl);
  prompts.log.success('Remote origin configured');

  // Ask to push initial commit
  const shouldPush = await prompts.confirm('Push initial commit to GitHub?', true);

  if (shouldPush) {
    try {
      const spinner = prompts.spinner();
      spinner.start('Creating initial commit...');

      await stageAll(tuckDir);
      await commit(tuckDir, 'Initial commit: tuck dotfiles setup');

      spinner.stop('Initial commit created');

      spinner.start('Pushing to GitHub...');
      await push(tuckDir, { remote: 'origin', branch: 'main', setUpstream: true });
      spinner.stop('Pushed to GitHub');

      prompts.note(
        `Your dotfiles are now at:\n${repo.url}\n\nOn a new machine, run:\ntuck apply ${user.login}`,
        'Success'
      );

      return { remoteUrl, pushed: true };
    } catch (error) {
      prompts.log.error(
        `Failed to push: ${error instanceof Error ? error.message : String(error)}`
      );
      return { remoteUrl, pushed: false };
    }
  }

  return { remoteUrl, pushed: false };
};

type RepositoryAnalysis =
  | { type: 'valid-tuck'; manifest: TuckManifest }
  | { type: 'plain-dotfiles'; files: DetectedFile[] }
  | { type: 'messed-up'; reason: string };

/**
 * Analyze a cloned repository to determine its state
 */
const analyzeRepository = async (repoDir: string): Promise<RepositoryAnalysis> => {
  const manifestPath = join(repoDir, '.tuckmanifest.json');

  // Check for valid tuck manifest
  if (await pathExists(manifestPath)) {
    try {
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as TuckManifest;

      // Validate manifest has files
      if (manifest.files && Object.keys(manifest.files).length > 0) {
        return { type: 'valid-tuck', manifest };
      }

      // Manifest exists but is empty
      return { type: 'messed-up', reason: 'Manifest exists but contains no tracked files' };
    } catch {
      return { type: 'messed-up', reason: 'Manifest file is corrupted or invalid' };
    }
  }

  // No manifest - check for common dotfiles in the files directory or root
  const filesDir = join(repoDir, 'files');
  const hasFilesDir = await pathExists(filesDir);

  // Look for common dotfile patterns in the repo
  const commonPatterns = [
    '.zshrc',
    '.bashrc',
    '.bash_profile',
    '.gitconfig',
    '.vimrc',
    '.tmux.conf',
    '.profile',
    'zshrc',
    'bashrc',
    'gitconfig',
    'vimrc',
  ];

  const foundFiles: string[] = [];

  // Check in files directory if it exists
  if (hasFilesDir) {
    const { readdir } = await import('fs/promises');
    try {
      const categories = await readdir(filesDir);
      for (const category of categories) {
        const categoryPath = join(filesDir, category);
        const categoryStats = await import('fs/promises').then((fs) =>
          fs.stat(categoryPath).catch((e) => {
            logger.debug?.(errorToMessage(e, `Failed to stat category path ${categoryPath}`));
            return null;
          })
        );
        if (categoryStats?.isDirectory()) {
          const files = await readdir(categoryPath);
          foundFiles.push(...files);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // Check root directory
  const { readdir } = await import('fs/promises');
  try {
    const rootFiles = await readdir(repoDir);
    for (const file of rootFiles) {
      if (commonPatterns.some((p) => file.includes(p) || file.startsWith('.'))) {
        foundFiles.push(file);
      }
    }
  } catch {
    // Ignore errors
  }

  // Filter to meaningful dotfiles (not just .git, README, etc.)
  const meaningfulFiles = foundFiles.filter(
    (f) => !['README.md', 'README', '.git', '.gitignore', 'LICENSE', '.tuckrc.json'].includes(f)
  );

  if (meaningfulFiles.length > 0) {
    // Run detection on user's system and show what would be tracked
    const detectedOnSystem = await detectDotfiles();
    return { type: 'plain-dotfiles', files: detectedOnSystem };
  }

  // Check if repo is essentially empty (only has README, .git, etc.)
  const { readdir: rd } = await import('fs/promises');
  try {
    const allFiles = await rd(repoDir);
    const nonEssentialFiles = allFiles.filter(
      (f) => !['.git', 'README.md', 'README', 'LICENSE', '.gitignore'].includes(f)
    );
    if (nonEssentialFiles.length === 0) {
      return { type: 'messed-up', reason: 'Repository is empty (only contains README or license)' };
    }
  } catch {
    // Ignore
  }

  return { type: 'messed-up', reason: 'Repository does not contain recognizable dotfiles' };
};

interface ImportResult {
  success: boolean;
  filesInRepo: number; // Files imported to ~/.tuck
  filesApplied: number; // Files applied to system (0 if user declined)
  remoteUrl?: string;
}

/**
 * Import an existing GitHub dotfiles repository
 */
const importExistingRepo = async (
  tuckDir: string,
  repoName: string,
  analysis: RepositoryAnalysis,
  repoDir: string
): Promise<ImportResult> => {
  const { getPreferredRemoteProtocol } = await import('../lib/github.js');
  const protocol = await getPreferredRemoteProtocol();
  const remoteUrl =
    protocol === 'ssh' ? `git@github.com:${repoName}.git` : `https://github.com/${repoName}.git`;

  if (analysis.type === 'valid-tuck') {
    // Scenario A: Valid tuck repository - import only (NO auto-apply)
    // BREAKING CHANGE: Files are no longer automatically applied when cloning a tuck repository.
    // This is a safer default that prevents accidental overwrites of existing configurations.
    // User should run 'tuck apply' or 'tuck restore' manually when ready.
    prompts.log.step('Importing tuck repository...');

    // Copy the entire repo to tuck directory
    const spinner = prompts.spinner();
    spinner.start('Copying repository...');

    // Copy files from cloned repo to tuck directory
    await copy(repoDir, tuckDir, { overwrite: true });

    spinner.stop('Repository imported');

    // Get file count and group by category for display
    const fileCount = Object.keys(analysis.manifest.files).length;

    // Group files by category
    const grouped: Record<string, string[]> = {};
    for (const [_id, file] of Object.entries(analysis.manifest.files)) {
      if (!grouped[file.category]) grouped[file.category] = [];
      grouped[file.category].push(file.source);
    }

    // Display what's available
    console.log();
    prompts.log.success(`Imported ${fileCount} dotfiles to ~/.tuck`);
    console.log();

    // Show files by category with icons
    const { DETECTION_CATEGORIES } = await import('../lib/detect.js');
    for (const [category, files] of Object.entries(grouped)) {
      const categoryInfo = DETECTION_CATEGORIES[category] || { icon: '-', name: category };
      console.log(
        c.brand(
          `  ${categoryInfo.icon} ${categoryInfo.name}: ${files.length} file${files.length > 1 ? 's' : ''}`
        )
      );
    }

    console.log();
    prompts.note(
      'Your dotfiles are now in ~/.tuck but NOT applied to your system.\n\n' +
        'To apply them to your system, run:\n' +
        '  tuck apply    # Interactive with merge options\n' +
        '  tuck restore  # Simple restore from backup\n\n' +
        'To see what files are available:\n' +
        '  tuck list',
      'Next Steps'
    );

    // filesApplied is always 0 - user must explicitly apply via tuck apply/restore
    return { success: true, filesInRepo: fileCount, filesApplied: 0, remoteUrl };
  }

  if (analysis.type === 'plain-dotfiles') {
    // Scenario B: Plain dotfiles repository - copy contents and initialize tuck
    prompts.log.step('Repository contains dotfiles but no tuck manifest');
    prompts.log.info('Importing repository and setting up tuck...');

    // Copy the repository contents to tuck directory first (preserving existing files)
    const copySpinner = prompts.spinner();
    copySpinner.start('Copying repository contents...');
    await copy(repoDir, tuckDir, { overwrite: true });
    copySpinner.stop('Repository contents copied');

    // Now initialize git and create tuck config on top of the copied files
    // Note: The .git directory was copied, so we don't need to reinitialize
    await setDefaultBranch(tuckDir, 'main');

    const hostname = (await import('os')).hostname();
    await createManifest(tuckDir, hostname);
    await saveConfig(
      {
        ...defaultConfig,
        repository: { ...defaultConfig.repository, path: tuckDir },
      },
      tuckDir
    );

    // Create directory structure for categories (if not already present)
    await createDirectoryStructure(tuckDir);
    await createDefaultFiles(tuckDir, hostname);

    // Update remote to use the correct URL (may differ from cloned URL)
    try {
      // Remove existing origin if present and add the correct one
      const { removeRemote } = await import('../lib/git.js');
      await removeRemote(tuckDir, 'origin').catch((e) => {
        logger.debug?.(errorToMessage(e, 'Remote origin does not exist (expected)'));
      });
      await addRemote(tuckDir, 'origin', remoteUrl);
    } catch {
      // If removing fails, try adding anyway
      await addRemote(tuckDir, 'origin', remoteUrl).catch((e) => {
        logger.debug?.(errorToMessage(e, 'Remote origin already exists (expected)'));
      });
    }

    // Detect dotfiles on system that could be tracked
    const detected = analysis.files.filter((f) => !f.sensitive);

    console.log();
    prompts.log.success('Repository imported to ~/.tuck');
    prompts.log.info("The repository's files are now in your tuck directory.");

    if (detected.length > 0) {
      console.log();
      prompts.log.info(`Found ${detected.length} dotfiles on your system that could be tracked`);

      const trackNow = await prompts.confirm('Would you like to add some of these to tuck?', true);

      if (trackNow) {
        // Group by category for display
        const grouped: Record<string, DetectedFile[]> = {};
        for (const file of detected) {
          if (!grouped[file.category]) grouped[file.category] = [];
          grouped[file.category].push(file);
        }

        // Show categories
        console.log();
        for (const [category, files] of Object.entries(grouped)) {
          const config = DETECTION_CATEGORIES[category] || { icon: '-', name: category };
          console.log(`  ${config.icon} ${config.name}: ${files.length} files`);
        }

        console.log();
        prompts.log.info("Run 'tuck scan' to interactively select files to track");
        prompts.log.info("Or run 'tuck add <path>' to add specific files");
      }
    }

    // Count the files that were copied (excluding .git and tuck config files)
    let importedCount = 0;
    const { readdir, stat } = await import('fs/promises');
    try {
      const countFiles = async (dir: string): Promise<number> => {
        let count = 0;
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (entry === '.git' || entry === '.tuckmanifest.json' || entry === '.tuckrc.json')
            continue;
          const fullPath = join(dir, entry);
          const stats = await stat(fullPath).catch((e) => {
            logger.debug?.(errorToMessage(e, `Failed to stat ${fullPath}`));
            return null;
          });
          if (stats?.isDirectory()) {
            count += await countFiles(fullPath);
          } else if (stats?.isFile()) {
            count++;
          }
        }
        return count;
      };
      importedCount = await countFiles(tuckDir);
    } catch {
      // Ignore counting errors
    }

    // For plain-dotfiles, importedCount represents files copied to ~/.tuck
    // No files are applied to system in this flow (user needs to add them manually)
    return { success: true, filesInRepo: importedCount, filesApplied: 0, remoteUrl };
  }

  // Scenario C: Messed up repository
  prompts.log.warning(`Repository issue: ${analysis.reason}`);
  console.log();

  const action = await prompts.select('How would you like to proceed?', [
    {
      value: 'fresh',
      label: 'Start fresh',
      hint: 'Initialize tuck and set this repo as remote (will overwrite on push)',
    },
    {
      value: 'remote-only',
      label: 'Set as remote only',
      hint: 'Initialize tuck locally, keep existing repo contents',
    },
    {
      value: 'cancel',
      label: 'Cancel',
      hint: 'Inspect the repository manually first',
    },
  ]);

  if (action === 'cancel') {
    return { success: false, filesInRepo: 0, filesApplied: 0 };
  }

  // Initialize tuck
  await createDirectoryStructure(tuckDir);
  await initRepo(tuckDir);
  await setDefaultBranch(tuckDir, 'main');

  const hostname = (await import('os')).hostname();
  await createManifest(tuckDir, hostname);
  await saveConfig(
    {
      ...defaultConfig,
      repository: { ...defaultConfig.repository, path: tuckDir },
    },
    tuckDir
  );
  await createDefaultFiles(tuckDir, hostname);

  // Set up remote
  await addRemote(tuckDir, 'origin', remoteUrl);

  if (action === 'fresh') {
    prompts.log.info('Tuck initialized. When you push, it will replace the repository contents.');
    prompts.log.info(
      "Run 'tuck add' to track files, then 'tuck sync && tuck push --force' to update remote"
    );
  } else {
    prompts.log.info('Tuck initialized with remote configured');
    prompts.log.info("Run 'tuck add' to start tracking files");
  }

  // For messed-up repos, no files are imported or applied
  return { success: true, filesInRepo: 0, filesApplied: 0, remoteUrl };
};

const initFromRemote = async (tuckDir: string, remoteUrl: string): Promise<void> => {
  // Clone the repository
  await withSpinner(`Cloning from ${remoteUrl}...`, async () => {
    await cloneRepo(remoteUrl, tuckDir);
  });

  // Verify manifest exists
  if (!(await pathExists(getManifestPath(tuckDir)))) {
    logger.warning('No manifest found in cloned repository. Creating new manifest...');
    const hostname = (await import('os')).hostname();
    await createManifest(tuckDir, hostname);
  }

  // Verify config exists
  if (!(await pathExists(getConfigPath(tuckDir)))) {
    logger.warning('No config found in cloned repository. Creating default config...');
    await saveConfig(
      {
        ...defaultConfig,
        repository: { ...defaultConfig.repository, path: tuckDir },
      },
      tuckDir
    );
  }
};

const runInteractiveInit = async (): Promise<void> => {
  banner();
  prompts.intro('tuck init');

  // Ask for tuck directory
  const dirInput = await prompts.text('Where should tuck store your dotfiles?', {
    defaultValue: '~/.tuck',
  });
  const tuckDir = getTuckDir(dirInput);

  // Check if already initialized
  if (await pathExists(getManifestPath(tuckDir))) {
    prompts.log.error(`Tuck is already initialized at ${collapsePath(tuckDir)}`);
    prompts.outro('Use `tuck status` to see current state');
    return;
  }

  // ========== STEP 0: Provider Selection ==========
  console.log();
  let providerResult: ProviderSetupResult | null = null;

  // Run provider selection and setup
  providerResult = await setupProvider();

  if (!providerResult) {
    // User cancelled provider selection - use local mode
    providerResult = {
      success: true,
      mode: 'local',
      config: buildRemoteConfig('local'),
      provider: getProvider('local'),
    };
  }

  // Display the chosen provider
  console.log();
  prompts.log.info(`Provider: ${describeProviderConfig(providerResult.config)}`);

  // Flow control flags
  let skipExistingRepoQuestion = false;
  let remoteUrl: string | null = providerResult.remoteUrl || null;
  let existingRepoToUseAsRemote: string | null = null;

  // Auto-detect existing dotfiles repository (only for GitHub/GitLab providers)
  const canSearchForRepos = providerResult.mode === 'github' || providerResult.mode === 'gitlab';
  const ghInstalled = await isGhInstalled();
  const ghAuth =
    canSearchForRepos &&
    providerResult.mode === 'github' &&
    ghInstalled &&
    (await isGhAuthenticated());

  if (ghAuth) {
    const spinner = prompts.spinner();
    spinner.start('Checking for existing dotfiles repository on GitHub...');

    try {
      const user = await getAuthenticatedUser();
      const existingRepoName = await findDotfilesRepo(user.login);

      if (existingRepoName) {
        spinner.stop(`Found repository: ${existingRepoName}`);

        const importRepo = await prompts.confirm(`Import dotfiles from ${existingRepoName}?`, true);

        if (importRepo) {
          // Clone to temp directory
          const tempDir = join(tmpdir(), `tuck-import-${Date.now()}`);
          const cloneSpinner = prompts.spinner();
          cloneSpinner.start('Cloning repository...');
          let phase: 'cloning' | 'analyzing' | 'importing' = 'cloning';

          try {
            await ghCloneRepo(existingRepoName, tempDir);
            cloneSpinner.stop('Repository cloned');
            phase = 'analyzing';

            // Analyze the repository
            const analysisSpinner = prompts.spinner();
            analysisSpinner.start('Analyzing repository...');
            let analysis: RepositoryAnalysis;
            try {
              analysis = await analyzeRepository(tempDir);
              analysisSpinner.stop('Analysis complete');
            } catch (error) {
              analysisSpinner.stop('Analysis failed');
              throw new Error(
                `Failed to analyze repository: ${error instanceof Error ? error.message : String(error)}`
              );
            }

            phase = 'importing';
            // Import based on analysis
            const result = await importExistingRepo(tuckDir, existingRepoName, analysis, tempDir);

            if (result.success) {
              console.log();
              // Always show that repository was imported to ~/.tuck
              if (result.filesInRepo > 0) {
                prompts.log.success(`Repository imported to ~/.tuck (${result.filesInRepo} files)`);
                if (result.filesApplied > 0) {
                  prompts.log.info(`Applied ${result.filesApplied} files to your system`);
                } else if (result.filesInRepo > 0) {
                  prompts.log.info(
                    'Files are ready in ~/.tuck. Run "tuck restore" to apply them to your system'
                  );
                }
              } else {
                prompts.log.success(`Tuck initialized with ${existingRepoName} as remote`);
              }

              prompts.outro('Ready to manage your dotfiles!');

              nextSteps([
                `View status: tuck status`,
                `Add files:   tuck add ~/.zshrc`,
                `Sync:        tuck sync`,
              ]);
              return;
            }

            // User cancelled - continue with normal flow
            console.log();
          } catch (error) {
            // Only stop clone spinner if we're still in cloning phase
            if (phase === 'cloning') {
              cloneSpinner.stop('Clone failed');
            }

            // Provide accurate error messages based on which phase failed
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (phase === 'analyzing') {
              prompts.log.warning(errorMessage);
            } else if (phase === 'importing') {
              prompts.log.warning(errorMessage);
            } else {
              prompts.log.warning(`Could not clone repository: ${errorMessage}`);
            }
            console.log();

            // Offer to use the failed repo as remote and continue with fresh init
            const useAsRemoteAnyway = await prompts.confirm(
              `Use ${existingRepoName} as your remote and start fresh?`,
              true
            );

            if (useAsRemoteAnyway) {
              existingRepoToUseAsRemote = existingRepoName;
              skipExistingRepoQuestion = true;
            }
          } finally {
            // Always clean up temp directory if it exists
            if (await pathExists(tempDir)) {
              try {
                await rm(tempDir, { recursive: true, force: true });
              } catch (cleanupError) {
                // Log but don't throw - cleanup failure shouldn't break the flow
                prompts.log.warning(
                  `Failed to clean up temporary directory: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
                );
              }
            }
          }
        } else {
          // User declined to import - offer to use as remote only
          console.log();
          const useAsRemote = await prompts.confirm(
            `Use ${existingRepoName} as your remote (without importing its contents)?`,
            true
          );

          if (useAsRemote) {
            existingRepoToUseAsRemote = existingRepoName;
          }
          skipExistingRepoQuestion = true;
        }
      } else {
        spinner.stop('No existing dotfiles repository found');
      }
    } catch {
      spinner.stop('Could not check for existing repositories');
    }
  }

  // Ask about existing repo (manual flow) - skip if we already handled it
  if (!skipExistingRepoQuestion) {
    const hasExisting = await prompts.select('Do you have an existing dotfiles repository?', [
      { value: 'no', label: 'No, start fresh' },
      { value: 'yes', label: 'Yes, clone from URL' },
    ]);

    if (hasExisting === 'yes') {
      const repoUrl = await prompts.text('Enter repository URL:', {
        placeholder: 'git@host:user/dotfiles.git or https://host/user/dotfiles.git',
        validate: validateGitUrl,
      });

      await initFromRemote(tuckDir, repoUrl);

      prompts.log.success('Repository cloned successfully!');

      const shouldRestore = await prompts.confirm('Would you like to restore dotfiles now?', true);

      if (shouldRestore) {
        console.log();
        // Dynamically import and run restore
        const { runRestore } = await import('./restore.js');
        await runRestore({ all: true });
      }

      prompts.outro('Tuck initialized successfully!');
      nextSteps([
        `View status: tuck status`,
        `Add files:   tuck add ~/.zshrc`,
        `Sync:        tuck sync`,
      ]);
      return;
    }
  }

  // Initialize from scratch with provider config
  await initFromScratch(tuckDir, { remoteConfig: providerResult.config });

  // If we have an existing repo to use as remote, set it up now
  if (existingRepoToUseAsRemote) {
    const protocol = await getPreferredRemoteProtocol();
    remoteUrl =
      protocol === 'ssh'
        ? `git@github.com:${existingRepoToUseAsRemote}.git`
        : `https://github.com/${existingRepoToUseAsRemote}.git`;

    await addRemote(tuckDir, 'origin', remoteUrl);
    prompts.log.success(`Remote set to ${existingRepoToUseAsRemote}`);
    prompts.log.info('Your next push will update the remote repository');
    console.log();
  }

  // ========== STEP 1: Remote Setup (if not already configured and not local mode) ==========
  // Skip remote setup if we already have a URL or if we're in local mode
  if (!remoteUrl && providerResult.mode !== 'local') {
    const wantsRemote = await prompts.confirm(
      'Would you like to set up a remote repository?',
      true
    );

    if (wantsRemote) {
      // Try GitHub auto-setup
      const ghResult = await setupGitHubRepo(tuckDir);
      remoteUrl = ghResult.remoteUrl;

      // If GitHub setup didn't add a remote, show manual instructions
      if (!ghResult.remoteUrl) {
        // Get user info for examples
        const user = await getAuthenticatedUser().catch((e) => {
          logger.debug?.(errorToMessage(e, 'Could not get authenticated user'));
          return null;
        });
        const suggestedName = 'dotfiles';

        console.log();
        prompts.note(
          `To create a GitHub repository manually:\n\n` +
            `1. Go to: https://github.com/new\n` +
            `2. Repository name: ${suggestedName}\n` +
            `3. Description: My dotfiles managed with tuck\n` +
            `4. Visibility: Private (recommended)\n` +
            `5. IMPORTANT: Do NOT initialize with:\n` +
            `   - NO README\n` +
            `   - NO .gitignore\n` +
            `   - NO license\n` +
            `6. Click "Create repository"\n` +
            `7. Copy the URL shown\n\n` +
            `Example URLs:\n` +
            `  SSH:   git@github.com:${user?.login || 'username'}/${suggestedName}.git\n` +
            `  HTTPS: https://github.com/${user?.login || 'username'}/${suggestedName}.git`,
          'Manual Repository Setup'
        );
        console.log();

        const useManual = await prompts.confirm('Did you create a GitHub repository?', true);

        if (useManual) {
          const manualUrl = await prompts.text('Paste your GitHub repository URL:', {
            placeholder: `git@github.com:${user?.login || 'user'}/${suggestedName}.git`,
            validate: validateGitHubUrl,
          });

          if (manualUrl) {
            await addRemote(tuckDir, 'origin', manualUrl);
            prompts.log.success('Remote added successfully');
            remoteUrl = manualUrl;
          }
        }
      }
    }
  }

  // ========== STEP 2: Detect and Select Files ==========
  const scanSpinner = prompts.spinner();
  scanSpinner.start('Scanning for dotfiles...');
  const detectedFiles = await detectDotfiles();
  const nonSensitiveFiles = detectedFiles.filter((f) => !f.sensitive);
  const sensitiveFiles = detectedFiles.filter((f) => f.sensitive);
  scanSpinner.stop(`Found ${detectedFiles.length} dotfiles on your system`);

  let trackedCount = 0;

  // Handle non-sensitive files
  if (nonSensitiveFiles.length > 0) {
    // Group by category and show summary
    const grouped: Record<string, DetectedFile[]> = {};
    for (const file of nonSensitiveFiles) {
      if (!grouped[file.category]) grouped[file.category] = [];
      grouped[file.category].push(file);
    }

    console.log();
    const categoryOrder = ['shell', 'git', 'editors', 'terminal', 'ssh', 'misc'];
    const sortedCategories = Object.keys(grouped).sort((a, b) => {
      const aIdx = categoryOrder.indexOf(a);
      const bIdx = categoryOrder.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });

    for (const category of sortedCategories) {
      const files = grouped[category];
      const config = DETECTION_CATEGORIES[category] || { icon: '-', name: category };
      console.log(`  ${config.icon} ${config.name}: ${files.length} files`);
    }
    console.log();

    const trackNow = await prompts.confirm('Would you like to track some of these now?', true);

    if (trackNow) {
      // Show multiselect with all files PRE-SELECTED by default
      const options = nonSensitiveFiles.map((f) => ({
        value: f.path,
        label: `${collapsePath(f.path)}`,
        hint: f.category,
      }));

      // Pre-select all non-sensitive files
      const initialValues = nonSensitiveFiles.map((f) => f.path);

      const selectedFiles = await prompts.multiselect(
        'Select files to track (all pre-selected; use space to toggle selection):',
        options,
        { initialValues }
      );

      // Handle sensitive files with individual prompts
      const filesToTrack = [...selectedFiles];

      if (sensitiveFiles.length > 0) {
        console.log();
        prompts.log.warning(`Found ${sensitiveFiles.length} sensitive file(s):`);

        for (const sf of sensitiveFiles) {
          console.log(c.warning(`  ! ${collapsePath(sf.path)} - ${sf.description || sf.category}`));
        }

        console.log();
        const trackSensitive = await prompts.confirm(
          'Would you like to review sensitive files? (Ensure your repo is PRIVATE)',
          false
        );

        if (trackSensitive) {
          for (const sf of sensitiveFiles) {
            const track = await prompts.confirm(`Track ${collapsePath(sf.path)}?`, false);
            if (track) {
              filesToTrack.push(sf.path);
            }
          }
        }
      }

      if (filesToTrack.length > 0) {
        // Track files with beautiful progress display
        trackedCount = await trackFilesWithProgressInit(filesToTrack, tuckDir);
      }
    } else {
      prompts.log.info("Run 'tuck scan' later to interactively add files");
    }
  }

  // Handle case where only sensitive files were found
  if (nonSensitiveFiles.length === 0 && sensitiveFiles.length > 0) {
    console.log();
    prompts.log.warning(`Found ${sensitiveFiles.length} sensitive file(s):`);

    for (const sf of sensitiveFiles) {
      console.log(c.warning(`  ! ${collapsePath(sf.path)} - ${sf.description || sf.category}`));
    }

    console.log();
    const trackSensitive = await prompts.confirm(
      'Would you like to review these sensitive files? (Ensure your repo is PRIVATE)',
      false
    );

    if (trackSensitive) {
      const filesToTrack: string[] = [];
      for (const sf of sensitiveFiles) {
        const track = await prompts.confirm(`Track ${collapsePath(sf.path)}?`, false);
        if (track) {
          filesToTrack.push(sf.path);
        }
      }

      if (filesToTrack.length > 0) {
        // Track files with beautiful progress display
        trackedCount = await trackFilesWithProgressInit(filesToTrack, tuckDir);
      }
    } else {
      prompts.log.info("Run 'tuck scan' later to interactively add files");
    }
  }

  // Handle case where no files were found
  if (detectedFiles.length === 0) {
    console.log();
    prompts.log.info('No dotfiles detected on your system');
    prompts.log.info("Run 'tuck add <path>' to manually track files");
  }

  // ========== STEP 3: Commit and Push ==========
  if (trackedCount > 0) {
    console.log();

    if (remoteUrl) {
      // Remote is configured - offer to commit AND push
      const action = await prompts.select('Your files are tracked. What would you like to do?', [
        {
          value: 'commit-push',
          label: 'Commit and push to remote',
          hint: 'Recommended - sync your dotfiles now',
        },
        {
          value: 'commit-only',
          label: 'Commit only',
          hint: "Save locally, push later with 'tuck push'",
        },
        {
          value: 'skip',
          label: 'Skip for now',
          hint: "Run 'tuck sync' later",
        },
      ]);

      if (action !== 'skip') {
        const commitSpinner = prompts.spinner();
        commitSpinner.start('Committing changes...');

        await stageAll(tuckDir);
        const commitHash = await commit(tuckDir, `Add ${trackedCount} dotfiles via tuck init`);

        commitSpinner.stop(`Committed: ${commitHash.slice(0, 7)}`);

        if (action === 'commit-push') {
          const pushSpinner = prompts.spinner();
          pushSpinner.start('Pushing to remote...');

          try {
            await push(tuckDir, { remote: 'origin', branch: 'main', setUpstream: true });
            pushSpinner.stop('Pushed successfully!');

            // Show success with URL
            let viewUrl = remoteUrl;
            if (viewUrl.startsWith('git@github.com:')) {
              viewUrl = viewUrl
                .replace('git@github.com:', 'https://github.com/')
                .replace('.git', '');
            } else if (viewUrl.startsWith('https://github.com/')) {
              viewUrl = viewUrl.replace('.git', '');
            }

            console.log();
            prompts.note(
              `Your dotfiles are now live at:\n${viewUrl}\n\n` +
                `On a new machine, run:\n  tuck init --from ${viewUrl}`,
              'Success!'
            );
          } catch (error) {
            pushSpinner.stop('Push failed');
            const errorMsg = error instanceof Error ? error.message : String(error);
            prompts.log.warning(`Could not push: ${errorMsg}`);
            prompts.log.info("Run 'tuck push' to try again");
          }
        } else {
          prompts.log.info("Run 'tuck push' when you're ready to upload to remote");
        }
      }
    } else {
      // No remote configured
      const shouldCommit = await prompts.confirm('Commit these changes locally?', true);

      if (shouldCommit) {
        const commitSpinner = prompts.spinner();
        commitSpinner.start('Committing...');

        await stageAll(tuckDir);
        const commitHash = await commit(tuckDir, `Add ${trackedCount} dotfiles via tuck init`);

        commitSpinner.stop(`Committed: ${commitHash.slice(0, 7)}`);
        prompts.log.info("Set up a remote with 'tuck push' to backup your dotfiles");
      }
    }
  }

  prompts.outro('Tuck initialized successfully!');

  nextSteps([
    `View status: tuck status`,
    `Add files:   tuck add ~/.zshrc`,
    `Sync:        tuck sync`,
  ]);
};

const runInit = async (options: InitOptions): Promise<void> => {
  const tuckDir = getTuckDir(options.dir);

  // If --from is provided, clone from remote
  if (options.from) {
    await initFromRemote(tuckDir, options.from);
    logger.success(`Tuck initialized from ${options.from}`);
    logger.info('Run `tuck restore --all` to restore dotfiles');
    return;
  }

  // Initialize from scratch
  // If remote URL is provided, detect provider from URL
  const detectedConfig = options.remote
    ? buildRemoteConfig(detectProviderFromUrl(options.remote), { url: options.remote })
    : buildRemoteConfig('local');

  await initFromScratch(tuckDir, {
    remote: options.remote,
    bare: options.bare,
    remoteConfig: detectedConfig,
  });

  logger.success(`Tuck initialized at ${collapsePath(tuckDir)}`);

  nextSteps([
    `Add files:    tuck add ~/.zshrc`,
    `Sync changes: tuck sync`,
    `Push remote:  tuck push`,
  ]);
};

export const initCommand = new Command('init')
  .description('Initialize tuck repository')
  .option('-d, --dir <path>', 'Directory for tuck repository', '~/.tuck')
  .option('-r, --remote <url>', 'Git remote URL to set up')
  .option('--bare', 'Initialize without any default files')
  .option('--from <url>', 'Clone from existing tuck repository')
  .action(async (options: InitOptions) => {
    // If no options provided, run interactive mode
    if (!options.remote && !options.bare && !options.from && options.dir === '~/.tuck') {
      await runInteractiveInit();
    } else {
      await runInit(options);
    }
  });
