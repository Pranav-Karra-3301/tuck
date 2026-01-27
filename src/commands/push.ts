import { Command } from 'commander';
import { prompts, logger, withSpinner, colors as c } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { checkLocalMode, showLocalModeWarningForPush } from '../lib/remoteChecks.js';
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
import { logForcePush } from '../lib/audit.js';

const runInteractivePush = async (tuckDir: string): Promise<void> => {
  prompts.intro('tuck push');

  // Check for local-only mode
  if (await checkLocalMode(tuckDir)) {
    await showLocalModeWarningForPush();
    prompts.outro('');
    return;
  }

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
  console.log(c.dim('Remote:'), remoteUrl);
  console.log(c.dim('Branch:'), branch);

  if (status.ahead > 0) {
    console.log(c.dim('Commits:'), c.green(`↑ ${status.ahead} to push`));
  }

  if (status.behind > 0) {
    console.log(c.dim('Warning:'), c.yellow(`↓ ${status.behind} commits behind remote`));

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

  try {
    await withSpinner('Pushing...', async () => {
      await push(tuckDir, {
        setUpstream: needsUpstream,
        branch: needsUpstream ? branch : undefined,
      });
    });
    prompts.log.success('Pushed successfully!');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Provide specific guidance based on common errors
    if (errorMsg.includes('Permission denied') || errorMsg.includes('publickey')) {
      prompts.log.error('Authentication failed');
      prompts.log.info('Check your SSH keys with: ssh -T git@github.com');
      prompts.log.info('Or try switching to HTTPS: git remote set-url origin https://...');
    } else if (errorMsg.includes('Could not resolve host') || errorMsg.includes('Network')) {
      prompts.log.error('Network error - could not reach remote');
      prompts.log.info('Check your internet connection and try again');
    } else if (errorMsg.includes('rejected') || errorMsg.includes('non-fast-forward')) {
      prompts.log.error('Push rejected - remote has changes');
      prompts.log.info("Run 'tuck pull' first, then push again");
      prompts.log.info("Or use 'tuck push --force' to overwrite (use with caution)");
    } else {
      prompts.log.error(`Push failed: ${errorMsg}`);
    }
    return;
  }

  if (remoteUrl) {
    // Extract repo URL for display
    let viewUrl = remoteUrl;
    if (remoteUrl.startsWith('git@github.com:')) {
      viewUrl = remoteUrl.replace('git@github.com:', 'https://github.com/').replace('.git', '');
    }
    console.log();
    console.log(c.dim('View at:'), c.cyan(viewUrl));
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

  // Check for local-only mode
  if (await checkLocalMode(tuckDir)) {
    throw new GitError(
      'Cannot push in local-only mode',
      "Run 'tuck config remote' to configure a remote repository"
    );
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

  // Require explicit confirmation for force push
  if (options.force) {
    const confirmed = await prompts.confirmDangerous(
      'Force push will overwrite remote history.\n' +
        'This can cause data loss for collaborators and is generally discouraged.',
      'force'
    );
    if (!confirmed) {
      logger.info('Push cancelled');
      return;
    }
    logger.warning('Force pushing to remote...');
    // Audit log for security tracking
    await logForcePush(branch);
  }

  try {
    await withSpinner('Pushing...', async () => {
      await push(tuckDir, {
        force: options.force,
        setUpstream: Boolean(options.setUpstream),
        branch: options.setUpstream || branch,
      });
    });
    logger.success('Pushed successfully!');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes('Permission denied') || errorMsg.includes('publickey')) {
      throw new GitError('Authentication failed', 'Check your SSH keys: ssh -T git@github.com');
    } else if (errorMsg.includes('Could not resolve host') || errorMsg.includes('Network')) {
      throw new GitError('Network error', 'Check your internet connection');
    } else if (errorMsg.includes('rejected') || errorMsg.includes('non-fast-forward')) {
      throw new GitError('Push rejected', "Run 'tuck pull' first, or use --force");
    } else {
      throw new GitError('Push failed', errorMsg);
    }
  }
};

export const pushCommand = new Command('push')
  .description('Push changes to remote repository')
  .option('-f, --force', 'Force push')
  .option('--set-upstream <name>', 'Set upstream branch')
  .action(async (options: PushOptions) => {
    await runPush(options);
  });
