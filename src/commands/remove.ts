import { Command } from 'commander';
import { prompts, logger, withSpinner } from '../ui/index.js';
import {
  getTuckDir,
  expandPath,
  collapsePath,
  pathExists,
  validateSafeSourcePath,
  getSafeRepoPathFromDestination,
} from '../lib/paths.js';
import { loadManifest, removeFileFromManifest, getTrackedFileBySource, getAllTrackedFiles } from '../lib/manifest.js';
import { deleteFileOrDir } from '../lib/files.js';
import { NotInitializedError, FileNotTrackedError } from '../errors.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import type { RemoveOptions } from '../types.js';

interface FileToRemove {
  id: string;
  source: string;
  destination: string;
}

const validateAndPrepareFiles = async (
  paths: string[],
  tuckDir: string
): Promise<FileToRemove[]> => {
  const filesToRemove: FileToRemove[] = [];

  for (const path of paths) {
    const expandedPath = expandPath(path);
    const collapsedPath = collapsePath(expandedPath);

    // Check if tracked
    const tracked = await getTrackedFileBySource(tuckDir, collapsedPath);
    if (!tracked) {
      throw new FileNotTrackedError(path);
    }

    validateSafeSourcePath(tracked.file.source);

    filesToRemove.push({
      id: tracked.id,
      source: tracked.file.source,
      destination: getSafeRepoPathFromDestination(tuckDir, tracked.file.destination),
    });
  }

  return filesToRemove;
};

const removeFiles = async (
  filesToRemove: FileToRemove[],
  tuckDir: string,
  options: RemoveOptions
): Promise<void> => {
  for (const file of filesToRemove) {
    // Remove from manifest
    await removeFileFromManifest(tuckDir, file.id);

    // Delete from repository if requested
    if (options.delete) {
      if (await pathExists(file.destination)) {
        await withSpinner(`Deleting ${file.source} from repository...`, async () => {
          await deleteFileOrDir(file.destination);
        });
      }
    }

    if (!isJsonMode()) {
      logger.success(`Removed ${file.source} from tracking`);
      if (options.delete) {
        logger.dim('  Also deleted from repository');
      }
    }
  }
};

const runInteractiveRemove = async (tuckDir: string, options: RemoveOptions = {}): Promise<void> => {
  prompts.intro('tuck remove');

  // Get all tracked files
  const trackedFiles = await getAllTrackedFiles(tuckDir);
  const fileEntries = Object.entries(trackedFiles);

  if (fileEntries.length === 0) {
    prompts.log.warning('No files are currently tracked');
    prompts.outro('');
    return;
  }

  // Let user select files to remove
  const selectedFiles = await prompts.multiselect(
    'Select files to stop tracking:',
    fileEntries.map(([id, file]) => ({
      value: id,
      label: file.source,
      hint: file.category,
    })),
    { required: true }
  );

  if (selectedFiles.length === 0) {
    prompts.cancel('No files selected');
    return;
  }

  // Ask if they want to delete from repo
  const shouldDelete = options.yes ? !!options.delete : await prompts.confirm('Also delete files from repository?');

  // Confirm (skip the confirmation prompt when --yes is passed)
  if (!options.yes) {
    const confirm = await prompts.confirm(
      `Remove ${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} from tracking?`,
      true
    );

    if (!confirm) {
      prompts.cancel('Operation cancelled');
      return;
    }
  }

  // Prepare files to remove
  const filesToRemove: FileToRemove[] = selectedFiles.map((id) => {
    const file = trackedFiles[id as string];
    validateSafeSourcePath(file.source);
    return {
      id: id as string,
      source: file.source,
      destination: getSafeRepoPathFromDestination(tuckDir, file.destination),
    };
  });

  // Remove files
  await removeFiles(filesToRemove, tuckDir, { delete: shouldDelete });

  prompts.outro(`Removed ${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'}`);
  logger.info("Run 'tuck sync' to commit changes");
};

export const runRemove = async (paths: string[], options: RemoveOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck remove');
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  if (paths.length === 0) {
    // The interactive picker requires a TTY; the prompt guards refuse (throwing
    // a structured error) in JSON/non-TTY mode without explicit paths.
    await runInteractiveRemove(tuckDir, options);
    return;
  }

  // Validate and prepare files
  const filesToRemove = await validateAndPrepareFiles(paths, tuckDir);

  // Remove files
  await removeFiles(filesToRemove, tuckDir, options);

  if (isJsonMode()) {
    emitJsonOk({ removed: filesToRemove.map((f) => f.source) });
    return;
  }

  logger.blank();
  logger.success(`Removed ${filesToRemove.length} ${filesToRemove.length === 1 ? 'item' : 'items'} from tracking`);
  logger.info("Run 'tuck sync' to commit changes");
};

export const removeCommand = new Command('remove')
  .description('Stop tracking dotfiles')
  .argument('[paths...]', 'Paths to dotfiles to untrack')
  .option('--delete', 'Also delete from tuck repository')
  .option('--keep-original', "Don't restore symlinks to regular files")
  .option('--json', 'Emit JSON envelope to stdout (suppresses interactive UI)')
  .option('-y, --yes', 'Auto-confirm prompts (required with --json for the interactive picker)')
  .action(async (paths: string[], options: RemoveOptions) => {
    await runRemove(paths, options);
  });
