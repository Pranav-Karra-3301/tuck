import { Command } from 'commander';
import { join, basename } from 'path';
import { prompts, logger, withSpinner, colors as c } from '../ui/index.js';
import { getTuckDir, expandPath, pathExists, collapsePath } from '../lib/paths.js';
import {
  loadManifest,
  getAllTrackedFiles,
  updateFileInManifest,
  removeFileFromManifest,
  getTrackedFileBySource,
} from '../lib/manifest.js';
import { stageAll, commit, getStatus, push, hasRemote, fetch, pull } from '../lib/git.js';
import {
  copyFileOrDir,
  getFileChecksum,
  deleteFileOrDir,
  checkFileSizeThreshold,
  formatFileSize,
  SIZE_BLOCK_THRESHOLD,
} from '../lib/files.js';
import { addToTuckignore, loadTuckignore, isIgnored } from '../lib/tuckignore.js';
import { runPreSyncHook, runPostSyncHook, type HookOptions } from '../lib/hooks.js';
import { NotInitializedError, SecretsDetectedError } from '../errors.js';
import type { SyncOptions, FileChange } from '../types.js';
import { detectDotfiles, DETECTION_CATEGORIES, type DetectedFile } from '../lib/detect.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { scanForSecrets, isSecretScanningEnabled, shouldBlockOnSecrets, processSecretsForRedaction, redactFile } from '../lib/secrets/index.js';
import { displayScanResults } from './secrets.js';
import { logForceSecretBypass } from '../lib/audit.js';

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

/**
 * Pull from remote if behind, returns info about what happened
 */
const pullIfBehind = async (
  tuckDir: string
): Promise<{ pulled: boolean; behind: number; error?: string }> => {
  const hasRemoteRepo = await hasRemote(tuckDir);
  if (!hasRemoteRepo) {
    return { pulled: false, behind: 0 };
  }

  try {
    // Fetch to get latest remote status
    await fetch(tuckDir);

    const status = await getStatus(tuckDir);

    if (status.behind === 0) {
      return { pulled: false, behind: 0 };
    }

    // Pull with rebase to keep history clean
    await pull(tuckDir, { rebase: true });

    return { pulled: true, behind: status.behind };
  } catch (error) {
    return {
      pulled: false,
      behind: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Detect new dotfiles that are not already tracked
 */
const detectNewDotfiles = async (tuckDir: string): Promise<DetectedFile[]> => {
  // Get all detected dotfiles on the system
  const detected = await detectDotfiles();

  // Filter out already-tracked files, ignored files, and excluded patterns
  const newFiles: DetectedFile[] = [];

  for (const file of detected) {
    // Skip if already tracked
    const tracked = await getTrackedFileBySource(tuckDir, file.path);
    if (tracked) continue;

    // Skip if in .tuckignore
    if (await isIgnored(tuckDir, file.path)) continue;

    newFiles.push(file);
  }

  return newFiles;
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
      result.modified.forEach((file) => {
        changes.push(`• ${file}`);
      });
    } else {
      changes.push(`Modified: ${result.modified.length} files`);
    }
  }

  if (result.deleted.length > 0) {
    if (result.deleted.length <= 5) {
      changes.push(result.modified.length > 0 ? '\nDeleted:' : 'Deleted:');
      result.deleted.forEach((file) => {
        changes.push(`• ${file}`);
      });
    } else {
      changes.push(
        `${result.modified.length > 0 ? '\n' : ''}Deleted: ${result.deleted.length} files`
      );
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
      result.modified.push(basename(change.path) || change.path);
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
      result.deleted.push(basename(change.path) || change.path);
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

/**
 * Scan modified files for secrets and handle user interaction
 * Returns true if sync should continue, false if aborted
 */
const scanAndHandleSecrets = async (
  tuckDir: string,
  changes: FileChange[],
  options: SyncOptions
): Promise<boolean> => {
  // Skip if force flag is set (but require confirmation first)
  if (options.force) {
    const confirmed = await prompts.confirmDangerous(
      'Using --force bypasses secret scanning.\n' +
        'Any secrets in modified files may be committed to git and potentially exposed.',
      'force'
    );
    if (!confirmed) {
      logger.info('Sync cancelled');
      return false;
    }
    logger.warning('Secret scanning bypassed with --force');
    // Audit log for security tracking
    await logForceSecretBypass('tuck sync --force', changes.length);
    return true;
  }

  // Check if scanning is enabled in config
  const scanningEnabled = await isSecretScanningEnabled(tuckDir);
  if (!scanningEnabled) {
    return true;
  }

  // Get paths of modified files (not deleted)
  const modifiedPaths = changes
    .filter((c) => c.status === 'modified')
    .map((c) => expandPath(c.source));

  if (modifiedPaths.length === 0) {
    return true;
  }

  // Scan files
  const spinner = prompts.spinner();
  spinner.start('Scanning for secrets...');
  const summary = await scanForSecrets(modifiedPaths, tuckDir);
  spinner.stop('Scan complete');

  if (summary.totalSecrets === 0) {
    return true;
  }

  // Display results
  displayScanResults(summary);

  // Prompt user for action
  const action = await prompts.select('What would you like to do?', [
    { value: 'abort', label: 'Abort sync' },
    { value: 'redact', label: 'Redact secrets (replace with placeholders)' },
    { value: 'ignore', label: 'Add files to .tuckignore and skip them' },
    { value: 'proceed', label: 'Proceed anyway (secrets will be committed)' },
  ]);

  if (action === 'abort') {
    prompts.cancel('Sync aborted - secrets detected');
    return false;
  }

  if (action === 'redact') {
    // Store secrets and replace them with placeholders in the source files
    const spinner = prompts.spinner();
    spinner.start('Redacting secrets...');

    try {
      // Process secrets: store them and get placeholder mappings
      const fileRedactionMaps = await processSecretsForRedaction(summary.results, tuckDir);

      // Redact each file
      let redactedCount = 0;
      for (const result of summary.results) {
        const placeholderMap = fileRedactionMaps.get(result.path);
        if (placeholderMap && placeholderMap.size > 0) {
          await redactFile(result.path, result.matches, placeholderMap);
          redactedCount++;
        }
      }

      spinner.stop(`Redacted secrets in ${redactedCount} file${redactedCount !== 1 ? 's' : ''}`);
      prompts.log.success('Secrets stored locally and replaced with placeholders');
      prompts.note("Use 'tuck secrets list' to see stored secrets", 'Tip');
    } catch (error) {
      spinner.stop('Redaction failed');
      prompts.log.error(error instanceof Error ? error.message : String(error));
      return false;
    }

    return true;
  }

  if (action === 'ignore') {
    // Add files with secrets to .tuckignore
    for (const result of summary.results) {
      const sourcePath = changes.find((c) => expandPath(c.source) === result.path)?.source;
      if (sourcePath) {
        await addToTuckignore(tuckDir, sourcePath);
        logger.dim(`Added ${collapsePath(result.path)} to .tuckignore`);
      }
    }
    // Filter out ignored files from changes list
    // Note: This intentionally mutates the 'changes' array in place so callers see the filtered list
    const filesToRemove = new Set(summary.results.map((r) => r.path));
    changes.splice(
      0,
      changes.length,
      ...changes.filter((c) => !filesToRemove.has(expandPath(c.source)))
    );

    if (changes.length === 0) {
      prompts.log.info('No remaining changes to sync');
      return false;
    }
    return true;
  }

  // proceed - continue with warning
  prompts.log.warning('Proceeding with secrets - make sure your repo is private!');
  return true;
};

const runInteractiveSync = async (tuckDir: string, options: SyncOptions = {}): Promise<void> => {
  prompts.intro('tuck sync');

  // ========== STEP 1: Pull from remote if behind ==========
  if (options.pull !== false && (await hasRemote(tuckDir))) {
    const pullSpinner = prompts.spinner();
    pullSpinner.start('Checking remote for updates...');

    const pullResult = await pullIfBehind(tuckDir);
    if (pullResult.error) {
      pullSpinner.stop(`Could not pull: ${pullResult.error}`);
      prompts.log.warning('Continuing with local changes...');
    } else if (pullResult.pulled) {
      pullSpinner.stop(
        `Pulled ${pullResult.behind} commit${pullResult.behind > 1 ? 's' : ''} from remote`
      );
    } else {
      pullSpinner.stop('Up to date with remote');
    }
  }

  // ========== STEP 2: Detect changes to tracked files ==========
  const changeSpinner = prompts.spinner();
  changeSpinner.start('Detecting changes to tracked files...');
  const changes = await detectChanges(tuckDir);
  changeSpinner.stop(`Found ${changes.length} changed file${changes.length !== 1 ? 's' : ''}`);

  // ========== STEP 2.5: Scan modified files for secrets ==========
  if (changes.length > 0) {
    const shouldContinue = await scanAndHandleSecrets(tuckDir, changes, options);
    if (!shouldContinue) {
      return;
    }
  }

  // ========== STEP 3: Scan for new dotfiles (if enabled) ==========
  let newFiles: DetectedFile[] = [];
  if (options.scan !== false) {
    const scanSpinner = prompts.spinner();
    scanSpinner.start('Scanning for new dotfiles...');
    newFiles = await detectNewDotfiles(tuckDir);
    scanSpinner.stop(`Found ${newFiles.length} new dotfile${newFiles.length !== 1 ? 's' : ''}`);
  }

  // ========== STEP 4: Handle case where nothing to do ==========
  if (changes.length === 0 && newFiles.length === 0) {
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

        // Push if remote exists
        if (options.push !== false && (await hasRemote(tuckDir))) {
          await pushWithSpinner(tuckDir, options);
        }
      }
    } else {
      prompts.log.success('Everything is up to date');
    }
    return;
  }

  // ========== STEP 5: Show changes to tracked files ==========
  if (changes.length > 0) {
    console.log();
    console.log(c.bold('Changes to tracked files:'));
    for (const change of changes) {
      if (change.status === 'modified') {
        console.log(c.yellow(`  ~ ${change.path}`));
      } else if (change.status === 'deleted') {
        console.log(c.red(`  - ${change.path}`));
      }
    }
  }

  // ========== STEP 6: Interactive selection for new files ==========
  let filesToTrack: FileToTrack[] = [];

  if (newFiles.length > 0) {
    console.log();
    console.log(c.bold(`New dotfiles found (${newFiles.length}):`));

    // Group by category for display
    const grouped: Record<string, DetectedFile[]> = {};
    for (const file of newFiles) {
      if (!grouped[file.category]) grouped[file.category] = [];
      grouped[file.category].push(file);
    }

    for (const [category, files] of Object.entries(grouped)) {
      const categoryInfo = DETECTION_CATEGORIES[category] || { icon: '-', name: category };
      console.log(
        c.cyan(
          `  ${categoryInfo.icon} ${categoryInfo.name}: ${files.length} file${files.length > 1 ? 's' : ''}`
        )
      );
    }

    console.log();
    const trackNewFiles = await prompts.confirm(
      'Would you like to track some of these new files?',
      true
    );

    if (trackNewFiles) {
      // Create multiselect options (pre-select non-sensitive files)
      const selectOptions = newFiles.map((f) => ({
        value: f.path,
        label: `${collapsePath(expandPath(f.path))}${f.sensitive ? c.yellow(' [sensitive]') : ''}`,
        hint: f.category,
      }));

      const nonSensitiveFiles = newFiles.filter((f) => !f.sensitive);
      const initialValues = nonSensitiveFiles.map((f) => f.path);

      const selected = await prompts.multiselect('Select files to track:', selectOptions, {
        initialValues,
      });

      filesToTrack = selected.map((path) => ({ path: path as string }));
    }
  }

  // ========== STEP 7: Handle large files in tracked changes ==========
  const largeFiles: Array<{ path: string; size: string; sizeBytes: number }> = [];

  for (const change of changes) {
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

  if (largeFiles.length > 0) {
    console.log();
    console.log(c.yellow('Large files detected:'));
    for (const file of largeFiles) {
      console.log(c.yellow(`  ${file.path} (${file.size})`));
    }
    console.log();
    console.log(c.dim('GitHub has a 50MB warning and 100MB hard limit.'));
    console.log();

    const hasBlockers = largeFiles.some((f) => f.sizeBytes >= SIZE_BLOCK_THRESHOLD);

    if (hasBlockers) {
      const action = await prompts.select('Some files exceed 100MB. What would you like to do?', [
        { value: 'ignore', label: 'Add large files to .tuckignore' },
        { value: 'continue', label: 'Try to commit anyway (may fail)' },
        { value: 'cancel', label: 'Cancel sync' },
      ]);

      if (action === 'ignore') {
        for (const file of largeFiles) {
          const fullPath = changes.find((c) => c.path === file.path)?.source;
          if (fullPath) {
            await addToTuckignore(tuckDir, fullPath);
            const index = changes.findIndex((c) => c.path === file.path);
            if (index > -1) changes.splice(index, 1);
          }
        }
        prompts.log.success('Added large files to .tuckignore');

        if (changes.length === 0 && filesToTrack.length === 0) {
          prompts.log.info('No changes remaining to sync');
          return;
        }
      } else if (action === 'cancel') {
        prompts.cancel('Operation cancelled');
        return;
      }
    } else {
      const action = await prompts.select('Large files detected. What would you like to do?', [
        { value: 'continue', label: 'Continue with sync' },
        { value: 'ignore', label: 'Add to .tuckignore and skip' },
        { value: 'cancel', label: 'Cancel sync' },
      ]);

      if (action === 'ignore') {
        for (const file of largeFiles) {
          const fullPath = changes.find((c) => c.path === file.path)?.source;
          if (fullPath) {
            await addToTuckignore(tuckDir, fullPath);
            const index = changes.findIndex((c) => c.path === file.path);
            if (index > -1) changes.splice(index, 1);
          }
        }
        prompts.log.success('Added large files to .tuckignore');

        if (changes.length === 0 && filesToTrack.length === 0) {
          prompts.log.info('No changes remaining to sync');
          return;
        }
      } else if (action === 'cancel') {
        prompts.cancel('Operation cancelled');
        return;
      }
    }
  }

  // ========== STEP 8: Track new files ==========
  if (filesToTrack.length > 0) {
    console.log();
    await trackFilesWithProgress(filesToTrack, tuckDir, {
      showCategory: true,
      actionVerb: 'Tracking',
    });
  }

  // ========== STEP 9: Sync changes to tracked files ==========
  let result: SyncResult = { modified: [], deleted: [] };

  if (changes.length > 0) {
    // Generate commit message
    const message =
      options.message ||
      generateCommitMessage({
        modified: changes.filter((c) => c.status === 'modified').map((c) => c.path),
        deleted: changes.filter((c) => c.status === 'deleted').map((c) => c.path),
      });

    console.log();
    console.log(c.dim('Commit message:'));
    console.log(
      c.cyan(
        message
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')
      )
    );
    console.log();

    result = await syncFiles(tuckDir, changes, { ...options, message });
  } else if (filesToTrack.length > 0) {
    // Only new files were added, commit them
    if (!options.noCommit) {
      const message =
        options.message ||
        `Add ${filesToTrack.length} new dotfile${filesToTrack.length > 1 ? 's' : ''}`;
      await stageAll(tuckDir);
      result.commitHash = await commit(tuckDir, message);
    }
  }

  // ========== STEP 10: Push to remote ==========
  console.log();
  let pushFailed = false;

  if (result.commitHash) {
    prompts.log.success(`Committed: ${result.commitHash.slice(0, 7)}`);

    if (options.push !== false && (await hasRemote(tuckDir))) {
      pushFailed = !(await pushWithSpinner(tuckDir, options));
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
 * Helper to push with spinner and error handling
 */
const pushWithSpinner = async (tuckDir: string, _options: SyncOptions): Promise<boolean> => {
  const spinner = prompts.spinner();
  try {
    const status = await getStatus(tuckDir);
    const needsUpstream = !status.tracking;
    const branch = status.branch;

    spinner.start('Pushing to remote...');
    await push(tuckDir, {
      setUpstream: needsUpstream,
      branch: needsUpstream ? branch : undefined,
    });
    spinner.stop('Pushed to remote');
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    spinner.stop(`Push failed: ${errorMsg}`);
    prompts.log.warning("Run 'tuck push' to try again");
    return false;
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

export const runSyncCommand = async (
  messageArg: string | undefined,
  options: SyncOptions
): Promise<void> => {
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

  // Scan for secrets (non-interactive mode)
  if (!options.force) {
    const scanningEnabled = await isSecretScanningEnabled(tuckDir);
    if (scanningEnabled) {
      const modifiedPaths = changes
        .filter((c) => c.status === 'modified')
        .map((c) => expandPath(c.source));

      if (modifiedPaths.length > 0) {
        const summary = await scanForSecrets(modifiedPaths, tuckDir);
        if (summary.totalSecrets > 0) {
          displayScanResults(summary);

          // Check if we should block or just warn
          const shouldBlock = await shouldBlockOnSecrets(tuckDir);
          if (shouldBlock) {
            throw new SecretsDetectedError(
              summary.totalSecrets,
              summary.results.map((r) => collapsePath(r.path))
            );
          } else {
            // Warn but continue
            logger.warning('Secrets detected but blockOnSecrets is disabled - proceeding with sync');
            logger.warning('Make sure your repository is private!');
          }
        }
      }
    }
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
  .description(
    'Sync all dotfile changes (pull, detect changes, scan for new files, track, commit, push)'
  )
  .argument('[message]', 'Commit message')
  .option('-m, --message <msg>', 'Commit message')
  // TODO: --all and --amend are planned for a future version
  // .option('-a, --all', 'Sync all tracked files, not just changed')
  // .option('--amend', 'Amend previous commit')
  .option('--no-commit', "Stage changes but don't commit")
  .option('--no-push', "Commit but don't push to remote")
  .option('--no-pull', "Don't pull from remote first")
  .option('--no-scan', "Don't scan for new dotfiles")
  .option('--no-hooks', 'Skip execution of pre/post sync hooks')
  .option('--trust-hooks', 'Trust and run hooks without confirmation (use with caution)')
  .option('-f, --force', 'Skip secret scanning (not recommended)')
  .action(async (messageArg: string | undefined, options: SyncOptions) => {
    await runSyncCommand(messageArg, options);
  });
