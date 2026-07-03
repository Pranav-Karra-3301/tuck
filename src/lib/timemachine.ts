import { join, dirname, relative, resolve, sep } from 'path';
import { readdir, readFile, rename, rm, stat } from 'fs/promises';
import { copy, ensureDir, pathExists } from 'fs-extra';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { expandPath, pathExists as checkPathExists } from './paths.js';
import { atomicWriteFile } from './files.js';
import { BackupError } from '../errors.js';
import { getLegacySnapshotsDir, getSnapshotsDir } from './state.js';
import { snapshotMetadataSchema } from '../schemas/snapshot.schema.js';

export interface SnapshotMetadata {
  id: string;
  timestamp: string;
  reason: string;
  files: SnapshotFile[];
  machine: string;
  profile?: string;
}

export interface SnapshotFile {
  originalPath: string;
  backupPath: string;
  existed: boolean;
}

export interface Snapshot {
  id: string;
  path: string;
  timestamp: Date;
  reason: string;
  files: SnapshotFile[];
  machine: string;
  profile?: string;
}

/**
 * Generate a unique snapshot ID (YYYY-MM-DD-HHMMSS)
 */
const generateSnapshotId = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
};

/**
 * Get the path to a snapshot directory
 */
const getSnapshotPath = (snapshotId: string, snapshotsDir = getSnapshotsDir()): string => {
  return join(snapshotsDir, snapshotId);
};

const getSnapshotRoots = (): string[] => {
  const roots = [getSnapshotsDir(), getLegacySnapshotsDir()];
  return [...new Set(roots)];
};

/**
 * Convert original path to a safe backup path, preserving directory structure
 * to prevent filename collisions. The path is relative to the backup files directory.
 * e.g., ~/.zshrc -> .zshrc
 * e.g., ~/.config/nvim -> .config/nvim
 * e.g., ~/.foo.bar -> .foo.bar (distinct from ~/.foo-bar -> .foo-bar)
 *
 * Paths OUTSIDE $HOME are legitimate (a repo-scoped file lives in a checkout that
 * may be outside home). They are stored under a reserved `_external/<hash>/`
 * subtree keyed by a hash of the absolute path — the live restore target is kept
 * separately as `originalPath`, so this storage path only needs to be unique and
 * safe within the snapshot. Throwing here would let one out-of-home file abort an
 * entire apply's pre-apply snapshot.
 */
const toBackupPath = (originalPath: string): string => {
  const expandedOriginal = expandPath(originalPath);
  const homePath = resolve(homedir());
  const resolvedOriginal = resolve(expandedOriginal);

  const isWithinHome =
    resolvedOriginal === homePath || resolvedOriginal.startsWith(homePath + sep);
  if (!isWithinHome) {
    const hash = createHash('sha256').update(resolvedOriginal).digest('hex').slice(0, 16);
    const base = (resolvedOriginal.split(/[\\/]/).pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    return `_external/${hash}/${base}`;
  }

  const relativePath = relative(homePath, resolvedOriginal);
  const normalizedRelative = relativePath.replace(/\\/g, '/');

  if (!normalizedRelative || normalizedRelative === '.') {
    throw new BackupError(`Cannot snapshot home directory root directly: ${originalPath}`);
  }

  if (
    normalizedRelative.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(normalizedRelative) ||
    normalizedRelative.split('/').includes('..')
  ) {
    throw new BackupError(`Unsafe backup path generated from: ${originalPath}`);
  }

  return normalizedRelative;
};

/**
 * Create a Time Machine snapshot of multiple files
 * This is the main entry point for creating backups before apply operations
 */
export const createSnapshot = async (
  filePaths: string[],
  reason: string,
  profile?: string
): Promise<Snapshot> => {
  // Snapshot IDs are second-resolution, so two snapshots created within the
  // same second (e.g. a pre-undo backup taken during restoreSnapshot) would
  // collide and clobber each other. Keep the common-case id unchanged and only
  // append a numeric suffix when the directory already exists.
  const baseId = generateSnapshotId();
  let snapshotId = baseId;
  let snapshotPath = getSnapshotPath(snapshotId);
  for (let n = 2; await pathExists(snapshotPath); n++) {
    snapshotId = `${baseId}-${n}`;
    snapshotPath = getSnapshotPath(snapshotId);
  }

  await ensureDir(snapshotPath);

  const files: SnapshotFile[] = [];
  const machine = (await import('os')).hostname();

  for (const filePath of filePaths) {
    const expandedPath = expandPath(filePath);
    const backupRelativePath = toBackupPath(expandedPath);
    const backupPath = join(snapshotPath, 'files', backupRelativePath);

    const existed = await checkPathExists(expandedPath);

    if (existed) {
      await ensureDir(dirname(backupPath));
      await copy(expandedPath, backupPath, { overwrite: true, preserveTimestamps: true });
    }

    files.push({
      originalPath: expandedPath,
      backupPath,
      existed,
    });
  }

  // Save metadata
  const metadata: SnapshotMetadata = {
    id: snapshotId,
    timestamp: new Date().toISOString(),
    reason,
    files,
    machine,
    profile,
  };

  // Write metadata atomically as the LAST step so a crash never leaves a
  // metadata.json that claims files it didn't actually back up.
  await atomicWriteFile(
    join(snapshotPath, 'metadata.json'),
    JSON.stringify(metadata, null, 2) + '\n'
  );

  return {
    id: snapshotId,
    path: snapshotPath,
    timestamp: new Date(metadata.timestamp),
    reason,
    files,
    machine,
    profile,
  };
};

/**
 * Create a snapshot of the user's current dotfiles before applying new ones
 */
export const createPreApplySnapshot = async (
  targetPaths: string[],
  sourceRepo?: string
): Promise<Snapshot> => {
  const reason = sourceRepo
    ? `Pre-apply backup before applying from ${sourceRepo}`
    : 'Pre-apply backup';

  return createSnapshot(targetPaths, reason);
};

/**
 * List all available snapshots
 */
export const listSnapshots = async (): Promise<Snapshot[]> => {
  const snapshots: Snapshot[] = [];
  const seenSnapshotIds = new Set<string>();

  for (const snapshotsDir of getSnapshotRoots()) {
    if (!(await pathExists(snapshotsDir))) {
      continue;
    }

    const entries = await readdir(snapshotsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seenSnapshotIds.has(entry.name)) continue;

      const snapshotPath = join(snapshotsDir, entry.name);
      const metadataPath = join(snapshotPath, 'metadata.json');

      if (!(await pathExists(metadataPath))) continue;

      try {
        const content = await readFile(metadataPath, 'utf-8');
        // Validate the on-disk metadata against the schema. A corrupted or
        // schema-violating metadata.json must skip THIS snapshot only — never
        // crash the whole list.
        const metadata = snapshotMetadataSchema.parse(JSON.parse(content));

        snapshots.push({
          id: metadata.id,
          path: snapshotPath,
          timestamp: new Date(metadata.timestamp),
          reason: metadata.reason,
          files: metadata.files,
          machine: metadata.machine,
          profile: metadata.profile,
        });
        seenSnapshotIds.add(metadata.id);
      } catch (error) {
        if (process.env.DEBUG) {
          console.warn('[tuck] Warning: Skipping invalid snapshot:', error);
        }
      }
    }
  }

  // Sort by timestamp, newest first
  return snapshots.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
};

/**
 * Get a specific snapshot by ID
 */
export const getSnapshot = async (snapshotId: string): Promise<Snapshot | null> => {
  for (const snapshotsDir of getSnapshotRoots()) {
    const snapshotPath = getSnapshotPath(snapshotId, snapshotsDir);

    if (!(await pathExists(snapshotPath))) {
      continue;
    }

    const metadataPath = join(snapshotPath, 'metadata.json');

    if (!(await pathExists(metadataPath))) {
      continue;
    }

    try {
      const content = await readFile(metadataPath, 'utf-8');
      // Validate against the schema; a corrupted/invalid metadata.json is
      // treated as a missing snapshot rather than crashing the caller.
      const metadata = snapshotMetadataSchema.parse(JSON.parse(content));

      return {
        id: metadata.id,
        path: snapshotPath,
        timestamp: new Date(metadata.timestamp),
        reason: metadata.reason,
        files: metadata.files,
        machine: metadata.machine,
        profile: metadata.profile,
      };
    } catch {
      continue;
    }
  }

  return null;
};

/**
 * Get the latest snapshot
 */
export const getLatestSnapshot = async (): Promise<Snapshot | null> => {
  const snapshots = await listSnapshots();
  return snapshots.length > 0 ? snapshots[0] : null;
};

/**
 * Restore all files from a snapshot
 */
export const restoreSnapshot = async (snapshotId: string): Promise<string[]> => {
  const snapshot = await getSnapshot(snapshotId);

  if (!snapshot) {
    throw new BackupError(`Snapshot not found: ${snapshotId}`, [
      'Run `tuck undo --list` to see available snapshots',
    ]);
  }

  // Safety: capture the CURRENT state of every path we're about to overwrite or
  // delete BEFORE mutating anything, so this undo is itself reversible
  // (undo-of-undo) and any file created after the original snapshot — which
  // would otherwise be silently rm'd — can be recovered.
  //
  // We keep this pre-restore snapshot in hand so that if the restore loop fails
  // partway through, we can roll the live filesystem back to exactly this
  // captured state (best-effort) instead of leaving it half-restored.
  const touchedPaths = snapshot.files.map((f) => f.originalPath);
  let preRestore: Snapshot | undefined;
  if (touchedPaths.length > 0) {
    preRestore = await createSnapshot(
      touchedPaths,
      `Pre-undo backup before restoring snapshot ${snapshotId}`
    );
  }

  const restoredFiles: string[] = [];

  try {
    for (const file of snapshot.files) {
      if (!file.existed) {
        // File didn't exist before, delete it if it exists now
        if (await checkPathExists(file.originalPath)) {
          await rm(file.originalPath, { recursive: true });
        }
        continue;
      }

      // Restore the backup. Stage the copy into a temp path alongside the
      // destination first, then rename it into place. A rename is atomic, so a
      // mid-copy failure can never leave a half-written file at the live path.
      if (await pathExists(file.backupPath)) {
        await ensureDir(dirname(file.originalPath));
        const stagingPath = `${file.originalPath}.tuck-restore-${process.pid}-${Date.now()}.tmp`;
        try {
          await copy(file.backupPath, stagingPath, {
            overwrite: true,
            preserveTimestamps: true,
          });
          // If a previous restore left the live path as a directory (or any
          // non-file), rename() can refuse to overwrite it — clear it first.
          if (await checkPathExists(file.originalPath)) {
            await rm(file.originalPath, { recursive: true });
          }
          await rename(stagingPath, file.originalPath);
        } catch (error) {
          // Clean up the staging artifact so a failed restore leaves no debris.
          await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        restoredFiles.push(file.originalPath);
      }
    }
  } catch (error) {
    // Best-effort rollback: return every touched path to its pre-restore state
    // captured above, then rethrow so the caller knows the undo did not apply.
    if (preRestore) {
      await rollbackToSnapshot(preRestore);
    }
    throw error;
  }

  return restoredFiles;
};

/**
 * Best-effort rollback of the live filesystem to the state captured in a
 * (pre-restore) snapshot. Used to recover after a failed `restoreSnapshot`.
 *
 * For each captured file: if it existed at capture time, copy its backup back
 * over the live path; if it did NOT exist at capture time, delete whatever is
 * now at that path. Every step is wrapped so one failure cannot abort the rest
 * of the rollback.
 */
const rollbackToSnapshot = async (preRestore: Snapshot): Promise<void> => {
  for (const file of preRestore.files) {
    try {
      if (!file.existed) {
        if (await checkPathExists(file.originalPath)) {
          await rm(file.originalPath, { recursive: true, force: true });
        }
        continue;
      }

      if (await pathExists(file.backupPath)) {
        await ensureDir(dirname(file.originalPath));
        if (await checkPathExists(file.originalPath)) {
          await rm(file.originalPath, { recursive: true, force: true });
        }
        await copy(file.backupPath, file.originalPath, {
          overwrite: true,
          preserveTimestamps: true,
        });
      }
    } catch {
      // Best-effort: keep rolling back the remaining paths.
    }
  }
};

/**
 * Restore a single file from a snapshot
 */
export const restoreFileFromSnapshot = async (
  snapshotId: string,
  filePath: string
): Promise<boolean> => {
  const snapshot = await getSnapshot(snapshotId);

  if (!snapshot) {
    throw new BackupError(`Snapshot not found: ${snapshotId}`);
  }

  const expandedPath = expandPath(filePath);
  const file = snapshot.files.find((f) => f.originalPath === expandedPath);

  if (!file) {
    throw new BackupError(`File not found in snapshot: ${filePath}`, [
      'This file was not included in the snapshot',
    ]);
  }

  // Safety: capture the CURRENT state of this path BEFORE mutating it, so this
  // single-file undo is itself reversible — mirrors restoreSnapshot. Without it,
  // a `--file` undo where the snapshot recorded the path as not-existed would rm
  // the current file/directory with no recovery path.
  const preRestore = await createSnapshot(
    [file.originalPath],
    `Pre-undo backup before restoring ${file.originalPath} from snapshot ${snapshotId}`
  );

  if (!file.existed) {
    // File didn't exist before, delete it if it exists now
    if (await checkPathExists(file.originalPath)) {
      await rm(file.originalPath, { recursive: true });
    }
    return true;
  }

  if (!(await pathExists(file.backupPath))) {
    throw new BackupError(`Backup file is missing: ${file.backupPath}`);
  }

  // Stage the copy alongside the destination, then rename it into place. A rename
  // is atomic, so a mid-copy failure can never leave a half-written file at the
  // live path. On any failure, roll the path back to its pre-undo state.
  await ensureDir(dirname(file.originalPath));
  const stagingPath = `${file.originalPath}.tuck-undo-${process.pid}-${Date.now()}.tmp`;
  try {
    await copy(file.backupPath, stagingPath, { overwrite: true, preserveTimestamps: true });
    if (await checkPathExists(file.originalPath)) {
      await rm(file.originalPath, { recursive: true });
    }
    await rename(stagingPath, file.originalPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    await rollbackToSnapshot(preRestore);
    throw error;
  }
  return true;
};

/**
 * Delete a snapshot
 */
export const deleteSnapshot = async (snapshotId: string): Promise<void> => {
  for (const snapshotsDir of getSnapshotRoots()) {
    const snapshotPath = getSnapshotPath(snapshotId, snapshotsDir);
    if (await pathExists(snapshotPath)) {
      await rm(snapshotPath, { recursive: true });
    }
  }
};

/**
 * Clean up old snapshots, keeping only the specified number
 */
export const cleanOldSnapshots = async (keepCount: number): Promise<number> => {
  const snapshots = await listSnapshots();

  if (snapshots.length <= keepCount) {
    return 0;
  }

  const toDelete = snapshots.slice(keepCount);
  let deletedCount = 0;

  for (const snapshot of toDelete) {
    await deleteSnapshot(snapshot.id);
    deletedCount++;
  }

  return deletedCount;
};

/**
 * Get the total size of all snapshots in bytes
 */
export const getSnapshotsSize = async (): Promise<number> => {
  let totalSize = 0;

  const calculateDirSize = async (dirPath: string): Promise<number> => {
    let size = 0;
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await calculateDirSize(entryPath);
      } else {
        const stats = await stat(entryPath);
        size += stats.size;
      }
    }

    return size;
  };

  for (const snapshotsDir of getSnapshotRoots()) {
    if (await pathExists(snapshotsDir)) {
      totalSize += await calculateDirSize(snapshotsDir);
    }
  }

  return totalSize;
};

/**
 * Format bytes to human readable string
 */
export const formatSnapshotSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

/**
 * Format a snapshot ID to a human-readable date string
 */
export const formatSnapshotDate = (snapshotId: string): string => {
  // Parse YYYY-MM-DD-HHMMSS format
  const match = snapshotId.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return snapshotId;

  const [, year, month, day, hours, minutes, seconds] = match;
  const date = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hours),
    parseInt(minutes),
    parseInt(seconds)
  );

  return date.toLocaleString();
};
