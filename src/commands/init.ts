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
import { initRepo, addRemote, cloneRepo, setDefaultBranch } from '../lib/git.js';
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

    // Ask about remote
    const wantsRemote = await prompts.confirm('Would you like to set up a remote repository?');

    if (wantsRemote) {
      const remoteUrl = await prompts.text('Enter remote URL:', {
        placeholder: 'git@github.com:user/dotfiles.git',
      });

      if (remoteUrl) {
        await addRemote(tuckDir, 'origin', remoteUrl);
        prompts.log.success('Remote added successfully');
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
