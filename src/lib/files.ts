import { createHash } from 'crypto';
import { readFile, stat, lstat, readdir, copyFile, symlink, unlink, rm } from 'fs/promises';
import { copy, ensureDir } from 'fs-extra';
import { join, dirname } from 'path';
import { constants } from 'fs';
import { FileNotFoundError, PermissionError } from '../errors.js';
import { expandPath, pathExists, isDirectory } from './paths.js';

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
    const permissions = (stats.mode & 0o777).toString(8).padStart(3, '0');

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

  let entries;
  try {
    entries = await readdir(expandedPath, { withFileTypes: true });
  } catch (error) {
    // Handle permission errors and other read failures gracefully
    return files;
  }

  for (const entry of entries) {
    const entryPath = join(expandedPath, entry.name);

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
    
    const shouldSkip = skipPatterns.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
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
    } catch {
      // Skip entries we can't access (permission errors, etc.)
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
          const name = src.split('/').pop() || '';
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

export const createSymlink = async (
  target: string,
  linkPath: string,
  options?: { overwrite?: boolean }
): Promise<void> => {
  const expandedTarget = expandPath(target);
  const expandedLink = expandPath(linkPath);

  if (!(await pathExists(expandedTarget))) {
    throw new FileNotFoundError(target);
  }

  // Ensure link parent directory exists
  await ensureDir(dirname(expandedLink));

  // Remove existing file/symlink if overwrite is true
  if (options?.overwrite && (await pathExists(expandedLink))) {
    await unlink(expandedLink);
  }

  try {
    await symlink(expandedTarget, expandedLink);
  } catch (error) {
    throw new PermissionError(linkPath, 'create symlink');
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
  const expandedPath = expandPath(filepath);
  const stats = await stat(expandedPath);
  return (stats.mode & 0o777).toString(8).padStart(3, '0');
};

export const setFilePermissions = async (filepath: string, mode: string): Promise<void> => {
  const expandedPath = expandPath(filepath);
  const { chmod } = await import('fs/promises');
  await chmod(expandedPath, parseInt(mode, 8));
};

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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
 */
export const formatFileSize = (bytes: number): string => {
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
