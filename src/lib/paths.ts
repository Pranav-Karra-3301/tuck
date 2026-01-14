import { homedir } from 'os';
import { join, basename, dirname, relative, isAbsolute, resolve, sep } from 'path';
import { stat, access } from 'fs/promises';
import { constants } from 'fs';
import {
  DEFAULT_TUCK_DIR,
  FILES_DIR,
  MANIFEST_FILE,
  CONFIG_FILE,
  CATEGORIES,
} from '../constants.js';
import { IS_WINDOWS, expandWindowsEnvVars, normalizePath } from './platform.js';

/**
 * Expand a path with home directory or environment variable prefixes to an absolute path.
 * Supports:
 * - Unix: ~/, $HOME/
 * - Windows: ~/, ~\, %USERPROFILE%, %APPDATA%, %LOCALAPPDATA%
 *
 * @param path - Path to expand
 * @returns Absolute path with all prefixes resolved
 */
export const expandPath = (path: string): string => {
  // Handle Unix-style home directory (works on all platforms)
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  // Handle $HOME (Unix style, but support on all platforms for portability)
  if (path.startsWith('$HOME/') || path.startsWith('$HOME\\')) {
    return join(homedir(), path.slice(6));
  }
  // Handle Windows environment variables
  if (IS_WINDOWS) {
    // Check for %USERPROFILE% (case-insensitive)
    if (path.toLowerCase().startsWith('%userprofile%')) {
      const remainder = path.slice(13).replace(/^[/\\]/, '');
      return join(homedir(), remainder);
    }
    // Expand other Windows environment variables (%APPDATA%, %LOCALAPPDATA%, etc.)
    const expanded = expandWindowsEnvVars(path);
    if (expanded !== path) {
      return isAbsolute(expanded) ? expanded : resolve(expanded);
    }
  }
  return isAbsolute(path) ? path : resolve(path);
};

/**
 * Collapse an absolute path to use the ~ prefix for home directory.
 * Always uses forward slashes after ~ for cross-platform manifest consistency.
 *
 * @param path - Absolute path to collapse
 * @returns Path with home directory replaced by ~
 */
export const collapsePath = (path: string): string => {
  const home = homedir();
  // Normalize both paths for comparison on Windows
  const normalizedPath = normalizePath(path);
  const normalizedHome = normalizePath(home);

  if (normalizedPath.startsWith(normalizedHome)) {
    // Always use forward slash after ~ for cross-platform consistency
    const relativePart = normalizedPath.slice(normalizedHome.length);
    // Ensure the relative part starts with / (or is empty for home itself)
    if (relativePart === '' || relativePart.startsWith('/')) {
      return '~' + relativePart;
    }
    // Handle case where path is like /home/userextra (not actually under home)
    if (relativePart.startsWith('/') || path.startsWith(home + sep)) {
      return '~' + relativePart;
    }
  }
  return path;
};

export const getTuckDir = (customDir?: string): string => {
  return expandPath(customDir || DEFAULT_TUCK_DIR);
};

export const getManifestPath = (tuckDir: string): string => {
  return join(tuckDir, MANIFEST_FILE);
};

export const getConfigPath = (tuckDir: string): string => {
  return join(tuckDir, CONFIG_FILE);
};

export const getFilesDir = (tuckDir: string): string => {
  return join(tuckDir, FILES_DIR);
};

export const getCategoryDir = (tuckDir: string, category: string): string => {
  return join(getFilesDir(tuckDir), category);
};

export const getDestinationPath = (tuckDir: string, category: string, filename: string): string => {
  return join(getCategoryDir(tuckDir, category), filename);
};

export const getRelativeDestination = (category: string, filename: string): string => {
  return join(FILES_DIR, category, filename);
};

export const sanitizeFilename = (filepath: string): string => {
  const base = basename(filepath);
  // Remove leading dot for storage, but keep track that it was a dotfile
  return base.startsWith('.') ? base.slice(1) : base;
};

export const detectCategory = (filepath: string): string => {
  const expandedPath = expandPath(filepath);
  const relativePath = collapsePath(expandedPath);

  for (const [category, config] of Object.entries(CATEGORIES)) {
    for (const pattern of config.patterns) {
      // Check if the pattern matches the path
      if (relativePath.endsWith(pattern) || relativePath.includes(pattern)) {
        return category;
      }
      // Check just the filename
      const filename = basename(expandedPath);
      if (filename === pattern || filename === basename(pattern)) {
        return category;
      }
    }
  }

  return 'misc';
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

export const isFile = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
};

export const isSymlink = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
};

export const isReadable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

export const isWritable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export const getRelativePath = (from: string, to: string): string => {
  return relative(dirname(from), to);
};

/**
 * Validate that a path is safely within the user's home directory.
 * Prevents path traversal attacks from malicious manifests.
 * @returns true if the path is within home directory, false otherwise
 */
export const isPathWithinHome = (path: string): boolean => {
  const home = homedir();
  const expandedPath = expandPath(path);
  const normalizedPath = resolve(expandedPath);
  const normalizedHome = resolve(home);

  // Check if the normalized path starts with the home directory
  // Use path.sep for cross-platform compatibility (/ on POSIX, \ on Windows)
  return normalizedPath.startsWith(normalizedHome + sep) || normalizedPath === normalizedHome;
};

/**
 * Validate that a source path from a manifest is safe to use.
 * Throws an error if the path is unsafe (path traversal attempt).
 * Works on both Unix and Windows paths.
 */
export const validateSafeSourcePath = (source: string): void => {
  // Normalize the path for consistent checking
  const normalizedSource = normalizePath(source);
  const normalizedHome = normalizePath(homedir());

  // Reject absolute paths that don't start with home-relative prefixes
  if (isAbsolute(source) && !normalizedSource.startsWith(normalizedHome)) {
    throw new Error(
      `Unsafe path detected: ${source} - absolute paths outside home directory are not allowed`
    );
  }

  // Reject obvious path traversal attempts (check both separators)
  if (source.includes('../') || source.includes('..\\')) {
    throw new Error(`Unsafe path detected: ${source} - path traversal is not allowed`);
  }

  // Validate the expanded path is within home
  if (!isPathWithinHome(source)) {
    throw new Error(`Unsafe path detected: ${source} - paths must be within home directory`);
  }
};

/**
 * Generate a unique file ID from a source path.
 * Handles both Unix and Windows path separators.
 *
 * @param source - Source path to generate ID from
 * @returns Unique, filesystem-safe ID
 */
export const generateFileId = (source: string): string => {
  // Create a unique ID from the source path
  const collapsed = collapsePath(source);
  // Remove special characters and create a readable ID
  // Handle both / and \ path separators for cross-platform support
  return collapsed
    .replace(/^~[/\\]/, '') // Remove ~/ or ~\ prefix
    .replace(/[/\\]/g, '_') // Replace path separators with underscore
    .replace(/\./g, '-') // Replace dots with dashes
    .replace(/^-/, ''); // Remove leading dash
};
