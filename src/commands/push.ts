import { Command } from 'commander';
import chalk from 'chalk';
import { prompts, logger, withSpinner } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import {
  push,
  hasRemote,
  getRemoteUrl,
  getStatus,
  getCurrentBranch,
  addRemote,
} from '../lib/git.js';
import { NotInitializedError, GitError } from '../errors.js';
import type { PushOptions } from '../types.js';

const runInteractivePush = async (tuckDir: string): Promise<void> => {
  prompts.intro('tuck push');

  // Check if remote exists
  const hasRemoteRepo = await hasRemote(tuckDir);

  if (!hasRemoteRepo) {
    prompts.log.warning('No remote configured');

    const addRemoteNow = await prompts.confirm('Would you like to add a remote?');
    if (!addRemoteNow) {
      prompts.cancel('No remote to push to');
      return;
    }

    const remoteUrl = await prompts.text('Enter remote URL:', {
      placeholder: 'git@github.com:user/dotfiles.git',
      validate: (value) => {
        if (!value) return 'Remote URL is required';
        return undefined;
      },
    });

    await addRemote(tuckDir, 'origin', remoteUrl);
    prompts.log.success('Remote added');
  }

  // Get current status
  const status = await getStatus(tuckDir);
  const branch = await getCurrentBranch(tuckDir);
  const remoteUrl = await getRemoteUrl(tuckDir);

  if (status.ahead === 0 && status.tracking) {
    prompts.log.success('Already up to date with remote');
    return;
  }

  // Show what will be pushed
  console.log();
  console.log(chalk.dim('Remote:'), remoteUrl);
  console.log(chalk.dim('Branch:'), branch);

  if (status.ahead > 0) {
    console.log(chalk.dim('Commits:'), chalk.green(`↑ ${status.ahead} to push`));
  }

  if (status.behind > 0) {
    console.log(chalk.dim('Warning:'), chalk.yellow(`↓ ${status.behind} commits behind remote`));

    const pullFirst = await prompts.confirm('Pull changes first?', true);
    if (pullFirst) {
      prompts.log.info("Run 'tuck pull' first, then push");
      return;
    }
  }

  console.log();

  // Confirm
  const confirm = await prompts.confirm('Push to remote?', true);
  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Push
  const needsUpstream = !status.tracking;

  await withSpinner('Pushing...', async () => {
    await push(tuckDir, {
      setUpstream: needsUpstream,
      branch: needsUpstream ? branch : undefined,
    });
  });

  prompts.log.success('Pushed successfully!');

  if (remoteUrl) {
    // Extract repo URL for display
    let viewUrl = remoteUrl;
    if (remoteUrl.startsWith('git@github.com:')) {
      viewUrl = remoteUrl
        .replace('git@github.com:', 'https://github.com/')
        .replace('.git', '');
    }
    console.log();
    console.log(chalk.dim('View at:'), chalk.cyan(viewUrl));
  }

  prompts.outro('');
};

const runPush = async (options: PushOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // If no options, run interactive
  if (!options.force && !options.setUpstream) {
    await runInteractivePush(tuckDir);
    return;
  }

  // Check if remote exists
  const hasRemoteRepo = await hasRemote(tuckDir);
  if (!hasRemoteRepo) {
    throw new GitError('No remote configured', "Run 'tuck init -r <url>' or add a remote manually");
  }

  const branch = await getCurrentBranch(tuckDir);

  await withSpinner('Pushing...', async () => {
    await push(tuckDir, {
      force: options.force,
      setUpstream: Boolean(options.setUpstream),
      branch: options.setUpstream || branch,
    });
  });

  logger.success('Pushed successfully!');
};

export const pushCommand = new Command('push')
  .description('Push changes to remote repository')
  .option('-f, --force', 'Force push')
  .option('--set-upstream <name>', 'Set upstream branch')
  .action(async (options: PushOptions) => {
    await runPush(options);
  });
