import { Command } from 'commander';
import { prompts, logger, colors as c } from '../ui/index.js';
import { collapsePath } from '../lib/paths.js';
import {
  listSnapshots,
  getSnapshot,
  getLatestSnapshot,
  restoreSnapshot,
  restoreFileFromSnapshot,
  deleteSnapshot,
  getSnapshotsSize,
  formatSnapshotSize,
  formatSnapshotDate,
  Snapshot,
} from '../lib/timemachine.js';

export interface UndoOptions {
  list?: boolean;
  latest?: boolean;
  file?: string;
  delete?: string;
  force?: boolean;
  dryRun?: boolean;
}

/**
 * Display a list of available snapshots
 */
const showSnapshotList = async (): Promise<void> => {
  const snapshots = await listSnapshots();

  if (snapshots.length === 0) {
    logger.warning('No backup snapshots found');
    logger.dim('Snapshots are created automatically when using `tuck apply`');
    return;
  }

  logger.heading('Backup Snapshots:');
  logger.blank();

  for (const snapshot of snapshots) {
    const date = formatSnapshotDate(snapshot.id);
    const fileCount = snapshot.files.filter((f) => f.existed).length;

    console.log(c.cyan(`  ${snapshot.id}`));
    console.log(c.dim(`    Date:    ${date}`));
    console.log(c.dim(`    Reason:  ${snapshot.reason}`));
    console.log(c.dim(`    Files:   ${fileCount} file(s) backed up`));
    console.log(c.dim(`    Machine: ${snapshot.machine}`));
    console.log();
  }

  const totalSize = await getSnapshotsSize();
  logger.dim(`Total backup size: ${formatSnapshotSize(totalSize)}`);
  logger.blank();
  logger.info('To restore a snapshot: tuck undo <snapshot-id>');
  logger.info('To restore the latest:  tuck undo --latest');
};

/**
 * Display details of a specific snapshot
 */
const showSnapshotDetails = (snapshot: Snapshot): void => {
  console.log();
  console.log(c.bold('Snapshot Details:'));
  console.log(c.dim(`  ID:      ${snapshot.id}`));
  console.log(c.dim(`  Date:    ${formatSnapshotDate(snapshot.id)}`));
  console.log(c.dim(`  Reason:  ${snapshot.reason}`));
  console.log(c.dim(`  Machine: ${snapshot.machine}`));
  console.log();
  console.log(c.bold('Files in snapshot:'));

  for (const file of snapshot.files) {
    if (file.existed) {
      console.log(c.dim(`  ok ${collapsePath(file.originalPath)}`));
    } else {
      console.log(c.dim(`  - ${collapsePath(file.originalPath)} (did not exist)`));
    }
  }
  console.log();
};

/**
 * Restore from a specific snapshot
 */
const restoreFromSnapshot = async (snapshotId: string, options: UndoOptions): Promise<void> => {
  const snapshot = await getSnapshot(snapshotId);

  if (!snapshot) {
    logger.error(`Snapshot not found: ${snapshotId}`);
    const snapshots = await listSnapshots();
    if (snapshots.length > 0) {
      logger.info('Available snapshots:');
      for (const s of snapshots.slice(0, 5)) {
        logger.dim(`  ${s.id} - ${formatSnapshotDate(s.id)}`);
      }
      if (snapshots.length > 5) {
        logger.dim(`  ... and ${snapshots.length - 5} more`);
      }
    }
    return;
  }

  // Show snapshot details
  showSnapshotDetails(snapshot);

  // Confirm unless --force or dry-run
  if (!options.force && !options.dryRun) {
    const backedUpCount = snapshot.files.filter((f) => f.existed).length;
    const confirmed = await prompts.confirm(
      `Restore ${backedUpCount} file(s) from this snapshot?`,
      true
    );

    if (!confirmed) {
      logger.info('Restore cancelled');
      return;
    }
  }

  // Dry run
  if (options.dryRun) {
    logger.heading('Dry run - would restore:');
    for (const file of snapshot.files) {
      if (file.existed) {
        logger.file('modify', collapsePath(file.originalPath));
      } else {
        logger.file('delete', `${collapsePath(file.originalPath)} (would remove)`);
      }
    }
    return;
  }

  // Restore
  logger.info('Restoring files...');
  const restoredFiles = await restoreSnapshot(snapshotId);

  logger.blank();
  logger.success(`Restored ${restoredFiles.length} file(s)`);

  for (const file of restoredFiles) {
    logger.dim(`  ok ${collapsePath(file)}`);
  }
};

/**
 * Restore a single file from a snapshot
 */
const restoreSingleFile = async (
  snapshotId: string,
  filePath: string,
  options: UndoOptions
): Promise<void> => {
  const snapshot = await getSnapshot(snapshotId);

  if (!snapshot) {
    logger.error(`Snapshot not found: ${snapshotId}`);
    return;
  }

  // Dry run
  if (options.dryRun) {
    logger.info(`Would restore ${filePath} from snapshot ${snapshotId}`);
    return;
  }

  // Restore the file
  await restoreFileFromSnapshot(snapshotId, filePath);
  logger.success(`Restored ${filePath}`);
};

/**
 * Delete a snapshot
 */
const removeSnapshot = async (snapshotId: string, options: UndoOptions): Promise<void> => {
  const snapshot = await getSnapshot(snapshotId);

  if (!snapshot) {
    logger.error(`Snapshot not found: ${snapshotId}`);
    return;
  }

  // Confirm unless --force
  if (!options.force) {
    showSnapshotDetails(snapshot);
    const confirmed = await prompts.confirm('Delete this snapshot permanently?', false);

    if (!confirmed) {
      logger.info('Deletion cancelled');
      return;
    }
  }

  await deleteSnapshot(snapshotId);
  logger.success(`Deleted snapshot: ${snapshotId}`);
};

/**
 * Interactive undo selection
 */
const runInteractiveUndo = async (): Promise<void> => {
  prompts.intro('tuck undo');

  const snapshots = await listSnapshots();

  if (snapshots.length === 0) {
    prompts.log.warning('No backup snapshots available');
    prompts.note('Snapshots are created when using `tuck apply`', 'Info');
    return;
  }

  // Let user select a snapshot
  const snapshotOptions = snapshots.map((s) => ({
    value: s.id,
    label: `${s.id} - ${s.reason.slice(0, 40)}${s.reason.length > 40 ? '...' : ''}`,
    hint: `${s.files.filter((f) => f.existed).length} files`,
  }));

  const selectedId = await prompts.select('Select a snapshot to restore:', snapshotOptions);

  const snapshot = await getSnapshot(selectedId);
  if (!snapshot) {
    prompts.log.error('Snapshot not found');
    return;
  }

  // Show what will be restored
  console.log();
  prompts.log.info('Files in this snapshot:');
  for (const file of snapshot.files.slice(0, 10)) {
    if (file.existed) {
      console.log(c.dim(`  ${collapsePath(file.originalPath)}`));
    }
  }
  if (snapshot.files.length > 10) {
    console.log(c.dim(`  ... and ${snapshot.files.length - 10} more`));
  }
  console.log();

  // Confirm
  const confirmed = await prompts.confirm('Restore these files?', true);

  if (!confirmed) {
    prompts.cancel('Restore cancelled');
    return;
  }

  // Restore
  const spinner = prompts.spinner();
  spinner.start('Restoring files...');

  const restoredFiles = await restoreSnapshot(selectedId);

  spinner.stop(`Restored ${restoredFiles.length} files`);

  prompts.outro('Done!');
};

/**
 * Main undo command handler
 */
const runUndo = async (snapshotId: string | undefined, options: UndoOptions): Promise<void> => {
  // Handle --list
  if (options.list) {
    await showSnapshotList();
    return;
  }

  // Handle --delete
  if (options.delete) {
    await removeSnapshot(options.delete, options);
    return;
  }

  // Handle --latest
  if (options.latest) {
    const latest = await getLatestSnapshot();
    if (!latest) {
      logger.warning('No backup snapshots available');
      return;
    }
    await restoreFromSnapshot(latest.id, options);
    return;
  }

  // Handle specific snapshot ID
  if (snapshotId) {
    // Check if we're restoring a single file
    if (options.file) {
      await restoreSingleFile(snapshotId, options.file, options);
    } else {
      await restoreFromSnapshot(snapshotId, options);
    }
    return;
  }

  // No arguments - run interactive mode
  await runInteractiveUndo();
};

export const undoCommand = new Command('undo')
  .description('Restore files from a Time Machine backup snapshot')
  .argument('[snapshot-id]', 'Snapshot ID to restore (format: YYYY-MM-DD-HHMMSS)')
  .option('-l, --list', 'List all available backup snapshots')
  .option('--latest', 'Restore the most recent snapshot')
  .option('--file <path>', 'Restore a single file from the snapshot')
  .option('--delete <id>', 'Delete a specific snapshot')
  .option('-f, --force', 'Skip confirmation prompts')
  .option('--dry-run', 'Show what would be restored without making changes')
  .action(async (snapshotId: string | undefined, options: UndoOptions) => {
    await runUndo(snapshotId, options);
  });
