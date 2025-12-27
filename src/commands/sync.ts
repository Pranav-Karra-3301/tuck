import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'path';
import { prompts, logger, withSpinner } from '../ui/index.js';
import { getTuckDir, expandPath, pathExists } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles, updateFileInManifest } from '../lib/manifest.js';
import { stageAll, commit, getStatus, push, hasRemote } from '../lib/git.js';
import { copyFileOrDir, getFileChecksum } from '../lib/files.js';
import { runPreSyncHook, runPostSyncHook, type HookOptions } from '../lib/hooks.js';
import { NotInitializedError } from '../errors.js';
import type { SyncOptions, FileChange } from '../types.js';

interface SyncResult {
  modified: string[];
  added: string[];
  deleted: string[];
  commitHash?: string;
}

const detectChanges = async (tuckDir: string): Promise<FileChange[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  const changes: FileChange[] = [];

  for (const [, file] of Object.entries(files)) {
    const sourcePath = expandPath(file.source);

    // Check if source still exists
    if (!(await pathExists(sourcePath))) {
      changes.push({
        path: file.source,
        status: 'deleted',
        source: file.source,
        destination: file.destination,
      });
      continue;
    }

    // Check if file has changed compared to stored checksum
    try {
      const sourceChecksum = await getFileChecksum(sourcePath);
      if (sourceChecksum !== file.checksum) {
        changes.push({
          path: file.source,
          status: 'modified',
          source: file.source,
          destination: file.destination,
        });
      }
    } catch {
      changes.push({
        path: file.source,
        status: 'modified',
        source: file.source,
        destination: file.destination,
      });
    }
  }

  return changes;
};

const generateCommitMessage = (result: SyncResult): string => {
  const parts: string[] = [];

  if (result.added.length > 0) {
    parts.push(`Add: ${result.added.join(', ')}`);
  }
  if (result.modified.length > 0) {
    parts.push(`Update: ${result.modified.join(', ')}`);
  }
  if (result.deleted.length > 0) {
    parts.push(`Remove: ${result.deleted.join(', ')}`);
  }

  if (parts.length === 0) {
    return 'Sync dotfiles';
  }

  const totalCount =
    result.added.length + result.modified.length + result.deleted.length;

  if (parts.length === 1 && totalCount <= 3) {
    return parts[0];
  }

  return `Sync: ${totalCount} file${totalCount > 1 ? 's' : ''} changed`;
};

const syncFiles = async (
  tuckDir: string,
  changes: FileChange[],
  options: SyncOptions
): Promise<SyncResult> => {
  const result: SyncResult = {
    modified: [],
    added: [],
    deleted: [],
  };

  // Prepare hook options
  const hookOptions: HookOptions = {
    skipHooks: options.noHooks,
    trustHooks: options.trustHooks,
  };

  // Run pre-sync hook
  await runPreSyncHook(tuckDir, hookOptions);

  // Process each change
  for (const change of changes) {
    const sourcePath = expandPath(change.source);
    const destPath = join(tuckDir, change.destination!);

    if (change.status === 'modified') {
      await withSpinner(`Syncing ${change.path}...`, async () => {
        await copyFileOrDir(sourcePath, destPath, { overwrite: true });

        // Update checksum in manifest
        const newChecksum = await getFileChecksum(destPath);
        const files = await getAllTrackedFiles(tuckDir);
        const fileId = Object.entries(files).find(([, f]) => f.source === change.source)?.[0];

        if (fileId) {
          await updateFileInManifest(tuckDir, fileId, {
            checksum: newChecksum,
            modified: new Date().toISOString(),
          });
        }
      });
      result.modified.push(change.path.split('/').pop() || change.path);
    } else if (change.status === 'deleted') {
      logger.warning(`Source file deleted: ${change.path}`);
      result.deleted.push(change.path.split('/').pop() || change.path);
    }
  }

  // Stage and commit if not --no-commit
  if (!options.noCommit && (result.modified.length > 0 || result.deleted.length > 0)) {
    await withSpinner('Staging changes...', async () => {
      await stageAll(tuckDir);
    });

    const message = options.message || generateCommitMessage(result);

    await withSpinner('Committing...', async () => {
      result.commitHash = await commit(tuckDir, message);
    });
  }

  // Run post-sync hook
  await runPostSyncHook(tuckDir, hookOptions);

  return result;
};

const runInteractiveSync = async (tuckDir: string): Promise<void> => {
  prompts.intro('tuck sync');

  // Detect changes
  const spinner = prompts.spinner();
  spinner.start('Detecting changes...');
  const changes = await detectChanges(tuckDir);
  spinner.stop('Changes detected');

  if (changes.length === 0) {
    // Check for git changes
    const gitStatus = await getStatus(tuckDir);
    if (gitStatus.hasChanges) {
      prompts.log.info('No dotfile changes, but repository has uncommitted changes');

      const commitAnyway = await prompts.confirm('Commit repository changes?');
      if (commitAnyway) {
        const message = await prompts.text('Commit message:', {
          defaultValue: 'Update dotfiles',
        });

        await stageAll(tuckDir);
        const hash = await commit(tuckDir, message);
        prompts.log.success(`Committed: ${hash.slice(0, 7)}`);
      }
    } else {
      prompts.log.success('Everything is up to date');
    }
    return;
  }

  // Show changes
  console.log();
  console.log(chalk.bold('Changes detected:'));
  for (const change of changes) {
    if (change.status === 'modified') {
      console.log(chalk.yellow(`  ~ ${change.path}`));
    } else if (change.status === 'deleted') {
      console.log(chalk.red(`  - ${change.path}`));
    }
  }
  console.log();

  // Confirm
  const confirm = await prompts.confirm('Sync these changes?', true);
  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Get commit message
  const autoMessage = generateCommitMessage({
    modified: changes.filter((c) => c.status === 'modified').map((c) => c.path),
    added: [],
    deleted: changes.filter((c) => c.status === 'deleted').map((c) => c.path),
  });

  const message = await prompts.text('Commit message:', {
    defaultValue: autoMessage,
  });

  // Sync
  const result = await syncFiles(tuckDir, changes, { message });

  console.log();
  if (result.commitHash) {
    prompts.log.success(`Committed: ${result.commitHash.slice(0, 7)}`);

    // Push by default if remote exists
    if (await hasRemote(tuckDir)) {
      const spinner2 = prompts.spinner();
      spinner2.start('Pushing to remote...');
      try {
        await push(tuckDir);
        spinner2.stop('Pushed to remote');
      } catch {
        spinner2.stop('Push failed (will retry on next sync)');
      }
    }
  }

  prompts.outro('Synced successfully!');
};

const runSync = async (messageArg: string | undefined, options: SyncOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // If no options, run interactive
  if (!messageArg && !options.message && !options.all && !options.noCommit && !options.amend) {
    await runInteractiveSync(tuckDir);
    return;
  }

  // Detect changes
  const changes = await detectChanges(tuckDir);

  if (changes.length === 0) {
    logger.info('No changes detected');
    return;
  }

  // Show changes
  logger.heading('Changes detected:');
  for (const change of changes) {
    logger.file(change.status === 'modified' ? 'modify' : 'delete', change.path);
  }
  logger.blank();

  // Sync
  const message = messageArg || options.message;
  const result = await syncFiles(tuckDir, changes, { ...options, message });

  logger.blank();
  logger.success(`Synced ${changes.length} file${changes.length > 1 ? 's' : ''}`);

  if (result.commitHash) {
    logger.info(`Commit: ${result.commitHash.slice(0, 7)}`);

    // Push by default unless --no-push
    if (!options.noPush && (await hasRemote(tuckDir))) {
      await withSpinner('Pushing to remote...', async () => {
        await push(tuckDir);
      });
      logger.success('Pushed to remote');
    } else if (options.noPush) {
      logger.info("Run 'tuck push' when ready to upload");
    }
  }
};

export const syncCommand = new Command('sync')
  .description('Sync changes to repository (commits and pushes)')
  .argument('[message]', 'Commit message')
  .option('-m, --message <msg>', 'Commit message')
  .option('-a, --all', 'Sync all tracked files, not just changed')
  .option('--no-commit', "Stage changes but don't commit")
  .option('--no-push', "Commit but don't push to remote")
  .option('--amend', 'Amend previous commit')
  .option('--no-hooks', 'Skip execution of pre/post sync hooks')
  .option('--trust-hooks', 'Trust and run hooks without confirmation (use with caution)')
  .action(async (messageArg: string | undefined, options: SyncOptions) => {
    await runSync(messageArg, options);
  });
