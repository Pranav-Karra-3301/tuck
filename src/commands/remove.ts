import { Command } from 'commander';
import { resolve } from 'path';
import { lstat, readlink } from 'fs/promises';
import { prompts, logger, withSpinner } from '../ui/index.js';
import {
  getTuckDir,
  expandPath,
  collapsePath,
  pathExists,
  validateSafeSourcePath,
  getSafeRepoPathFromDestination,
  validatePathWithinRoot,
} from '../lib/paths.js';
import { loadManifest, removeFileFromManifest, getAllTrackedFiles } from '../lib/manifest.js';
import { deleteFileOrDir, copyFileOrDir } from '../lib/files.js';
import { resolveLiveTarget } from '../lib/repoScope.js';
import { createSnapshot } from '../lib/timemachine.js';
import { undoBreadcrumb } from '../lib/undoHint.js';
import { NotInitializedError, FileNotTrackedError, BackupError } from '../errors.js';
import { setJsonMode, isJsonMode, emitJsonOk, addJsonWarning } from '../lib/jsonOutput.js';
import type { RemoveOptions, FileStrategy } from '../types.js';
import type { TrackedFileOutput } from '../schemas/manifest.schema.js';

interface FileToRemove {
  id: string;
  source: string;
  destination: string;
  strategy: FileStrategy;
  scope: 'home' | 'repo';
  /** The LIVE location on THIS machine, or null when a repo file is unbound. */
  liveTarget: string | null;
}

/** Build the removal descriptor for one manifest entry (resolving its live target). */
const toFileToRemove = async (
  id: string,
  file: TrackedFileOutput,
  tuckDir: string
): Promise<FileToRemove> => ({
  id,
  source: file.source,
  destination: getSafeRepoPathFromDestination(tuckDir, file.destination),
  strategy: file.strategy,
  scope: file.scope ?? 'home',
  liveTarget: await resolveLiveTarget(file),
});

const validateAndPrepareFiles = async (
  paths: string[],
  tuckDir: string
): Promise<FileToRemove[]> => {
  const entries = Object.entries(await getAllTrackedFiles(tuckDir));
  const filesToRemove: FileToRemove[] = [];

  for (const path of paths) {
    const expandedPath = expandPath(path);
    const collapsedPath = collapsePath(expandedPath);

    let matchId: string | undefined;
    let matchFile: TrackedFileOutput | undefined;
    for (const [id, file] of entries) {
      // Home-scoped identity match (also accepts the stored source verbatim).
      if (file.source === collapsedPath || file.source === path) {
        matchId = id;
        matchFile = file;
        break;
      }
      // Repo-scoped entries store `<repoKey>:<repoRelative>` as their source,
      // which no filesystem path equals. Match them by resolving the live target
      // on THIS machine and comparing real paths, so `tuck remove <live path>`
      // (the only non-interactive form) can untrack them.
      if (file.scope === 'repo') {
        const live = await resolveLiveTarget(file);
        if (live && resolve(live) === resolve(expandedPath)) {
          matchId = id;
          matchFile = file;
          break;
        }
      }
    }

    if (!matchId || !matchFile) {
      throw new FileNotTrackedError(path);
    }

    // Home sources are confined to $HOME; repo sources live under a repo root
    // (possibly outside home) and are validated by the manifest schema, not by
    // home-confinement (mirrors sync.ts).
    if (matchFile.scope !== 'repo') {
      validateSafeSourcePath(matchFile.source);
    }

    filesToRemove.push(await toFileToRemove(matchId, matchFile, tuckDir));
  }

  return filesToRemove;
};

/**
 * A symlink-strategy file leaves a symlink at the live path pointing into the
 * tuck repo copy. Before we untrack (and possibly delete the repo copy) we must
 * convert that symlink back into a real file, otherwise the live path becomes a
 * dangling symlink and the only copy of the content is destroyed.
 *
 * Returns true only when an actual repo-pointing symlink was materialized into a
 * real file. Leaves unrelated symlinks (targeting outside the repo) untouched.
 */
const restoreSymlinkedOriginal = async (
  file: FileToRemove,
  tuckDir: string
): Promise<boolean> => {
  if (file.strategy !== 'symlink' || !file.liveTarget) {
    return false;
  }

  let stat;
  try {
    stat = await lstat(file.liveTarget);
  } catch {
    return false; // live path already gone — nothing to restore
  }
  if (!stat.isSymbolicLink()) {
    return false;
  }

  // Only touch symlinks that point into OUR repo copy — never clobber a symlink
  // the user created themselves that happens to be tracked.
  let target: string;
  try {
    target = await readlink(file.liveTarget);
  } catch {
    return false;
  }
  // Reuse the canonical containment check (validatePathWithinRoot throws when a
  // path escapes the root) instead of re-implementing the resolve + startsWith
  // idiom here, so the rule lives in exactly one place.
  try {
    validatePathWithinRoot(target, tuckDir, 'symlink target');
  } catch {
    return false;
  }

  // The repo copy is the durable source of truth. Materialize it as a real file
  // at the live path (replacing the symlink) BEFORE any --delete removes it.
  if (!(await pathExists(file.destination))) {
    return false;
  }
  await deleteFileOrDir(file.liveTarget);
  await copyFileOrDir(file.destination, file.liveTarget, { overwrite: true });
  return true;
};

const removeFiles = async (
  filesToRemove: FileToRemove[],
  tuckDir: string,
  options: RemoveOptions
): Promise<void> => {
  // ONE snapshot covering every repo copy this run will delete, taken BEFORE
  // the loop — a per-file snapshot would leave the undo breadcrumb pointing at
  // a checkpoint that restores only the LAST file. A snapshot hiccup must not
  // block the removal.
  let snapshotId: string | undefined;
  if (options.delete) {
    const deletablePaths: string[] = [];
    for (const file of filesToRemove) {
      if (await pathExists(file.destination)) deletablePaths.push(file.destination);
    }
    if (deletablePaths.length > 0) {
      try {
        const snapshot = await createSnapshot(
          deletablePaths,
          `Pre-remove delete backup: ${filesToRemove.map((f) => f.source).join(', ')}`
        );
        snapshotId = snapshot.id;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Fail CLOSED: a destructive `--delete` must not proceed without a
        // recovery snapshot. Abort with a clear error unless the user explicitly
        // opted into `--force`, in which case proceed but surface a warning
        // (into the JSON envelope in --json mode) so the missing backup is never
        // silent.
        if (!options.force) {
          throw new BackupError(
            `Could not create a pre-delete backup snapshot: ${reason}. ` +
              'Refusing to delete without a recovery point.',
            ['Re-run with --force to delete anyway (no backup will be made)', 'Check available disk space']
          );
        }
        const warning =
          `Pre-delete snapshot failed (${reason}); proceeding without a backup because --force was given.`;
        if (isJsonMode()) addJsonWarning(warning);
        else logger.warning(warning);
      }
    }
  }

  for (const file of filesToRemove) {
    // Restore a symlinked original to a real file first (unless --keep-original),
    // so untracking + optional --delete can never leave a dangling symlink with
    // no content behind it.
    let restored = false;
    if (!options.keepOriginal) {
      restored = await restoreSymlinkedOriginal(file, tuckDir);
    }

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
      if (restored) {
        logger.dim('  Restored original file in place of the symlink');
      }
      if (options.delete) {
        logger.dim('  Also deleted from repository');
      }
    }
  }

  // Surface the recovery path after a destructive delete (IDEAS 6.5). Only shown
  // when --delete actually removed a repo copy we snapshotted — a plain untrack
  // leaves the repo copy intact, so `tuck undo` would not be the right recovery.
  if (!isJsonMode() && snapshotId) {
    logger.info(undoBreadcrumb(snapshotId));
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
  const filesToRemove: FileToRemove[] = [];
  for (const selected of selectedFiles) {
    const id = selected as string;
    const file = trackedFiles[id];
    // Repo-scoped sources are the `<repoKey>:<repoRelative>` identity, not a
    // filesystem path, so home-confinement would wrongly reject them (and throw
    // when tuck runs from a checkout outside $HOME).
    if (file.scope !== 'repo') {
      validateSafeSourcePath(file.source);
    }
    filesToRemove.push(await toFileToRemove(id, file, tuckDir));
  }

  // Remove files
  await removeFiles(filesToRemove, tuckDir, {
    delete: shouldDelete,
    keepOriginal: options.keepOriginal,
    force: options.force,
  });

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
  .option('--force', 'With --delete, proceed even if the pre-delete backup snapshot fails (no backup)')
  .option('--keep-original', "Don't restore symlinks to regular files")
  .option('--json', 'Emit JSON envelope to stdout (suppresses interactive UI)')
  .option('-y, --yes', 'Auto-confirm prompts (required with --json for the interactive picker)')
  .action(async (paths: string[], options: RemoveOptions) => {
    await runRemove(paths, options);
  });
