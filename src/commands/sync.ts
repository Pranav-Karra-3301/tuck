import { Command } from 'commander';
import { join, basename, relative, isAbsolute } from 'path';
import { realpath } from 'fs/promises';
import { prompts, logger, withSpinner, colors as c } from '../ui/index.js';
import {
  getTuckDir,
  expandPath,
  pathExists,
  collapsePath,
  isDirectory,
  validateSafeSourcePath,
  validateSafeManifestDestination,
  validatePathWithinRoot,
} from '../lib/paths.js';
import {
  loadManifest,
  getAllTrackedFiles,
  updateFileInManifest,
  removeFileFromManifest,
  buildSourceIndex,
  clearManifestCache,
} from '../lib/manifest.js';
import { stageAll, commit, getStatus, push, hasRemote, fetch, pull } from '../lib/git.js';
import {
  detectConflicts,
  applyResolution,
  continueRebase,
  abortRebase,
  type FileConflict,
} from '../lib/mergeConflicts.js';
import { resolveConflictsInteractively } from '../ui/merge.js';
import { createSnapshot } from '../lib/timemachine.js';
import { resolveLiveTarget } from '../lib/repoScope.js';
import { isJsonMode } from '../lib/jsonOutput.js';
import {
  copyFileOrDir,
  getFileChecksum,
  deleteFileOrDir,
  checkFileSizeThreshold,
  formatFileSize,
  SIZE_BLOCK_THRESHOLD,
} from '../lib/files.js';
import { addToTuckignore, loadTuckignore, isIgnoredInSet } from '../lib/tuckignore.js';
import { checkLocalMode } from '../lib/remoteChecks.js';
import { loadConfig } from '../lib/config.js';
import { assertRemoteAvailable } from '../lib/providers/index.js';
import { runPreSyncHook, runPostSyncHook, type HookOptions } from '../lib/hooks.js';
import { NotInitializedError, SecretsDetectedError, MergeConflictsError } from '../errors.js';
import { setJsonMode, emitJsonOk, addJsonWarning } from '../lib/jsonOutput.js';
import type { SyncOptions, FileChange } from '../types.js';
import { detectDotfiles, DETECTION_CATEGORIES, type DetectedFile } from '../lib/detect.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { preparePathsForTracking } from '../lib/trackPipeline.js';
import {
  scanForSecrets,
  isSecretScanningEnabled,
  shouldBlockOnSecrets,
  processSecretsForRedaction,
  redactFile,
  type SecretMatch,
} from '../lib/secrets/index.js';
import { displayScanResults } from './secrets.js';
import { logForceSecretBypass } from '../lib/audit.js';

interface SyncResult {
  modified: string[];
  deleted: string[];
  commitHash?: string;
  // Note: There is no 'added' array because adding new files is done via 'tuck add', not 'tuck sync'.
  // The sync command only handles changes to already-tracked files.
}

/**
 * A {@link FileChange} that also carries the manifest `id` it was derived from.
 *
 * detectChanges already knows each change's manifest id while iterating the
 * tracked-files map, so it stamps it here. syncFiles can then update/remove the
 * right manifest entry in O(1) instead of re-loading the whole map and doing a
 * linear `Object.values(...).find(f => f.source === change.source)` per change
 * (which was O(changes × tracked)). `id` is optional so changes constructed
 * elsewhere remain assignable; syncFiles falls back to the old lookup when it's
 * absent.
 */
type TrackedFileChange = FileChange & { id?: string };

/**
 * A pending secret redaction for one LIVE file (issue #100 RC5). Built when the
 * user picks the 'redact' action in {@link scanAndHandleSecrets} and applied by
 * {@link syncFiles} to the REPO copy right after it is written — the live file
 * is never rewritten. For a tracked DIRECTORY, `livePath` points at the inner
 * file that holds the secret.
 */
interface RedactionPlan {
  livePath: string;
  matches: SecretMatch[];
  placeholderMap: Map<string, string>;
}

const pathsResolveToSameLocation = async (sourcePath: string, destinationPath: string): Promise<boolean> => {
  try {
    const [resolvedSource, resolvedDestination] = await Promise.all([
      realpath(sourcePath),
      realpath(destinationPath),
    ]);
    return resolvedSource === resolvedDestination;
  } catch {
    return false;
  }
};

const detectChanges = async (tuckDir: string): Promise<TrackedFileChange[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  const ignoredPaths = await loadTuckignore(tuckDir);
  const changes: TrackedFileChange[] = [];

  for (const [id, file] of Object.entries(files)) {
    // Home-scoped sources are confined to $HOME; repo-scoped sources live under a
    // (possibly out-of-home) repo root, so they are validated by their repoRelative
    // safety in the manifest schema, not by validateSafeSourcePath.
    if (file.scope !== 'repo') {
      validateSafeSourcePath(file.source);
    }
    validateSafeManifestDestination(file.destination);

    // Template/encrypted files are ONE-DIRECTIONAL: the repo holds the SOURCE
    // (template text / ciphertext) and the live file is a derived artifact
    // (rendered / decrypted). Capturing the live file back into the repo would
    // destroy the template source or write plaintext secrets — so sync NEVER
    // captures these. Update them by editing the repo source and running
    // `tuck apply`. (`tuck status` reports their real drift via the state model.)
    if (file.template || file.encrypted) {
      logger.debug?.(
        `sync: skipping one-directional ${file.template ? 'template' : 'encrypted'} file ${file.source}`
      );
      continue;
    }

    // Skip if in .tuckignore
    if (ignoredPaths.has(file.source)) {
      continue;
    }

    // Resolve the LIVE location on THIS machine. For home files this is
    // expandPath(source); for repo files it is the bound repo root joined with
    // repoRelative, or null when the repo is not bound here.
    const sourcePath = await resolveLiveTarget(file);

    // CRITICAL: an unbound repo file (null live target) must be SKIPPED — never
    // reported as 'deleted'. Treating it as deleted would drop the committed copy
    // and remove it from the shared manifest just because this machine hasn't
    // linked the repo.
    if (sourcePath === null) {
      continue;
    }

    // Check if source still exists
    if (!(await pathExists(sourcePath))) {
      changes.push({
        path: file.source,
        status: 'deleted',
        source: file.source,
        destination: file.destination,
        id,
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
          id,
        });
      }
    } catch {
      changes.push({
        path: file.source,
        status: 'modified',
        source: file.source,
        destination: file.destination,
        id,
      });
    }
  }

  return changes;
};

/**
 * Map the modified changes to their LIVE source paths on this machine, resolving
 * repo-scoped entries through the repo registry (so the secret scanner reads the
 * real checkout, not a "key:rel" pseudo-path). Unbound repo files resolve to null
 * and are dropped from the result.
 */
const resolveModifiedChangeTargets = async (
  tuckDir: string,
  changes: FileChange[]
): Promise<Array<{ change: FileChange; live: string }>> => {
  const trackedFiles = await getAllTrackedFiles(tuckDir);
  const targets: Array<{ change: FileChange; live: string }> = [];
  for (const change of changes) {
    if (change.status !== 'modified') continue;
    const entry = Object.values(trackedFiles).find((f) => f.source === change.source);
    const live = entry ? await resolveLiveTarget(entry) : expandPath(change.source);
    if (live !== null) targets.push({ change, live });
  }
  return targets;
};

const resolveModifiedLivePaths = async (
  tuckDir: string,
  changes: FileChange[]
): Promise<string[]> => {
  const targets = await resolveModifiedChangeTargets(tuckDir, changes);
  return targets.map((t) => t.live);
};

/**
 * Snapshot every tracked file's source path before a potentially destructive
 * pull. Failures here are non-fatal — we'd rather attempt the pull and warn
 * than block sync entirely on a backup hiccup.
 */
const snapshotBeforePull = async (tuckDir: string, reason: string): Promise<void> => {
  try {
    const tracked = await getAllTrackedFiles(tuckDir);
    // Resolve LIVE paths; drop unbound repo files (null) so we never snapshot a
    // bogus "key:rel" pseudo-path for a repo this machine hasn't linked.
    const resolved = await Promise.all(
      Object.values(tracked).map((f) => resolveLiveTarget(f))
    );
    const sources = resolved.filter((p): p is string => p !== null);
    if (sources.length === 0) return;
    await createSnapshot(sources, reason);
  } catch (error) {
    logger.dim(
      `Pre-pull snapshot skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Drive the interactive conflict-resolution flow after a failed pull. Returns
 * one of:
 *   - `{ resolved: true }`  conflicts were resolved and the rebase continued.
 *   - `{ resolved: false, aborted: true }`  user aborted; rebase rolled back.
 *
 * Any exception thrown is propagated to the caller for surfacing.
 */
const resolveConflictsInline = async (
  tuckDir: string,
  conflicts: FileConflict[]
): Promise<{ resolved: boolean; aborted: boolean }> => {
  const resolutions = await resolveConflictsInteractively(conflicts);

  const aborted = resolutions.some((r) => r.choice === 'abort');
  if (aborted) {
    await abortRebase(tuckDir);
    return { resolved: false, aborted: true };
  }

  for (const resolution of resolutions) {
    await applyResolution(tuckDir, resolution);
  }

  await continueRebase(tuckDir);
  return { resolved: true, aborted: false };
};

/**
 * Pull from remote if behind, returns info about what happened.
 *
 * When `git pull --rebase` runs into per-file conflicts the rebase stops with
 * a non-zero exit and the index is left with conflict markers. This function
 * detects that case via {@link detectConflicts} and either:
 *   - escalates a {@link MergeConflictsError} in non-interactive / JSON mode,
 *   - or drives the interactive resolution UI before completing the rebase.
 */
const pullIfBehind = async (
  tuckDir: string,
  options: SyncOptions = {}
): Promise<{ pulled: boolean; behind: number; error?: string; resolvedConflicts?: string[] }> => {
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

    // Snapshot tracked sources before a potentially-destructive pull so users
    // can roll back if anything goes sideways during merge.
    await snapshotBeforePull(tuckDir, 'Pre-sync pull backup');

    // Pull with rebase to keep history clean
    try {
      await pull(tuckDir, { rebase: true });
      // The rebase rewrote .tuckmanifest.json out-of-band; drop the cached copy
      // so the rest of this run (and change detection) sees the pulled state.
      clearManifestCache();
      return { pulled: true, behind: status.behind };
    } catch (pullError) {
      // A failed pull --rebase may have left conflicts staged in the index.
      // If it didn't, this is just a regular git error and we re-throw.
      const conflicts = await detectConflicts(tuckDir);
      if (conflicts.length === 0) {
        throw pullError;
      }

      // Non-interactive / JSON callers cannot drive the resolution UI. Throw
      // a structured error so agents can detect and report it via the JSON
      // envelope.
      const nonInteractive = options.json === true || options.yes === true || isJsonMode();
      if (nonInteractive) {
        // Abort the in-progress rebase BEFORE throwing so ~/.tuck is left in a
        // clean state — an automated/JSON caller cannot resolve conflicts, and
        // leaving a half-finished rebase behind would wedge every subsequent
        // git operation. The pre-pull snapshot already captured the live files
        // so nothing is lost. If the abort itself fails we surface that too
        // rather than masking it behind the conflict error.
        try {
          await abortRebase(tuckDir);
        } catch (abortError) {
          const abortMsg =
            abortError instanceof Error ? abortError.message : String(abortError);
          logger.dim(`Could not abort in-progress rebase automatically: ${abortMsg}`);
        }
        // The dedicated exit code (3) + stable MERGE_CONFLICTS code + recovery
        // suggestions let agents detect and report this via the JSON envelope.
        throw new MergeConflictsError(conflicts.map((c) => c.path));
      }

      const outcome = await resolveConflictsInline(tuckDir, conflicts);
      if (outcome.aborted) {
        return {
          pulled: false,
          behind: status.behind,
          error: 'Pull aborted by user during conflict resolution',
        };
      }

      // Snapshot post-resolution state too so the user has a checkpoint of the
      // exact tree that survived the merge.
      await snapshotBeforePull(tuckDir, 'Post-sync conflict resolution');

      // Conflict resolution rewrote tracked files / the manifest; drop the cache.
      clearManifestCache();

      return {
        pulled: true,
        behind: status.behind,
        resolvedConflicts: conflicts.map((c) => c.path),
      };
    }
  } catch (error) {
    if (error instanceof MergeConflictsError) {
      throw error;
    }
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

  // Build the "already tracked?" lookup ONCE (O(tracked)) instead of calling the
  // O(N) getTrackedFileBySource per detected file (which was O(detected × tracked)),
  // and load .tuckignore ONCE up front instead of re-reading it per detected file.
  const sourceIndex = await buildSourceIndex(tuckDir);
  const ignoredPaths = await loadTuckignore(tuckDir);

  // Filter out already-tracked files, ignored files, and excluded patterns
  const newFiles: DetectedFile[] = [];

  for (const file of detected) {
    // Skip if already tracked (O(1) map lookup, same answer as getTrackedFileBySource).
    if (sourceIndex.has(file.path)) continue;

    // Skip if in .tuckignore (same normalization as isIgnored, no per-file disk read).
    if (isIgnoredInSet(ignoredPaths, file.path)) continue;

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
  changes: TrackedFileChange[],
  options: SyncOptions,
  redactionPlans: RedactionPlan[] = []
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

  // Load the tracked-files map ONCE up front. The old loop re-read it per change
  // (twice each: once to home-confine the source, once inside the modified/
  // deleted branch to recover the file id), turning id recovery into an
  // O(changes × tracked) linear scan. We index by source for O(1) lookups and
  // prefer the id already stamped on the change by detectChanges.
  const trackedFiles = await getAllTrackedFiles(tuckDir);
  const bySource = new Map<string, { id: string; file: (typeof trackedFiles)[string] }>();
  for (const [id, file] of Object.entries(trackedFiles)) {
    bySource.set(file.source, { id, file });
  }

  // Process each change
  for (const change of changes) {
    if (!change.destination) {
      throw new Error(`Unsafe manifest entry detected: missing destination for ${change.source}`);
    }
    validateSafeManifestDestination(change.destination);

    // Resolve the tracked entry + its id via the prebuilt index. Prefer the id
    // carried on the change (set by detectChanges); fall back to the source
    // lookup for changes constructed elsewhere.
    const indexed = bySource.get(change.source);
    const trackedEntry = indexed?.file;
    const fileId = change.id ?? indexed?.id;

    if (trackedEntry?.scope !== 'repo') {
      validateSafeSourcePath(change.source);
    }

    // Resolve the live path from the tracked entry (repo root + repoRelative for
    // repo files, expandPath for home files). Falls back to expandPath when the
    // entry is unexpectedly absent.
    const sourcePath = trackedEntry
      ? await resolveLiveTarget(trackedEntry)
      : expandPath(change.source);

    // An unbound repo source (null) can't be synced — skip it defensively. In
    // practice detectChanges already filters these out before we get here.
    if (sourcePath === null) {
      continue;
    }

    const destPath = join(tuckDir, change.destination);
    validatePathWithinRoot(destPath, tuckDir, 'sync destination');

    if (change.status === 'modified') {
      // Redaction plans whose live file is this change's source, or lies inside
      // it (a tracked DIRECTORY whose inner file holds the secret). Compared on
      // expanded absolute paths.
      const expandedSourcePath = expandPath(sourcePath);
      const plansForChange = redactionPlans.filter((plan) => {
        const liveAbs = expandPath(plan.livePath);
        if (liveAbs === expandedSourcePath) return true;
        const rel = relative(expandedSourcePath, liveAbs);
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      });

      await withSpinner(`Syncing ${change.path}...`, async () => {
        // Symlink tracking can make source and destination the same underlying file.
        // Skip copying in that case to avoid same-file copy errors.
        if (!(await pathsResolveToSameLocation(sourcePath, destPath))) {
          // fs-extra copy MERGES directory trees — it overwrites matching files
          // but never removes destination files that were deleted from the live
          // source. Left as a merge, a deletion inside a tracked directory would
          // never propagate to the repo, the stored checksum would never match
          // the live tree (so sync churns forever), and `tuck apply` would
          // resurrect the deleted file elsewhere. Mirror instead: clear the
          // destination first so the copy reproduces the source exactly.
          // isDirectory is false when the source has vanished, so we never wipe
          // the repo copy without a fresh source to replace it.
          if (await isDirectory(sourcePath)) {
            await deleteFileOrDir(destPath);
          }
          await copyFileOrDir(sourcePath, destPath, { overwrite: true });

          // Repo-only redaction (issue #100 RC5): apply the placeholders to the
          // REPO copy that was just written — never to the live file. This runs
          // BEFORE the checksum below so the manifest records the redacted
          // content that sync will stage.
          try {
            for (const plan of plansForChange) {
              const liveAbs = expandPath(plan.livePath);
              const repoTarget =
                liveAbs === expandedSourcePath
                  ? destPath
                  : join(destPath, relative(expandedSourcePath, liveAbs));
              validatePathWithinRoot(repoTarget, tuckDir, 'sync redaction target');
              // An inner file excluded from the directory copy never reached the
              // repo: there is no repo copy to redact and its secret was never
              // written. Skip the plan; only real failures below are fatal.
              if (!(await pathExists(repoTarget))) {
                logger.debug?.(
                  `sync: skipping redaction plan for ${collapsePath(plan.livePath)}: no repo copy at ${repoTarget} (excluded from copy)`
                );
                continue;
              }
              await redactFile(repoTarget, plan.matches, plan.placeholderMap);
            }
          } catch (redactionError) {
            // A failed plan must never leave the freshly-copied destination in
            // the repo working tree: it still holds CLEARTEXT secrets, and
            // sync's stageAll would commit it. Delete it and fail this file's
            // sync loudly — the manifest checksum below is never recorded.
            try {
              await deleteFileOrDir(destPath);
            } catch (cleanupError) {
              const redactMsg =
                redactionError instanceof Error ? redactionError.message : String(redactionError);
              const cleanupMsg =
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
              throw new Error(
                `Redaction of the repository copy failed (${redactMsg}) and removing the ` +
                  `cleartext copy also failed (${cleanupMsg}). Remove ${destPath} manually ` +
                  `before running 'tuck sync' again.`
              );
            }
            throw redactionError;
          }
        } else if (plansForChange.length > 0) {
          // A symlink-tracked file: the live file and the repo copy are the SAME
          // inode, so redacting the repo copy would rewrite the user's live
          // config — exactly what issue #100 forbids. Its secrets are already in
          // the repo working tree; warn, but do not fail the sync.
          logger.warning(
            `Cannot redact ${change.path}: it is symlink-tracked, so its live file IS the repo copy ` +
              `and its secrets are already in the repo working tree. Re-track it with the copy ` +
              `strategy ('tuck remove' then 'tuck add' without --symlink) to enable repo-only redaction.`
          );
        }

        // Update checksum in manifest using the id resolved above.
        const newChecksum = await getFileChecksum(destPath);

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
        // Safety: never delete the repo copy without a recoverable backup first.
        // The live source is already gone (that is what marked this 'deleted'),
        // so the ONLY surviving copy may be this repo file — e.g. an initial
        // `tuck add` that was never committed, or a tracked file whose parent
        // volume is temporarily unmounted. Snapshot the REPO copy (destPath)
        // into the time-machine so `tuck undo` can recover it. Failures here are
        // non-fatal, but must not silently proceed to an unrecoverable delete.
        try {
          await createSnapshot([destPath], `Pre-sync delete backup: ${change.path}`);
        } catch (error) {
          logger.dim(
            `Pre-delete snapshot skipped: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // Delete the file from the tuck repository
        await deleteFileOrDir(destPath);

        // Remove from manifest using the id resolved above.
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
 * Scan modified files for secrets and handle user interaction.
 *
 * Returns `proceed: false` when the sync should abort. When the user picks the
 * 'redact' action, the detected secrets are stored locally and returned as
 * {@link RedactionPlan}s — the placeholders are applied to the REPO copies by
 * {@link syncFiles} during this sync; the LIVE files are never rewritten
 * (issue #100 RC5).
 */
const scanAndHandleSecrets = async (
  tuckDir: string,
  changes: FileChange[],
  options: SyncOptions
): Promise<{ proceed: boolean; redactionPlans: RedactionPlan[] }> => {
  // Skip if force flag is set (but require confirmation first)
  if (options.force) {
    const confirmed = await prompts.confirmDangerous(
      'Using --force bypasses secret scanning.\n' +
        'Any secrets in modified files may be committed to git and potentially exposed.',
      'force'
    );
    if (!confirmed) {
      logger.info('Sync cancelled');
      return { proceed: false, redactionPlans: [] };
    }
    logger.warning('Secret scanning bypassed with --force');
    // Audit log for security tracking
    await logForceSecretBypass('tuck sync --force', changes.length);
    return { proceed: true, redactionPlans: [] };
  }

  // Check if scanning is enabled in config
  const scanningEnabled = await isSecretScanningEnabled(tuckDir);
  if (!scanningEnabled) {
    return { proceed: true, redactionPlans: [] };
  }

  // Resolve modified changes to their LIVE paths (repo-scoped entries via the
  // repo registry), keeping the change association so the 'ignore' action can map
  // a scan result back to the right change regardless of scope.
  const targets = await resolveModifiedChangeTargets(tuckDir, changes);

  if (targets.length === 0) {
    return { proceed: true, redactionPlans: [] };
  }

  const modifiedPaths = targets.map((t) => t.live);

  // Scan files
  const spinner = prompts.spinner();
  spinner.start('Scanning for secrets...');
  const summary = await scanForSecrets(modifiedPaths, tuckDir);
  spinner.stop('Scan complete');

  if (summary.totalSecrets === 0) {
    return { proceed: true, redactionPlans: [] };
  }

  // Display results
  displayScanResults(summary);

  // Prompt user for action
  const action = await prompts.select('What would you like to do?', [
    { value: 'abort', label: 'Abort sync' },
    { value: 'redact', label: 'Redact secrets (placeholders in repo copy; live file untouched)' },
    { value: 'ignore', label: 'Add files to .tuckignore and skip them' },
    { value: 'proceed', label: 'Proceed anyway (secrets will be committed)' },
  ]);

  if (action === 'abort') {
    prompts.cancel('Sync aborted - secrets detected');
    return { proceed: false, redactionPlans: [] };
  }

  if (action === 'redact') {
    // Store the secrets locally and BUILD redaction plans. The placeholders are
    // applied to the REPO copies as syncFiles writes them — the live files are
    // never rewritten (issue #100 RC5).
    const spinner = prompts.spinner();
    spinner.start('Storing secrets for redaction...');

    try {
      // Process secrets: store them and get placeholder mappings
      const fileRedactionMaps = await processSecretsForRedaction(summary.results, tuckDir);

      const redactionPlans: RedactionPlan[] = [];
      for (const result of summary.results) {
        const placeholderMap = fileRedactionMaps.get(result.path);
        if (placeholderMap && placeholderMap.size > 0) {
          redactionPlans.push({
            livePath: result.path,
            matches: result.matches,
            placeholderMap,
          });
        }
      }

      spinner.stop(
        `Stored secrets from ${redactionPlans.length} file${redactionPlans.length !== 1 ? 's' : ''}`
      );
      prompts.log.success(
        'Secrets stored locally — the repository copy gets placeholders during this sync'
      );
      prompts.log.info('Your live files are left untouched');
      prompts.note("Use 'tuck secrets list' to see stored secrets", 'Tip');
      return { proceed: true, redactionPlans };
    } catch (error) {
      spinner.stop('Redaction failed');
      prompts.log.error(error instanceof Error ? error.message : String(error));
      return { proceed: false, redactionPlans: [] };
    }
  }

  if (action === 'ignore') {
    // Match each secret-bearing scan result back to its change via the resolved
    // LIVE path. Matching on expandPath(c.source) is wrong for repo-scoped files
    // (source is the `<repoKey>:<repoRelative>` identity, which expandPath
    // resolves against cwd — never the real checkout path), so those changes
    // silently escaped both the .tuckignore write AND the filter and were
    // committed anyway. detectChanges keys .tuckignore on change.source, so that
    // is the correct value to record for BOTH scopes.
    const secretLivePaths = new Set(
      summary.results.filter((r) => r.hasSecrets).map((r) => r.path)
    );
    const sourcesToRemove = new Set<string>();
    for (const { change, live } of targets) {
      if (!secretLivePaths.has(live)) continue;
      sourcesToRemove.add(change.source);
      await addToTuckignore(tuckDir, change.source);
      logger.dim(`Added ${collapsePath(live)} to .tuckignore`);
    }
    // Filter out ignored files from changes list
    // Note: This intentionally mutates the 'changes' array in place so callers see the filtered list
    changes.splice(
      0,
      changes.length,
      ...changes.filter((c) => !sourcesToRemove.has(c.source))
    );

    if (changes.length === 0) {
      prompts.log.info('No remaining changes to sync');
      return { proceed: false, redactionPlans: [] };
    }
    return { proceed: true, redactionPlans: [] };
  }

  // proceed - continue with warning
  prompts.log.warning('Proceeding with secrets - make sure your repo is private!');
  return { proceed: true, redactionPlans: [] };
};

const runInteractiveSync = async (tuckDir: string, options: SyncOptions = {}): Promise<void> => {
  prompts.intro('tuck sync');

  // ========== STEP 1: Pull from remote if behind ==========
  if (options.pull !== false && (await hasRemote(tuckDir))) {
    const pullSpinner = prompts.spinner();
    pullSpinner.start('Checking remote for updates...');

    const pullResult = await pullIfBehind(tuckDir, options);
    if (pullResult.error) {
      pullSpinner.stop(`Could not pull: ${pullResult.error}`);
      prompts.log.warning('Continuing with local changes...');
    } else if (pullResult.pulled) {
      const conflictNote =
        pullResult.resolvedConflicts && pullResult.resolvedConflicts.length > 0
          ? ` (resolved ${pullResult.resolvedConflicts.length} conflict${pullResult.resolvedConflicts.length === 1 ? '' : 's'})`
          : '';
      pullSpinner.stop(
        `Pulled ${pullResult.behind} commit${pullResult.behind > 1 ? 's' : ''} from remote${conflictNote}`
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
  // When the user picks 'redact', the plans are threaded into syncFiles below,
  // which applies them to the REPO copies only (issue #100 RC5).
  let redactionPlans: RedactionPlan[] = [];
  if (changes.length > 0) {
    const secretScan = await scanAndHandleSecrets(tuckDir, changes, options);
    if (!secretScan.proceed) {
      return;
    }
    redactionPlans = secretScan.redactionPlans;
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
        if (options.push !== false && !(await checkLocalMode(tuckDir)) && (await hasRemote(tuckDir))) {
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
  let filesToTrackCandidates: Array<{ path: string; category?: string }> = [];
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

      filesToTrackCandidates = (selected as string[]).map((path) => {
        const matched = newFiles.find((file) => file.path === path);
        return {
          path,
          category: matched?.category,
        };
      });
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

        if (changes.length === 0 && filesToTrackCandidates.length === 0) {
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

        if (changes.length === 0 && filesToTrackCandidates.length === 0) {
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
  if (filesToTrackCandidates.length > 0) {
    const prepared = await preparePathsForTracking(filesToTrackCandidates, tuckDir, {
      secretHandling: 'interactive',
    });
    filesToTrack = prepared.map((file) => ({
      path: file.source,
      category: file.category,
    }));
  }

  if (changes.length === 0 && filesToTrack.length === 0 && filesToTrackCandidates.length > 0) {
    prompts.log.info('No changes remaining to sync');
    return;
  }

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

    result = await syncFiles(tuckDir, changes, { ...options, message }, redactionPlans);
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

    if (options.push !== false && !(await checkLocalMode(tuckDir)) && (await hasRemote(tuckDir))) {
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
    // Provider gate: refuse to push in local-only mode even if a stray 'origin'
    // remote is present. The configured provider mode is authoritative.
    const config = await loadConfig(tuckDir);
    assertRemoteAvailable(config.remote, 'push');

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

/**
 * Scan the about-to-be-synced changes for secrets and either block or warn,
 * honoring `security.blockOnSecrets`. This is the SINGLE secret gate shared by
 * every non-interactive sync path (`--json`, `--yes`, and the message path) so
 * none of them can drift back into committing secrets. With `--force`, scanning
 * is skipped but an audit entry is always recorded.
 *
 * Throws {@link SecretsDetectedError} when secrets are found and blocking is on.
 * In JSON mode it emits structured warnings instead of human-readable output so
 * the single-JSON-object stdout contract is preserved.
 */
const scanChangesForSecretsOrThrow = async (
  tuckDir: string,
  changes: FileChange[],
  options: { force?: boolean; json?: boolean }
): Promise<void> => {
  if (options.force) {
    await logForceSecretBypass(
      options.json ? 'tuck sync --json --force' : 'tuck sync --force',
      changes.length
    );
    const msg = 'Secret scanning bypassed via --force';
    if (options.json) addJsonWarning(msg);
    else logger.warning(msg);
    return;
  }

  if (!(await isSecretScanningEnabled(tuckDir))) return;

  const modifiedPaths = await resolveModifiedLivePaths(tuckDir, changes);
  if (modifiedPaths.length === 0) return;

  const summary = await scanForSecrets(modifiedPaths, tuckDir);
  if (summary.totalSecrets === 0) return;

  if (await shouldBlockOnSecrets(tuckDir)) {
    if (!options.json) displayScanResults(summary);
    throw new SecretsDetectedError(
      summary.totalSecrets,
      summary.results.map((r) => collapsePath(r.path))
    );
  }

  // blockOnSecrets disabled: warn but continue.
  if (options.json) {
    addJsonWarning(
      `${summary.totalSecrets} potential secret(s) detected but blockOnSecrets is disabled — proceeding`
    );
  } else {
    displayScanResults(summary);
    logger.warning('Secrets detected but blockOnSecrets is disabled - proceeding with sync');
    logger.warning('Make sure your repository is private!');
  }
};

export const runSyncCommand = async (
  messageArg: string | undefined,
  options: SyncOptions
): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck sync');
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // --plan / --dry-run: report what would happen and exit without mutating.
  if (options.plan || options.dryRun) {
    const changes = await detectChanges(tuckDir);
    if (options.json) {
      emitJsonOk({
        plan: {
          modified: changes.filter((c) => c.status === 'modified').map((c) => c.path),
          deleted: changes.filter((c) => c.status === 'deleted').map((c) => c.path),
        },
      });
      return;
    }
    logger.heading('Plan — would sync:');
    for (const c of changes) logger.file(c.status === 'modified' ? 'modify' : 'delete', c.path);
    return;
  }

  // If JSON or auto-yes mode and we have a path through, use non-interactive flow.
  if (options.json || options.yes) {
    const changes = await detectChanges(tuckDir);
    if (changes.length === 0) {
      // No tracked-file DRIFT — but the working tree may still hold uncommitted
      // changes: the INITIAL `tuck add` (which copies into ~/.tuck without
      // committing), a prior `pull`, or manual repo edits. Commit those instead
      // of falsely reporting a no-op — otherwise the initial add is never
      // committed and a later `tuck push` would push nothing. Mirrors the
      // interactive path's gitStatus.hasChanges handling (runInteractiveSync).
      // (Files reach the repo via `tuck add`, which already secret-scans them.)
      const gitStatus = await getStatus(tuckDir);
      if (!gitStatus.hasChanges) {
        if (options.json) {
          // Idempotent: nothing to do is a no-op, not a failure. Agents key on
          // `noop` to tell "nothing changed" from "synced".
          emitJsonOk({ modified: [], deleted: [], commitHash: null, noop: true });
        } else {
          logger.info('No changes detected');
        }
        return;
      }
      await stageAll(tuckDir);
      const commitHash = await commit(tuckDir, messageArg || options.message || 'Update dotfiles');
      let pushError: string | undefined;
      if (options.push !== false && !(await checkLocalMode(tuckDir)) && (await hasRemote(tuckDir))) {
        const config = await loadConfig(tuckDir);
        assertRemoteAvailable(config.remote, 'push');
        try {
          await push(tuckDir);
        } catch (err) {
          if (!options.json) throw err;
          pushError = err instanceof Error ? err.message : String(err);
        }
      }
      if (options.json) {
        emitJsonOk({
          modified: [],
          deleted: [],
          commitHash,
          noop: false,
          ...(pushError ? { pushError } : {}),
        });
      } else {
        logger.success(`Committed pending repository changes: ${commitHash.slice(0, 7)}`);
      }
      return;
    }
    // Secret gate: never let the non-interactive path commit/push secrets.
    await scanChangesForSecretsOrThrow(tuckDir, changes, {
      force: options.force,
      json: options.json,
    });
    const message = messageArg || options.message;
    const result = await syncFiles(tuckDir, changes, { ...options, message });
    if (options.push !== false && !(await checkLocalMode(tuckDir)) && (await hasRemote(tuckDir))) {
      // Provider gate: local-only mode refuses the push regardless of any stray
      // 'origin' remote. The configured provider mode is authoritative.
      const config = await loadConfig(tuckDir);
      assertRemoteAvailable(config.remote, 'push');
      try {
        await push(tuckDir);
      } catch (err) {
        if (options.json) {
          emitJsonOk({
            modified: [...result.modified].sort(),
            deleted: [...result.deleted].sort(),
            commitHash: result.commitHash ?? null,
            noop: false,
            pushError: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        throw err;
      }
    }
    if (options.json) {
      emitJsonOk({
        modified: [...result.modified].sort(),
        deleted: [...result.deleted].sort(),
        commitHash: result.commitHash ?? null,
        noop: false,
      });
    } else {
      logger.success(`Synced ${changes.length} file${changes.length > 1 ? 's' : ''}`);
    }
    return;
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

  // Scan for secrets (non-interactive message path) — shared gate.
  await scanChangesForSecretsOrThrow(tuckDir, changes, { force: options.force, json: options.json });

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
    if (options.push !== false && !(await checkLocalMode(tuckDir)) && (await hasRemote(tuckDir))) {
      // Provider gate: local-only mode refuses the push regardless of any stray
      // 'origin' remote. The configured provider mode is authoritative.
      const config = await loadConfig(tuckDir);
      assertRemoteAvailable(config.remote, 'push');
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
  .option('--json', 'Emit JSON envelope; non-interactive (errors on conflict)')
  .option('-y, --yes', 'Auto-confirm prompts (use with --json for full automation)')
  .option('--plan', 'Compute and emit the planned changes, do not execute')
  .option('--dry-run', 'Same as --plan but prints human text')
  .action(async (messageArg: string | undefined, options: SyncOptions) => {
    await runSyncCommand(messageArg, options);
  });
