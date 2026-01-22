import { join } from 'path';
import { readdir, rm } from 'fs/promises';
import { copy, ensureDir, pathExists } from 'fs-extra';
import { BACKUP_DIR } from '../constants.js';
import { expandPath, collapsePath, pathExists as checkPathExists } from './paths.js';
import { toPosixPath } from './platform.js';

export interface BackupInfo {
  path: string;
  date: Date;
  files: string[];
}

export interface BackupResult {
  originalPath: string;
  backupPath: string;
  date: Date;
}

const getBackupDir = (): string => {
  return expandPath(BACKUP_DIR);
};

const formatDateForBackup = (date: Date): string => {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
};

const getTimestampedBackupDir = (date: Date): string => {
  const backupRoot = getBackupDir();
  const timestamp = formatDateForBackup(date);
  return join(backupRoot, timestamp);
};

export const createBackup = async (
  sourcePath: string,
  customBackupDir?: string
): Promise<BackupResult> => {
  const expandedSource = expandPath(sourcePath);
  const date = new Date();

  if (!(await checkPathExists(expandedSource))) {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  // Create backup directory with date
  const backupRoot = customBackupDir
    ? expandPath(customBackupDir)
    : getTimestampedBackupDir(date);
  await ensureDir(backupRoot);

  // Generate backup filename that preserves structure
  // Normalize to POSIX-style (forward slashes) for consistent backup naming across platforms
  const collapsed = toPosixPath(collapsePath(expandedSource));
  const backupName = collapsed
    .replace(/^~\//, '')
    .replace(/\//g, '_')
    .replace(/^\./, 'dot-');

  // Add timestamp to handle multiple backups of same file in a day
  const timestamp = date.toISOString().replace(/[:.]/g, '-').slice(11, 19);
  const backupPath = join(backupRoot, `${backupName}_${timestamp}`);

  await copy(expandedSource, backupPath, { overwrite: true });

  return {
    originalPath: expandedSource,
    backupPath,
    date,
  };
};

export const createMultipleBackups = async (
  sourcePaths: string[],
  customBackupDir?: string
): Promise<BackupResult[]> => {
  const results: BackupResult[] = [];

  for (const path of sourcePaths) {
    const result = await createBackup(path, customBackupDir);
    results.push(result);
  }

  return results;
};

export const listBackups = async (): Promise<BackupInfo[]> => {
  const backupRoot = getBackupDir();

  if (!(await pathExists(backupRoot))) {
    return [];
  }

  const backups: BackupInfo[] = [];
  const dateDirs = await readdir(backupRoot, { withFileTypes: true });

  for (const dateDir of dateDirs) {
    if (!dateDir.isDirectory()) continue;

    const datePath = join(backupRoot, dateDir.name);
    const files = await readdir(datePath);

    // Parse date from directory name
    const dateMatch = dateDir.name.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) continue;

    const date = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);

    backups.push({
      path: datePath,
      date,
      files: files.map((f) => join(datePath, f)),
    });
  }

  // Sort by date, newest first
  return backups.sort((a, b) => b.date.getTime() - a.date.getTime());
};

export const getBackupsByDate = async (date: Date): Promise<string[]> => {
  const backupDir = getTimestampedBackupDir(date);

  if (!(await pathExists(backupDir))) {
    return [];
  }

  const files = await readdir(backupDir);
  return files.map((f) => join(backupDir, f));
};

export const restoreBackup = async (backupPath: string, targetPath: string): Promise<void> => {
  const expandedBackup = expandPath(backupPath);
  const expandedTarget = expandPath(targetPath);

  if (!(await checkPathExists(expandedBackup))) {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  // Create backup of current state before restoring
  if (await checkPathExists(expandedTarget)) {
    await createBackup(expandedTarget);
  }

  await copy(expandedBackup, expandedTarget, { overwrite: true });
};

export const deleteBackup = async (backupPath: string): Promise<void> => {
  const expandedPath = expandPath(backupPath);

  if (await checkPathExists(expandedPath)) {
    await rm(expandedPath, { recursive: true });
  }
};

export const cleanOldBackups = async (daysToKeep: number): Promise<number> => {
  const backups = await listBackups();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  let deletedCount = 0;

  for (const backup of backups) {
    if (backup.date < cutoffDate) {
      await rm(backup.path, { recursive: true });
      deletedCount++;
    }
  }

  return deletedCount;
};

export const getBackupSize = async (): Promise<number> => {
  const backups = await listBackups();
  let totalSize = 0;

  for (const backup of backups) {
    for (const file of backup.files) {
      const { stat } = await import('fs/promises');
      try {
        const stats = await stat(file);
        totalSize += stats.size;
      } catch {
        // Ignore errors
      }
    }
  }

  return totalSize;
};
