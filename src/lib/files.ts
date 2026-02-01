import { createHash } from 'crypto';
import { readFile, stat, lstat, readdir, copyFile, symlink, unlink, rm } from 'fs/promises';
import { copy, ensureDir } from 'fs-extra';
import { join, dirname, basename } from 'path';
import { constants } from 'fs';
import { FileNotFoundError, PermissionError } from '../errors.js';
import { expandPath, pathExists, isDirectory } from './paths.js';
import { IS_WINDOWS } from './platform.js';

export interface FileInfo {
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  permissions: string;
  modified: Date;
}

export interface CopyResult {
  source: string;
  destination: string;
  fileCount: number;
  totalSize: number;
}

export const getFileChecksum = async (filepath: string): Promise<string> => {
  const expandedPath = expandPath(filepath);

  if (await isDirectory(expandedPath)) {
    // For directories, create a hash of all file checksums
    const files = await getDirectoryFiles(expandedPath);

    // Handle empty directories - return hash of empty string for consistency
    if (files.length === 0) {
      return createHash('sha256').update('').digest('hex');
    }

    const hashes: string[] = [];

    for (const file of files) {
      const content = await readFile(file);
      hashes.push(createHash('sha256').update(content).digest('hex'));
    }

    return createHash('sha256').update(hashes.join('')).digest('hex');
  }

  const content = await readFile(expandedPath);
  return createHash('sha256').update(content).digest('hex');
};

export const getFileInfo = async (filepath: string): Promise<FileInfo> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    throw new FileNotFoundError(filepath);
  }

  try {
    const stats = await stat(expandedPath);
    // On Windows, Unix-style permissions are not meaningful
    // Return a sensible default (644 for files, 755 for dirs)
    const permissions = IS_WINDOWS
      ? (stats.isDirectory() ? '755' : '644')
      : (stats.mode & 0o777).toString(8).padStart(3, '0');

    return {
      path: expandedPath,
      isDirectory: stats.isDirectory(),
      isSymlink: stats.isSymbolicLink(),
      size: stats.size,
      permissions,
      modified: stats.mtime,
    };
  } catch (error) {
    throw new PermissionError(filepath, 'read');
  }
};

export const getDirectoryFiles = async (dirpath: string): Promise<string[]> => {
  const expandedPath = expandPath(dirpath);
  const files: string[] = [];

  // Skip common temporary/cache files and git repos that change frequently
  const skipPatterns = [
    '.DS_Store',
    'Thumbs.db',
    '.git', // Skip git directories to prevent nested repos
    '.gitignore',
    'node_modules',
    '.cache',
    '__pycache__',
    '*.pyc',
    '*.swp',
    '*.tmp',
    '.npmrc',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ];

  let entries;
  try {
    entries = await readdir(expandedPath, { withFileTypes: true });
  } catch (error) {
    // Handle permission errors and other read failures gracefully
    if (process.env.DEBUG) {
      console.warn(`[tuck] Warning: Failed to read directory ${expandedPath}:`, error);
    }
    return files;
  }

  for (const entry of entries) {
    const entryPath = join(expandedPath, entry.name);
    
    const shouldSkip = skipPatterns.some(pattern => {
      if (pattern.includes('*')) {
        // Escape special regex characters (especially .) before replacing * with .*
        const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        const regex = new RegExp('^' + escapedPattern + '$');
        return regex.test(entry.name);
      }
      return entry.name === pattern;
    });
    
    if (shouldSkip) {
      continue;
    }

    try {
      // Use lstat to detect symlinks (stat follows symlinks, lstat doesn't)
      const lstats = await lstat(entryPath);

      // Skip symlinks to prevent infinite recursion loops
      if (lstats.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = await getDirectoryFiles(entryPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    } catch (error) {
      // Skip entries we can't access (permission errors, etc.)
      if (process.env.DEBUG) {
        console.warn(`[tuck] Warning: Cannot access ${entryPath}:`, error);
      }
      continue;
    }
  }

  return files.sort();
};

export const getDirectoryFileCount = async (dirpath: string): Promise<number> => {
  const files = await getDirectoryFiles(dirpath);
  return files.length;
};

export const copyFileOrDir = async (
  source: string,
  destination: string,
  options?: { overwrite?: boolean }
): Promise<CopyResult> => {
  const expandedSource = expandPath(source);
  const expandedDest = expandPath(destination);

  if (!(await pathExists(expandedSource))) {
    throw new FileNotFoundError(source);
  }

  // Ensure destination directory exists
  await ensureDir(dirname(expandedDest));

  const sourceIsDir = await isDirectory(expandedSource);

  try {
    const shouldOverwrite = options?.overwrite ?? true;

    if (sourceIsDir) {
      // Copy directory but skip .git and other problematic files
      await copy(expandedSource, expandedDest, { 
        overwrite: shouldOverwrite,
        filter: (src: string) => {
          const name = basename(src);
          // Skip .git directories, node_modules, and cache directories
          const skipDirs = ['.git', 'node_modules', '.cache', '__pycache__', '.DS_Store'];
          return !skipDirs.includes(name);
        }
      });
      const fileCount = await getDirectoryFileCount(expandedDest);
      const files = await getDirectoryFiles(expandedDest);
      let totalSize = 0;
      for (const file of files) {
        const stats = await stat(file);
        totalSize += stats.size;
      }
      return { source: expandedSource, destination: expandedDest, fileCount, totalSize };
    } else {
      // Use COPYFILE_EXCL flag to prevent overwriting when overwrite is false
      // If overwrite is true (default), use mode 0 which allows overwriting
      const copyFlags = shouldOverwrite ? 0 : constants.COPYFILE_EXCL;
      await copyFile(expandedSource, expandedDest, copyFlags);
      const stats = await stat(expandedDest);
      return { source: expandedSource, destination: expandedDest, fileCount: 1, totalSize: stats.size };
    }
  } catch (error) {
    throw new PermissionError(destination, 'write');
  }
};

/**
 * Result of a symlink creation attempt
 */
export interface SymlinkResult {
  /** The type of link created: 'symlink' (Unix or Windows file), 'junction' (Windows directory), or 'copy' (Windows fallback) */
  type: 'symlink' | 'junction' | 'copy';
  /** Whether the operation succeeded */
  success: boolean;
}

/**
 * Create a symbolic link from target to linkPath.
 *
 * On Windows, this function handles the complexity of symlink creation:
 * - For directories: Uses junctions (don't require admin privileges)
 * - For files: Attempts symlink first, falls back to copy if that fails
 *
 * @param target - The path the symlink should point to
 * @param linkPath - The path where the symlink will be created
 * @param options - Optional settings
 * @param options.overwrite - If true, removes existing file/symlink at linkPath
 * @returns Result indicating the type of link created (symlink, junction, or copy)
 * @throws {FileNotFoundError} If target doesn't exist
 * @throws {PermissionError} If symlink creation fails (and fallback also fails on Windows)
 */
export const createSymlink = async (
  target: string,
  linkPath: string,
  options?: { overwrite?: boolean }
): Promise<SymlinkResult> => {
  const expandedTarget = expandPath(target);
  const expandedLink = expandPath(linkPath);

  if (!(await pathExists(expandedTarget))) {
    throw new FileNotFoundError(target);
  }

  // Ensure link parent directory exists
  await ensureDir(dirname(expandedLink));

  // Remove existing file/symlink if overwrite is true
  if (options?.overwrite && (await pathExists(expandedLink))) {
    try {
      const linkStats = await lstat(expandedLink);
      if (linkStats.isDirectory()) {
        await rm(expandedLink, { recursive: true });
      } else {
        await unlink(expandedLink);
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  const targetIsDir = await isDirectory(expandedTarget);

  try {
    // On Windows, use 'junction' for directories (doesn't require admin privileges)
    // For files, try symlink first
    if (IS_WINDOWS && targetIsDir) {
      await symlink(expandedTarget, expandedLink, 'junction');
      return { type: 'junction', success: true };
    }
    await symlink(expandedTarget, expandedLink);
    return { type: 'symlink', success: true };
  } catch (error) {
    // On non-Windows, propagate the error
    if (!IS_WINDOWS) {
      throw new PermissionError(linkPath, 'create symlink');
    }

    // Windows fallback: try junction for directories if symlink failed
    if (targetIsDir) {
      try {
        await symlink(expandedTarget, expandedLink, 'junction');
        return { type: 'junction', success: true };
      } catch {
        // Fall through to copy fallback
      }
    }

    // Final fallback for Windows: copy the file/directory
    try {
      if (targetIsDir) {
        await copy(expandedTarget, expandedLink, { overwrite: true });
      } else {
        await copyFile(expandedTarget, expandedLink);
      }
      return { type: 'copy', success: true };
    } catch (copyError) {
      throw new PermissionError(linkPath, 'create symlink (or fallback copy)');
    }
  }
};

export const deleteFileOrDir = async (filepath: string): Promise<void> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    return; // Already deleted
  }

  try {
    if (await isDirectory(expandedPath)) {
      await rm(expandedPath, { recursive: true });
    } else {
      await unlink(expandedPath);
    }
  } catch (error) {
    throw new PermissionError(filepath, 'delete');
  }
};

export const ensureDirectory = async (dirpath: string): Promise<void> => {
  const expandedPath = expandPath(dirpath);
  await ensureDir(expandedPath);
};

export const moveFile = async (
  source: string,
  destination: string,
  options?: { overwrite?: boolean }
): Promise<void> => {
  await copyFileOrDir(source, destination, options);
  await deleteFileOrDir(source);
};

export const hasFileChanged = async (
  file1: string,
  file2: string
): Promise<boolean> => {
  const expandedFile1 = expandPath(file1);
  const expandedFile2 = expandPath(file2);

  // If either doesn't exist, they're different
  if (!(await pathExists(expandedFile1)) || !(await pathExists(expandedFile2))) {
    return true;
  }

  const checksum1 = await getFileChecksum(expandedFile1);
  const checksum2 = await getFileChecksum(expandedFile2);

  return checksum1 !== checksum2;
};

export const getFilePermissions = async (filepath: string): Promise<string> => {
  // On Windows, return a sensible default since Unix permissions don't apply
  if (IS_WINDOWS) {
    const expandedPath = expandPath(filepath);
    const stats = await stat(expandedPath);
    return stats.isDirectory() ? '755' : '644';
  }
  const expandedPath = expandPath(filepath);
  const stats = await stat(expandedPath);
  return (stats.mode & 0o777).toString(8).padStart(3, '0');
};

export const setFilePermissions = async (filepath: string, mode: string): Promise<void> => {
  // On Windows, chmod is limited and Unix-style permissions don't apply
  // Skip permission setting gracefully
  if (IS_WINDOWS) {
    return;
  }
  const expandedPath = expandPath(filepath);
  const { chmod } = await import('fs/promises');
  await chmod(expandedPath, parseInt(mode, 8));
};

export const formatBytes = (bytes: number): string => {
  // Handle invalid, negative, or zero values
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  // Ensure index is within bounds to prevent undefined access
  const safeIndex = Math.max(0, Math.min(i, sizes.length - 1));
  return `${parseFloat((bytes / Math.pow(k, safeIndex)).toFixed(1))} ${sizes[safeIndex]}`;
};

// ============================================================================
// File Size Utilities for Large File Detection
// ============================================================================

export const SIZE_WARN_THRESHOLD = 50 * 1024 * 1024; // 50MB
export const SIZE_BLOCK_THRESHOLD = 100 * 1024 * 1024; // 100MB

/**
 * Get total size of a file or directory recursively
 */
export const getFileSizeRecursive = async (filepath: string): Promise<number> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    return 0;
  }

  const stats = await stat(expandedPath);

  if (!stats.isDirectory()) {
    return stats.size;
  }

  // Directory: sum all file sizes
  const files = await getDirectoryFiles(expandedPath);
  let totalSize = 0;

  for (const file of files) {
    try {
      const fileStats = await stat(file);
      totalSize += fileStats.size;
    } catch {
      // Skip files we can't access
      continue;
    }
  }

  return totalSize;
};

/**
 * Format file size in human-readable format (e.g., "50.2 MB")
 * Adds validation to handle invalid/negative values safely
 */
export const formatFileSize = (bytes: number): string => {
  // Normalize invalid or negative values to 0 to avoid surprising output
  if (!Number.isFinite(bytes) || bytes < 0) {
    bytes = 0;
  }
  return formatBytes(bytes);
};

/**
 * Check if file size exceeds warning or blocking thresholds
 */
export const checkFileSizeThreshold = async (
  filepath: string
): Promise<{ warn: boolean; block: boolean; size: number }> => {
  const size = await getFileSizeRecursive(filepath);

  return {
    warn: size >= SIZE_WARN_THRESHOLD,
    block: size >= SIZE_BLOCK_THRESHOLD,
    size,
  };
};
