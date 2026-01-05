import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'path';
import { prompts, logger, withSpinner } from '../ui/index.js';
import { getTuckDir, expandPath, pathExists } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles, updateFileInManifest, removeFileFromManifest } from '../lib/manifest.js';
import { stageAll, commit, getStatus, push, hasRemote } from '../lib/git.js';
import { copyFileOrDir, getFileChecksum, deleteFileOrDir, checkFileSizeThreshold, formatFileSize, SIZE_BLOCK_THRESHOLD } from '../lib/files.js';
import { addToTuckignore, loadTuckignore } from '../lib/tuckignore.js';
import { runPreSyncHook, runPostSyncHook, type HookOptions } from '../lib/hooks.js';
import { NotInitializedError } from '../errors.js';
import type { SyncOptions, FileChange } from '../types.js';

interface SyncResult {
  modified: string[];
  deleted: string[];
  commitHash?: string;
  // Note: There is no 'added' array because adding new files is done via 'tuck add', not 'tuck sync'.
  // The sync command only handles changes to already-tracked files.
}

const detectChanges = async (tuckDir: string): Promise<FileChange[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  const ignoredPaths = await loadTuckignore(tuckDir);
  const changes: FileChange[] = [];

  for (const [, file] of Object.entries(files)) {
    // Skip if in .tuckignore
    if (ignoredPaths.has(file.source)) {
      continue;
    }

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
  const totalCount = result.modified.length + result.deleted.length;
  const date = new Date().toISOString().split('T')[0];

  // Header with emoji and count
  let message = `✨ Update dotfiles\n\n`;

  // List changes
  const changes: string[] = [];
  
  if (result.modified.length > 0) {
    if (result.modified.length <= 5) {
      // List individual files if 5 or fewer
      changes.push('Modified:');
      result.modified.forEach(file => {
        changes.push(`• ${file}`);
      });
    } else {
      changes.push(`Modified: ${result.modified.length} files`);
    }
  }

  if (result.deleted.length > 0) {
    if (result.deleted.length <= 5) {
      changes.push(result.modified.length > 0 ? '\nDeleted:' : 'Deleted:');
      result.deleted.forEach(file => {
        changes.push(`• ${file}`);
      });
    } else {
      changes.push(`${result.modified.length > 0 ? '\n' : ''}Deleted: ${result.deleted.length} files`);
    }
  }

  if (changes.length > 0) {
    message += changes.join('\n') + '\n';
  }

  // Footer with branding and metadata
  message += `\n---\n`;
  message += `📦 Managed by tuck (tuck.sh) • ${date}`;
  
  if (totalCount > 0) {
    message += ` • ${totalCount} file${totalCount > 1 ? 's' : ''} changed`;
  }

  return message;
};

const syncFiles = async (
  tuckDir: string,
  changes: FileChange[],
  options: SyncOptions
): Promise<SyncResult> => {
  const result: SyncResult = {
    modified: [],
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
      await withSpinner(`Removing ${change.path}...`, async () => {
        // Delete the file from the tuck repository
        await deleteFileOrDir(destPath);

        // Remove from manifest
        const files = await getAllTrackedFiles(tuckDir);
        const fileId = Object.entries(files).find(([, f]) => f.source === change.source)?.[0];

        if (fileId) {
          await removeFileFromManifest(tuckDir, fileId);
        }
      });
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

const runInteractiveSync = async (tuckDir: string, options: SyncOptions = {}): Promise<void> => {
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

  // Check for large files in changes
  const largeFiles: Array<{ path: string; size: string; sizeBytes: number }> = [];

  for (const change of changes) {
    // Check size for all changes that involve adding/modifying file content
    if (change.status !== 'deleted') {
      const expandedPath = expandPath(change.source);
      const sizeCheck = await checkFileSizeThreshold(expandedPath);
      
      if (sizeCheck.warn || sizeCheck.block) {
        largeFiles.push({
          path: change.path,
          size: formatFileSize(sizeCheck.size),
          sizeBytes: sizeCheck.size,
        });
      }
    }
  }

  // Show large file warnings
  if (largeFiles.length > 0) {
    console.log();
    console.log(chalk.yellow('⚠ Large files detected:'));
    for (const file of largeFiles) {
      console.log(chalk.yellow(`  • ${file.path} (${file.size})`));
    }
    console.log();
    console.log(chalk.dim('GitHub has a 50MB warning and 100MB hard limit.'));
    console.log();
    
    const hasBlockers = largeFiles.some(f => f.sizeBytes >= SIZE_BLOCK_THRESHOLD);
    
    if (hasBlockers) {
      const action = await prompts.select(
        'Some files exceed 100MB. What would you like to do?',
        [
          { value: 'ignore', label: 'Add large files to .tuckignore' },
          { value: 'continue', label: 'Try to commit anyway (may fail)' },
          { value: 'cancel', label: 'Cancel sync' },
        ]
      );
      
      if (action === 'ignore') {
        for (const file of largeFiles) {
          const fullPath = changes.find(c => c.path === file.path)?.source;
          if (fullPath) {
            await addToTuckignore(tuckDir, fullPath);
            // Remove from changes array
            const index = changes.findIndex(c => c.path === file.path);
            if (index > -1) changes.splice(index, 1);
          }
        }
        prompts.log.success('Added large files to .tuckignore');
        
        if (changes.length === 0) {
          prompts.log.info('No changes remaining to sync');
          return;
        }
      } else if (action === 'cancel') {
        prompts.cancel('Operation cancelled');
        return;
      }
      // 'continue' falls through
    } else {
      // Just warnings (50-100MB), show but allow to continue
      const action = await prompts.select(
        'Large files detected. What would you like to do?',
        [
          { value: 'continue', label: 'Continue with sync' },
          { value: 'ignore', label: 'Add to .tuckignore and skip' },
          { value: 'cancel', label: 'Cancel sync' },
        ]
      );
      
      if (action === 'ignore') {
        for (const file of largeFiles) {
          const fullPath = changes.find(c => c.path === file.path)?.source;
          if (fullPath) {
            await addToTuckignore(tuckDir, fullPath);
            const index = changes.findIndex(c => c.path === file.path);
            if (index > -1) changes.splice(index, 1);
          }
        }
        prompts.log.success('Added large files to .tuckignore');
        
        if (changes.length === 0) {
          prompts.log.info('No changes remaining to sync');
          return;
        }
      } else if (action === 'cancel') {
        prompts.cancel('Operation cancelled');
        return;
      }
    }
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

  // Generate auto commit message
  const message = generateCommitMessage({
    modified: changes.filter((c) => c.status === 'modified').map((c) => c.path),
    deleted: changes.filter((c) => c.status === 'deleted').map((c) => c.path),
  });

  console.log(chalk.dim('Commit message:'));
  console.log(chalk.cyan(message.split('\n').map(line => `  ${line}`).join('\n')));
  console.log();

  // Sync
  const result = await syncFiles(tuckDir, changes, { message });

  console.log();
  let pushFailed = false;
  
  if (result.commitHash) {
    prompts.log.success(`Committed: ${result.commitHash.slice(0, 7)}`);

    // Auto-push to remote if it exists (unless --no-push specified)
    if (options.push !== false && (await hasRemote(tuckDir))) {
      const spinner2 = prompts.spinner();
      try {
        // Get current branch and status
        const status = await getStatus(tuckDir);
        const needsUpstream = !status.tracking;
        const branch = status.branch;
        
        // If behind remote, pull first
        if (status.behind > 0) {
          spinner2.start('Pulling from remote...');
          const { pull } = await import('../lib/git.js');
          await pull(tuckDir, { rebase: true });
          spinner2.stop('Pulled from remote');
        }
        
        // Push to remote
        spinner2.start('Pushing to remote...');
        await push(tuckDir, {
          setUpstream: needsUpstream,
          branch: needsUpstream ? branch : undefined,
        });
        spinner2.stop('Pushed to remote');
      } catch (error) {
        pushFailed = true;
        const errorMsg = error instanceof Error ? error.message : String(error);
        spinner2.stop(`Push failed: ${errorMsg}`);
        prompts.log.warning("Run 'tuck pull' then 'tuck push' to sync manually");
      }
    } else if (options.push === false) {
      prompts.log.info("Run 'tuck push' when ready to upload");
    }
  }

  // Only show success if no push failure occurred
  if (!pushFailed) {
    prompts.outro('Synced successfully!');
  }
};

/**
 * Run sync programmatically (exported for use by other commands)
 */
export const runSync = async (options: SyncOptions = {}): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Always run interactive sync when called programmatically
  await runInteractiveSync(tuckDir, options);
};

const runSyncCommand = async (messageArg: string | undefined, options: SyncOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // If no options (except --no-push), run interactive
  if (!messageArg && !options.message && !options.noCommit) {
    await runInteractiveSync(tuckDir, options);
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
    // Commander converts --no-push to push: false, default is push: true
    if (options.push !== false && (await hasRemote(tuckDir))) {
      await withSpinner('Pushing to remote...', async () => {
        await push(tuckDir);
      });
      logger.success('Pushed to remote');
    } else if (options.push === false) {
      logger.info("Run 'tuck push' when ready to upload");
    }
  }
};

export const syncCommand = new Command('sync')
  .description('Sync changes to repository (commits and pushes)')
  .argument('[message]', 'Commit message')
  .option('-m, --message <msg>', 'Commit message')
  // TODO: --all and --amend are planned for a future version
  // .option('-a, --all', 'Sync all tracked files, not just changed')
  // .option('--amend', 'Amend previous commit')
  .option('--no-commit', "Stage changes but don't commit")
  .option('--no-push', "Commit but don't push to remote")
  .option('--no-hooks', 'Skip execution of pre/post sync hooks')
  .option('--trust-hooks', 'Trust and run hooks without confirmation (use with caution)')
  .action(async (messageArg: string | undefined, options: SyncOptions) => {
    await runSyncCommand(messageArg, options);
  });
