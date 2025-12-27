import { Command } from 'commander';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { ensureDir } from 'fs-extra';
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
} from '../lib/paths.js';
import { saveConfig } from '../lib/config.js';
import { createManifest } from '../lib/manifest.js';
import { initRepo, addRemote, cloneRepo, setDefaultBranch, stageAll, commit, push } from '../lib/git.js';
import {
  isGhInstalled,
  isGhAuthenticated,
  getAuthenticatedUser,
  createRepo,
  getPreferredRepoUrl,
} from '../lib/github.js';
import { AlreadyInitializedError } from '../errors.js';
import { CATEGORIES, COMMON_DOTFILES } from '../constants.js';
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
  // Create .gitignore
  const gitignorePath = join(tuckDir, '.gitignore');
  await writeFile(gitignorePath, GITIGNORE_TEMPLATE, 'utf-8');

  // Create README.md
  const readmePath = join(tuckDir, 'README.md');
  await writeFile(readmePath, README_TEMPLATE(machine), 'utf-8');
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

  // Ask about existing repo
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
      prompts.log.info('Run `tuck restore --all` to restore all dotfiles');
    }
  } else {
    // Check for common dotfiles that exist
    const existingDotfiles: { path: string; label: string }[] = [];

    for (const df of COMMON_DOTFILES) {
      const fullPath = expandPath(df.path);
      if (await pathExists(fullPath)) {
        existingDotfiles.push({
          path: df.path,
          label: `${df.path} (${df.category})`,
        });
      }
    }

    await initFromScratch(tuckDir, {});

    // Ask to add common dotfiles if any exist
    if (existingDotfiles.length > 0) {
      const selectedFiles = await prompts.multiselect(
        'Would you like to track some common dotfiles?',
        existingDotfiles.map((f) => ({
          value: f.path,
          label: f.label,
        }))
      );

      if (selectedFiles.length > 0) {
        prompts.log.step(
          `Run the following to track these files:\n  tuck add ${selectedFiles.join(' ')}`
        );
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
