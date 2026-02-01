import { join, dirname } from 'path';
import { readdir, readFile, writeFile, rm, stat } from 'fs/promises';
import { copy, ensureDir, pathExists } from 'fs-extra';
import { homedir } from 'os';
import { expandPath, collapsePath, pathExists as checkPathExists } from './paths.js';
import { BackupError } from '../errors.js';

const TIMEMACHINE_DIR = join(homedir(), '.tuck', 'backups');

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
const getSnapshotPath = (snapshotId: string): string => {
  return join(TIMEMACHINE_DIR, snapshotId);
};

/**
 * Convert original path to a safe backup path, preserving directory structure
 * to prevent filename collisions. The path is relative to the backup files directory.
 * e.g., ~/.zshrc -> .zshrc
 * e.g., ~/.config/nvim -> .config/nvim
 * e.g., ~/.foo.bar -> .foo.bar (distinct from ~/.foo-bar -> .foo-bar)
 */
const toBackupPath = (originalPath: string): string => {
  const collapsed = collapsePath(originalPath);
  // Remove ~/ or ~\ prefix to get a path relative to home directory
  // This preserves the full directory structure, preventing collisions
  // Note: collapsePath now normalizes to forward slashes, but handle both for safety
  return collapsed.replace(/^~[/\\]/, '');
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
  const snapshotId = generateSnapshotId();
  const snapshotPath = getSnapshotPath(snapshotId);

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

  await writeFile(
    join(snapshotPath, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8'
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
  if (!(await pathExists(TIMEMACHINE_DIR))) {
    return [];
  }

  const entries = await readdir(TIMEMACHINE_DIR, { withFileTypes: true });
  const snapshots: Snapshot[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const snapshotPath = join(TIMEMACHINE_DIR, entry.name);
    const metadataPath = join(snapshotPath, 'metadata.json');

    if (!(await pathExists(metadataPath))) continue;

    try {
      const content = await readFile(metadataPath, 'utf-8');
      const metadata: SnapshotMetadata = JSON.parse(content);

      snapshots.push({
        id: metadata.id,
        path: snapshotPath,
        timestamp: new Date(metadata.timestamp),
        reason: metadata.reason,
        files: metadata.files,
        machine: metadata.machine,
        profile: metadata.profile,
      });
    } catch (error) {
      // Skip invalid snapshots but log for debugging
      if (process.env.DEBUG) {
        console.warn(`[tuck] Warning: Skipping invalid snapshot at ${snapshotPath}:`, error);
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
  const snapshotPath = getSnapshotPath(snapshotId);

  if (!(await pathExists(snapshotPath))) {
    return null;
  }

  const metadataPath = join(snapshotPath, 'metadata.json');

  if (!(await pathExists(metadataPath))) {
    return null;
  }

  try {
    const content = await readFile(metadataPath, 'utf-8');
    const metadata: SnapshotMetadata = JSON.parse(content);

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
    return null;
  }
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
      'Run `tuck restore --list` to see available snapshots',
    ]);
  }

  const restoredFiles: string[] = [];

  for (const file of snapshot.files) {
    if (!file.existed) {
      // File didn't exist before, delete it if it exists now
      if (await checkPathExists(file.originalPath)) {
        await rm(file.originalPath, { recursive: true });
      }
      continue;
    }

    // Restore the backup
    if (await pathExists(file.backupPath)) {
      await ensureDir(dirname(file.originalPath));
      await copy(file.backupPath, file.originalPath, { overwrite: true, preserveTimestamps: true });
      restoredFiles.push(file.originalPath);
    }
  }

  return restoredFiles;
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

  await ensureDir(dirname(file.originalPath));
  await copy(file.backupPath, file.originalPath, { overwrite: true, preserveTimestamps: true });
  return true;
};

/**
 * Delete a snapshot
 */
export const deleteSnapshot = async (snapshotId: string): Promise<void> => {
  const snapshotPath = getSnapshotPath(snapshotId);

  if (await pathExists(snapshotPath)) {
    await rm(snapshotPath, { recursive: true });
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
  if (!(await pathExists(TIMEMACHINE_DIR))) {
    return 0;
  }

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

  totalSize = await calculateDirSize(TIMEMACHINE_DIR);
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
