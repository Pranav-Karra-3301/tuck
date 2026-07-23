import { join } from 'path';
import { copy, ensureDir } from 'fs-extra';
import { BACKUP_DIR } from '../constants.js';
import { expandPath, collapsePath, pathExists as checkPathExists, isPathWithinHome } from './paths.js';
import { toPosixPath } from './platform.js';
import { loadConfig } from './config.js';
import { BackupError } from '../errors.js';

export interface BackupResult {
  originalPath: string;
  backupPath: string;
  date: Date;
}

const getBackupDir = async (customBackupDir?: string, tuckDir?: string): Promise<string> => {
  if (customBackupDir) {
    const resolved = expandPath(customBackupDir);
    if (!isPathWithinHome(resolved)) {
      throw new BackupError(
        `Unsafe backup directory: ${customBackupDir} - backup directory must be within home directory`
      );
    }
    return resolved;
  }

  try {
    const config = await loadConfig(tuckDir);
    const backupDir = config.files.backupDir || BACKUP_DIR;
    const resolved = expandPath(backupDir);
    if (!isPathWithinHome(resolved)) {
      throw new BackupError(
        `Unsafe backup directory: ${backupDir} - backup directory must be within home directory`
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    return expandPath(BACKUP_DIR);
  }
};

const formatDateForBackup = (date: Date): string => {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
};

const getTimestampedBackupDir = (date: Date, backupRoot: string): string => {
  const timestamp = formatDateForBackup(date);
  return join(backupRoot, timestamp);
};

export const createBackup = async (
  sourcePath: string,
  customBackupDir?: string,
  tuckDir?: string
): Promise<BackupResult> => {
  const expandedSource = expandPath(sourcePath);
  const date = new Date();

  if (!(await checkPathExists(expandedSource))) {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  // Create backup directory with date
  const backupRoot = await getBackupDir(customBackupDir, tuckDir);
  const datedBackupDir = getTimestampedBackupDir(date, backupRoot);
  await ensureDir(datedBackupDir);

  // Generate backup filename that preserves structure
  // Normalize to POSIX-style (forward slashes) for consistent backup naming across platforms
  const collapsed = toPosixPath(collapsePath(expandedSource));
  const backupName = collapsed
    .replace(/^~\//, '')
    .replace(/\//g, '_')
    .replace(/^\./, 'dot-');

  // Add timestamp to handle multiple backups of same file in a day
  const timestamp = date.toISOString().replace(/[:.]/g, '-').slice(11, 19);
  const backupPath = join(datedBackupDir, `${backupName}_${timestamp}`);

  await copy(expandedSource, backupPath, { overwrite: true });

  return {
    originalPath: expandedSource,
    backupPath,
    date,
  };
};

