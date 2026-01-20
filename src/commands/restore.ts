import { Command } from 'commander';
import { join } from 'path';
import { colors as c } from '../ui/theme.js';
import { chmod, stat } from 'fs/promises';
import { prompts, logger, withSpinner } from '../ui/index.js';
import { getTuckDir, expandPath, pathExists, collapsePath } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles, getTrackedFileBySource } from '../lib/manifest.js';
import { loadConfig } from '../lib/config.js';
import { copyFileOrDir, createSymlink } from '../lib/files.js';
import { createBackup } from '../lib/backup.js';
import { runPreRestoreHook, runPostRestoreHook, type HookOptions } from '../lib/hooks.js';
import { NotInitializedError, FileNotFoundError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { RestoreOptions } from '../types.js';
import { restoreFiles as restoreSecrets, getSecretCount } from '../lib/secrets/index.js';

/**
 * Fix permissions for SSH files after restore
 * SSH requires strict permissions: 700 for directories, 600 for private files
 */
const fixSSHPermissions = async (path: string): Promise<void> => {
  const expandedPath = expandPath(path);

  // Only fix permissions for SSH files
  // Check for files inside .ssh/ directory or the .ssh directory itself
  if (!path.includes('.ssh/') && !path.endsWith('.ssh')) {
    return;
  }

  try {
    const stats = await stat(expandedPath);

    if (stats.isDirectory()) {
      // Directories should be 700
      await chmod(expandedPath, 0o700);
    } else {
      // Files should be 600
      await chmod(expandedPath, 0o600);
    }
  } catch {
    // Ignore permission errors (might be on Windows)
  }
};

/**
 * Fix GPG permissions after restore
 */
const fixGPGPermissions = async (path: string): Promise<void> => {
  const expandedPath = expandPath(path);

  // Only fix permissions for GPG files
  // Check for files inside .gnupg/ directory or the .gnupg directory itself
  if (!path.includes('.gnupg/') && !path.endsWith('.gnupg')) {
    return;
  }

  try {
    const stats = await stat(expandedPath);

    if (stats.isDirectory()) {
      await chmod(expandedPath, 0o700);
    } else {
      await chmod(expandedPath, 0o600);
    }
  } catch {
    // Ignore permission errors
  }
};

interface FileToRestore {
  id: string;
  source: string;
  destination: string;
  category: string;
  existsAtTarget: boolean;
}

interface RestoreResult {
  restoredCount: number;
  secretsRestored: number;
  unresolvedPlaceholders: string[];
}

const prepareFilesToRestore = async (
  tuckDir: string,
  paths?: string[]
): Promise<FileToRestore[]> => {
  const allFiles = await getAllTrackedFiles(tuckDir);
  const filesToRestore: FileToRestore[] = [];

  if (paths && paths.length > 0) {
    // Restore specific files
    for (const path of paths) {
      const expandedPath = expandPath(path);
      const collapsedPath = collapsePath(expandedPath);

      const tracked = await getTrackedFileBySource(tuckDir, collapsedPath);
      if (!tracked) {
        throw new FileNotFoundError(`Not tracked: ${path}`);
      }

      filesToRestore.push({
        id: tracked.id,
        source: tracked.file.source,
        destination: join(tuckDir, tracked.file.destination),
        category: tracked.file.category,
        existsAtTarget: await pathExists(expandedPath),
      });
    }
  } else {
    // Restore all files
    for (const [id, file] of Object.entries(allFiles)) {
      const targetPath = expandPath(file.source);
      filesToRestore.push({
        id,
        source: file.source,
        destination: join(tuckDir, file.destination),
        category: file.category,
        existsAtTarget: await pathExists(targetPath),
      });
    }
  }

  return filesToRestore;
};

const restoreFilesInternal = async (
  tuckDir: string,
  files: FileToRestore[],
  options: RestoreOptions
): Promise<RestoreResult> => {
  const config = await loadConfig(tuckDir);
  const useSymlink = options.symlink || config.files.strategy === 'symlink';
  const shouldBackup = options.backup ?? config.files.backupOnRestore;

  // Prepare hook options
  const hookOptions: HookOptions = {
    skipHooks: options.noHooks,
    trustHooks: options.trustHooks,
  };

  // Run pre-restore hook
  await runPreRestoreHook(tuckDir, hookOptions);

  let restoredCount = 0;
  const restoredPaths: string[] = [];

  for (const file of files) {
    const targetPath = expandPath(file.source);

    // Check if source exists in repository
    if (!(await pathExists(file.destination))) {
      logger.warning(`Source not found in repository: ${file.source}`);
      continue;
    }

    // Dry run - just show what would happen
    if (options.dryRun) {
      if (file.existsAtTarget) {
        logger.file('modify', `${file.source} (would overwrite)`);
      } else {
        logger.file('add', `${file.source} (would create)`);
      }
      continue;
    }

    // Create backup if needed
    if (shouldBackup && file.existsAtTarget) {
      await withSpinner(`Backing up ${file.source}...`, async () => {
        await createBackup(targetPath);
      });
    }

    // Restore file
    await withSpinner(`Restoring ${file.source}...`, async () => {
      if (useSymlink) {
        await createSymlink(file.destination, targetPath, { overwrite: true });
      } else {
        await copyFileOrDir(file.destination, targetPath, { overwrite: true });
      }

      // Fix permissions for sensitive files
      await fixSSHPermissions(file.source);
      await fixGPGPermissions(file.source);
    });

    restoredCount++;
    restoredPaths.push(targetPath);
  }

  // Restore secrets (replace placeholders with actual values)
  let secretsRestored = 0;
  let unresolvedPlaceholders: string[] = [];

  if (!options.noSecrets && !options.dryRun && restoredPaths.length > 0) {
    const secretCount = await getSecretCount(tuckDir);
    if (secretCount > 0) {
      const secretResult = await restoreSecrets(restoredPaths, tuckDir);
      secretsRestored = secretResult.totalRestored;
      unresolvedPlaceholders = secretResult.allUnresolved;
    }
  }

  // Run post-restore hook
  await runPostRestoreHook(tuckDir, hookOptions);

  return {
    restoredCount,
    secretsRestored,
    unresolvedPlaceholders,
  };
};

const runInteractiveRestore = async (tuckDir: string, options: RestoreOptions = {}): Promise<void> => {
  prompts.intro('tuck restore');

  // Get all tracked files
  const files = await prepareFilesToRestore(tuckDir);

  if (files.length === 0) {
    prompts.log.warning('No files to restore');
    prompts.note("Run 'tuck add <path>' to track files first", 'Tip');
    return;
  }

  // Let user select files to restore
  const fileOptions = files.map((file) => {
    const categoryConfig = CATEGORIES[file.category] || { icon: '📄' };
    const status = file.existsAtTarget ? c.yellow('(exists, will backup)') : '';

    return {
      value: file.id,
      label: `${categoryConfig.icon} ${file.source} ${status}`,
      hint: file.category,
    };
  });

  const selectedIds = await prompts.multiselect('Select files to restore:', fileOptions, {
    required: true,
  });

  if (selectedIds.length === 0) {
    prompts.cancel('No files selected');
    return;
  }

  const selectedFiles = files.filter((f) => selectedIds.includes(f.id));

  // Check for files that exist
  const existingFiles = selectedFiles.filter((f) => f.existsAtTarget);
  if (existingFiles.length > 0) {
    console.log();
    prompts.log.warning(
      `${existingFiles.length} file${existingFiles.length > 1 ? 's' : ''} will be backed up:`
    );
    existingFiles.forEach((f) => console.log(c.dim(`  ${f.source}`)));
    console.log();
  }

  // Ask about strategy
  const useSymlink = await prompts.select('Restore method:', [
    { value: false, label: 'Copy files', hint: 'Recommended' },
    { value: true, label: 'Create symlinks', hint: 'Files stay in tuck repo' },
  ]);

  // Confirm
  const confirm = await prompts.confirm(
    `Restore ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}?`,
    true
  );

  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Restore
  const result = await restoreFilesInternal(tuckDir, selectedFiles, {
    symlink: useSymlink as boolean,
    backup: true,
    noSecrets: options.noSecrets,
  });

  console.log();

  // Display secret restoration info
  if (result.secretsRestored > 0) {
    prompts.log.success(`Restored ${result.secretsRestored} secret${result.secretsRestored !== 1 ? 's' : ''}`);
  }
  if (result.unresolvedPlaceholders.length > 0) {
    prompts.log.warning(
      `${result.unresolvedPlaceholders.length} unresolved placeholder${result.unresolvedPlaceholders.length !== 1 ? 's' : ''}:`
    );
    result.unresolvedPlaceholders.slice(0, 5).forEach((p) => console.log(c.dim(`  {{${p}}}`)));
    if (result.unresolvedPlaceholders.length > 5) {
      console.log(c.dim(`  ... and ${result.unresolvedPlaceholders.length - 5} more`));
    }
    prompts.note("Use 'tuck secrets set <NAME>' to add missing secrets", 'Tip');
  }

  prompts.outro(`Restored ${result.restoredCount} file${result.restoredCount !== 1 ? 's' : ''}`);
};

/**
 * Display secret restoration summary
 */
const displaySecretSummary = (result: RestoreResult): void => {
  if (result.secretsRestored > 0) {
    logger.success(`Restored ${result.secretsRestored} secret${result.secretsRestored !== 1 ? 's' : ''}`);
  }
  if (result.unresolvedPlaceholders.length > 0) {
    logger.warning(
      `${result.unresolvedPlaceholders.length} unresolved placeholder${result.unresolvedPlaceholders.length !== 1 ? 's' : ''}:`
    );
    result.unresolvedPlaceholders.slice(0, 5).forEach((p) => console.log(c.dim(`  {{${p}}}`)));
    if (result.unresolvedPlaceholders.length > 5) {
      console.log(c.dim(`  ... and ${result.unresolvedPlaceholders.length - 5} more`));
    }
    logger.info("Use 'tuck secrets set <NAME>' to add missing secrets");
  }
};

/**
 * Run restore programmatically (exported for use by other commands)
 */
export const runRestore = async (options: RestoreOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Run interactive restore when called programmatically with --all
  if (options.all) {
    // Prepare files to restore
    const files = await prepareFilesToRestore(tuckDir, undefined);

    if (files.length === 0) {
      logger.warning('No files to restore');
      return;
    }

    // Restore files with progress
    const result = await restoreFilesInternal(tuckDir, files, options);

    logger.blank();
    displaySecretSummary(result);
    logger.success(`Restored ${result.restoredCount} file${result.restoredCount !== 1 ? 's' : ''}`);
  } else {
    await runInteractiveRestore(tuckDir, options);
  }
};

const runRestoreCommand = async (paths: string[], options: RestoreOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // If no paths and no --all, run interactive
  if (paths.length === 0 && !options.all) {
    await runInteractiveRestore(tuckDir, options);
    return;
  }

  // Prepare files to restore
  const files = await prepareFilesToRestore(tuckDir, options.all ? undefined : paths);

  if (files.length === 0) {
    logger.warning('No files to restore');
    return;
  }

  // Show what will be restored
  if (options.dryRun) {
    logger.heading('Dry run - would restore:');
  } else {
    logger.heading('Restoring:');
  }

  // Restore files
  const result = await restoreFilesInternal(tuckDir, files, options);

  logger.blank();

  if (options.dryRun) {
    logger.info(`Would restore ${files.length} file${files.length > 1 ? 's' : ''}`);
  } else {
    displaySecretSummary(result);
    logger.success(`Restored ${result.restoredCount} file${result.restoredCount !== 1 ? 's' : ''}`);
  }
};

export const restoreCommand = new Command('restore')
  .description('Restore dotfiles to the system')
  .argument('[paths...]', 'Paths to restore (or use --all)')
  .option('-a, --all', 'Restore all tracked files')
  .option('--symlink', 'Create symlinks instead of copies')
  .option('--backup', 'Backup existing files before restore')
  .option('--no-backup', 'Skip backup of existing files')
  .option('--dry-run', 'Show what would be done')
  .option('--no-hooks', 'Skip execution of pre/post restore hooks')
  .option('--trust-hooks', 'Trust and run hooks without confirmation (use with caution)')
  .option('--no-secrets', 'Skip restoring secrets (keep placeholders as-is)')
  .action(async (paths: string[], options: RestoreOptions) => {
    await runRestoreCommand(paths, options);
  });
