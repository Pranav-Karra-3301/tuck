import { Command } from 'commander';
import { join, resolve, sep, dirname } from 'path';
import { writeFile } from 'fs/promises';
import { ensureDir } from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { banner, nextSteps, prompts, withSpinner, logger } from '../ui/index.js';
import {
  getTuckDir,
  getManifestPath,
  getConfigPath,
  getFilesDir,
  getCategoryDir,
  pathExists,
  expandPath,
  collapsePath,
  validateSafeSourcePath,
} from '../lib/paths.js';
import { saveConfig } from '../lib/config.js';
import { createManifest } from '../lib/manifest.js';
import type { TuckManifest } from '../types.js';
import { initRepo, addRemote, cloneRepo, setDefaultBranch, stageAll, commit, push } from '../lib/git.js';
import {
  isGhInstalled,
  isGhAuthenticated,
  getAuthenticatedUser,
  createRepo,
  getPreferredRepoUrl,
  findDotfilesRepo,
  ghCloneRepo,
} from '../lib/github.js';
import { detectDotfiles, DetectedFile, DETECTION_CATEGORIES } from '../lib/detect.js';
import { createPreApplySnapshot } from '../lib/timemachine.js';
import { copy } from 'fs-extra';
import { tmpdir } from 'os';
import { readFile, rm } from 'fs/promises';
import { AlreadyInitializedError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import { defaultConfig } from '../schemas/config.schema.js';
import type { InitOptions } from '../types.js';

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
const trackFilesWithProgress = async (
  selectedPaths: string[],
  tuckDir: string
): Promise<number> => {
  const { addFileToManifest } = await import('../lib/manifest.js');
  const { copyFileOrDir, getFileChecksum, getFileInfo } = await import('../lib/files.js');
  const { loadConfig } = await import('../lib/config.js');
  const {
    expandPath,
    getDestinationPath,
    getRelativeDestination,
    generateFileId,
    sanitizeFilename,
    detectCategory,
  } = await import('../lib/paths.js');
  const { CATEGORIES } = await import('../constants.js');

  const config = await loadConfig(tuckDir);
  const strategy = config.files.strategy || 'copy';
  const total = selectedPaths.length;

  console.log();
  console.log(chalk.bold.cyan(`Tracking ${total} ${total === 1 ? 'file' : 'files'}...`));
  console.log(chalk.dim('─'.repeat(50)));
  console.log();

  let successCount = 0;

  for (let i = 0; i < selectedPaths.length; i++) {
    const filePath = selectedPaths[i];
    const expandedPath = expandPath(filePath);
    const indexStr = chalk.dim(`[${i + 1}/${total}]`);
    const category = detectCategory(expandedPath);
    const filename = sanitizeFilename(expandedPath);
    const categoryInfo = CATEGORIES[category];
    const icon = categoryInfo?.icon || '○';

    // Show spinner while processing
    const spinner = ora({
      text: `${indexStr} Tracking ${chalk.cyan(collapsePath(filePath))}`,
      color: 'cyan',
      spinner: 'dots',
      indent: 2,
    }).start();

    try {
      // Get destination path
      const destination = getDestinationPath(tuckDir, category, filename);

      // Ensure category directory exists
      await ensureDir(dirname(destination));

      // Copy file
      await copyFileOrDir(expandedPath, destination, { overwrite: true });

      // Get file info
      const checksum = await getFileChecksum(destination);
      const info = await getFileInfo(expandedPath);
      const now = new Date().toISOString();

      // Generate unique ID
      const id = generateFileId(filePath);

      // Add to manifest
      await addFileToManifest(tuckDir, id, {
        source: collapsePath(filePath),
        destination: getRelativeDestination(category, filename),
        category,
        strategy,
        encrypted: false,
        template: false,
        permissions: info.permissions,
        added: now,
        modified: now,
        checksum,
      });

      spinner.stop();
      const categoryStr = chalk.dim(` ${icon} ${category}`);
      console.log(`  ${chalk.green('✓')} ${indexStr} ${collapsePath(filePath)}${categoryStr}`);

      successCount++;

      // Small delay for visual effect
      if (i < selectedPaths.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    } catch (error) {
      spinner.stop();
      console.log(`  ${chalk.red('✗')} ${indexStr} ${collapsePath(filePath)} ${chalk.red('- failed')}`);
    }
  }

  // Summary
  console.log();
  console.log(
    chalk.green('✓'),
    chalk.bold(`Tracked ${successCount} ${successCount === 1 ? 'file' : 'files'} successfully`)
  );

  return successCount;
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
  options: { remote?: string; bare?: boolean }
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

  // Create config
  await withSpinner('Creating configuration...', async () => {
    await saveConfig(
      {
        ...defaultConfig,
        repository: { ...defaultConfig.repository, path: tuckDir },
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

const setupGitHubRepo = async (tuckDir: string): Promise<GitHubSetupResult> => {
  // Check if GitHub CLI is available
  const ghInstalled = await isGhInstalled();
  if (!ghInstalled) {
    prompts.log.info('GitHub CLI (gh) is not installed');
    prompts.log.info('Install it from https://cli.github.com/ for auto-setup');
    return { remoteUrl: null, pushed: false };
  }

  const ghAuth = await isGhAuthenticated();
  if (!ghAuth) {
    prompts.log.info('GitHub CLI is not authenticated');
    prompts.log.info('Run `gh auth login` to enable auto-setup');
    return { remoteUrl: null, pushed: false };
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
    prompts.log.error(`Failed to create repository: ${error instanceof Error ? error.message : String(error)}`);
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
      prompts.log.error(`Failed to push: ${error instanceof Error ? error.message : String(error)}`);
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
    '.zshrc', '.bashrc', '.bash_profile', '.gitconfig', '.vimrc',
    '.tmux.conf', '.profile', 'zshrc', 'bashrc', 'gitconfig', 'vimrc',
  ];

  const foundFiles: string[] = [];

  // Check in files directory if it exists
  if (hasFilesDir) {
    const { readdir } = await import('fs/promises');
    try {
      const categories = await readdir(filesDir);
      for (const category of categories) {
        const categoryPath = join(filesDir, category);
        const categoryStats = await import('fs/promises').then((fs) => fs.stat(categoryPath).catch(() => null));
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
 * Validate that a destination path stays within the tuck directory
 * Prevents path traversal attacks via malicious manifest files
 */
const validateDestinationPath = (tuckDir: string, destination: string): boolean => {
  const fullPath = resolve(join(tuckDir, destination));
  const normalizedTuckDir = resolve(tuckDir);
  // Ensure the resolved path starts with tuckDir + separator to prevent escaping
  return fullPath.startsWith(normalizedTuckDir + sep) || fullPath === normalizedTuckDir;
};

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
  const remoteUrl = protocol === 'ssh'
    ? `git@github.com:${repoName}.git`
    : `https://github.com/${repoName}.git`;

  if (analysis.type === 'valid-tuck') {
    // Scenario A: Valid tuck repository - full import
    prompts.log.step('Importing tuck repository...');

    // Copy the entire repo to tuck directory
    const spinner = prompts.spinner();
    spinner.start('Copying repository...');

    // Copy files from cloned repo to tuck directory
    await copy(repoDir, tuckDir, { overwrite: true });

    spinner.stop('Repository copied');

    // Get file count
    const fileCount = Object.keys(analysis.manifest.files).length;

    // Track how many files are actually applied to the system
    let appliedCount = 0;

    // Apply dotfiles to system with merge strategy
    const shouldApply = await prompts.confirm(
      `Apply ${fileCount} dotfiles to your system?`,
      true
    );

    if (shouldApply) {
      // Validate and filter files once to avoid duplicate warnings
      const validFiles: Array<typeof analysis.manifest.files[string]> = [];
      for (const [_id, file] of Object.entries(analysis.manifest.files)) {
        // Validate that the source path is safe (within home directory)
        // This prevents malicious manifests from writing to arbitrary locations
        try {
          validateSafeSourcePath(file.source);
        } catch (error) {
          prompts.log.warning(`Skipping unsafe source path from manifest: ${file.source}`);
          continue;
        }

        // Validate that the destination path stays within tuckDir
        // This prevents path traversal attacks reading files from outside the repo
        if (!validateDestinationPath(tuckDir, file.destination)) {
          prompts.log.warning(`Skipping unsafe destination path from manifest: ${file.destination}`);
          continue;
        }

        validFiles.push(file);
      }

      // Create backup before applying
      const existingPaths: string[] = [];
      for (const file of validFiles) {
        const destPath = expandPath(file.source);
        if (await pathExists(destPath)) {
          existingPaths.push(destPath);
        }
      }

      if (existingPaths.length > 0) {
        const backupSpinner = prompts.spinner();
        backupSpinner.start('Creating backup of existing files...');
        await createPreApplySnapshot(existingPaths, repoName);
        backupSpinner.stop('Backup created');
      }

      // Apply files using the pre-validated list
      const applySpinner = prompts.spinner();
      applySpinner.start('Applying dotfiles...');

      for (const file of validFiles) {
        const repoFilePath = join(tuckDir, file.destination);
        const destPath = expandPath(file.source);

        if (await pathExists(repoFilePath)) {
          // Ensure destination directory exists
          const destDir = join(destPath, '..');
          await ensureDir(destDir);

          // Copy file
          await copy(repoFilePath, destPath, { overwrite: true });
          appliedCount++;
        }
      }

      applySpinner.stop(`Applied ${appliedCount} dotfiles`);
    }

    // Return both the number of files in the repo and the number applied to system
    // filesInRepo: total files imported to ~/.tuck (always happens)
    // filesApplied: files actually applied to system (0 if user declined)
    return { success: true, filesInRepo: fileCount, filesApplied: appliedCount, remoteUrl };
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
      await removeRemote(tuckDir, 'origin').catch(() => { /* ignore if not exists */ });
      await addRemote(tuckDir, 'origin', remoteUrl);
    } catch {
      // If removing fails, try adding anyway
      await addRemote(tuckDir, 'origin', remoteUrl).catch(() => { /* ignore if already exists */ });
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
          if (entry === '.git' || entry === '.tuckmanifest.json' || entry === '.tuckrc.json') continue;
          const fullPath = join(dir, entry);
          const stats = await stat(fullPath).catch(() => null);
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
    prompts.log.info("Run 'tuck add' to track files, then 'tuck sync && tuck push --force' to update remote");
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

  // Auto-detect existing GitHub dotfiles repository
  const ghInstalled = await isGhInstalled();
  const ghAuth = ghInstalled && (await isGhAuthenticated());

  if (ghAuth) {
    const spinner = prompts.spinner();
    spinner.start('Checking for existing dotfiles repository on GitHub...');

    try {
      const user = await getAuthenticatedUser();
      const existingRepoName = await findDotfilesRepo(user.login);

      if (existingRepoName) {
        spinner.stop(`Found repository: ${existingRepoName}`);

        const importRepo = await prompts.confirm(
          `Import dotfiles from ${existingRepoName}?`,
          true
        );

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
                  prompts.log.info('Files are ready in ~/.tuck. Run "tuck restore" to apply them to your system');
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
              prompts.log.warning(
                `Could not clone repository: ${errorMessage}`
              );
            }
            console.log();
            // Continue with normal flow
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
        }
      } else {
        spinner.stop('No existing dotfiles repository found');
      }
    } catch {
      spinner.stop('Could not check for existing repositories');
    }
  }

  // Ask about existing repo (manual flow)
  const hasExisting = await prompts.select('Do you have an existing dotfiles repository?', [
    { value: 'no', label: 'No, start fresh' },
    { value: 'yes', label: 'Yes, clone from URL' },
  ]);

  if (hasExisting === 'yes') {
    const repoUrl = await prompts.text('Enter repository URL:', {
      placeholder: 'git@github.com:user/dotfiles.git',
      validate: (value) => {
        if (!value) return 'Repository URL is required';
        if (!value.includes('github.com') && !value.includes('gitlab.com') && !value.includes('git@')) {
          return 'Please enter a valid git URL';
        }
        return undefined;
      },
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
  } else {
    await initFromScratch(tuckDir, {});

    // Detect existing dotfiles on the system
    const scanSpinner = prompts.spinner();
    scanSpinner.start('Scanning for dotfiles...');
    const detectedFiles = await detectDotfiles();
    const nonSensitiveFiles = detectedFiles.filter((f) => !f.sensitive);
    scanSpinner.stop(`Found ${nonSensitiveFiles.length} dotfiles on your system`);

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
        // Show multiselect with categories as groups - NO arbitrary limit!
        const options = nonSensitiveFiles.map((f) => ({
          value: f.path,
          label: `${collapsePath(f.path)}`,
          hint: f.category,
        }));

        const selectedFiles = await prompts.multiselect(
          'Select files to track:',
          options
        );

        if (selectedFiles.length > 0) {
          // Track files with beautiful progress display
          await trackFilesWithProgress(selectedFiles, tuckDir);

          // Ask if user wants to sync now
          console.log();
          const shouldSync = await prompts.confirm('Would you like to sync these changes now?', true);

          if (shouldSync) {
            console.log();
            const { runSync } = await import('./sync.js');
            await runSync({});
          }
        }
      } else {
        prompts.log.info("Run 'tuck scan' later to interactively add files");
      }
    }

    // Ask about remote - try GitHub auto-setup first
    const wantsRemote = await prompts.confirm('Would you like to set up a remote repository?');

    if (wantsRemote) {
      // Try GitHub auto-setup
      const ghResult = await setupGitHubRepo(tuckDir);

      // If GitHub setup didn't add a remote, fall back to manual entry
      if (!ghResult.remoteUrl) {
        const useManual = await prompts.confirm('Enter a remote URL manually?');

        if (useManual) {
          const remoteUrl = await prompts.text('Enter remote URL:', {
            placeholder: 'git@github.com:user/dotfiles.git',
          });

          if (remoteUrl) {
            await addRemote(tuckDir, 'origin', remoteUrl);
            prompts.log.success('Remote added successfully');
          }
        }
      }
    }
  }

  prompts.outro('Tuck initialized successfully!');

  nextSteps([
    `Add files:    tuck add ~/.zshrc`,
    `Sync changes: tuck sync`,
    `Push remote:  tuck push`,
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
  await initFromScratch(tuckDir, {
    remote: options.remote,
    bare: options.bare,
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
