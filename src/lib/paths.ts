import { homedir } from 'os';
import { join, basename, dirname, relative, isAbsolute, resolve, sep, posix } from 'path';
import { stat, lstat, access } from 'fs/promises';
import { constants } from 'fs';
import {
  DEFAULT_TUCK_DIR,
  FILES_DIR,
  MANIFEST_FILE,
  CONFIG_FILE,
  CATEGORIES,
} from '../constants.js';
import { IS_WINDOWS, expandWindowsEnvVars, toPosixPath } from './platform.js';

export const expandPath = (path: string): string => {
  // Handle Windows environment variables first
  if (IS_WINDOWS) {
    path = expandWindowsEnvVars(path);
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith('$HOME/')) {
    return join(homedir(), path.slice(6));
  }
  return isAbsolute(path) ? path : resolve(path);
};

export const collapsePath = (path: string): string => {
  const home = homedir();
  // Normalize both to forward slashes for comparison (cross-platform)
  // This handles cases where homedir() and path use different separators
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedHome = home.replace(/\\/g, '/');

  if (normalizedPath.startsWith(normalizedHome)) {
    // After slicing, the remainder is already normalized to forward slashes
    const remainder = normalizedPath.slice(normalizedHome.length);
    return '~' + remainder;
  }
  return path;
};

export const getTuckDir = (customDir?: string): string => {
  const tuckDir = expandPath(customDir || DEFAULT_TUCK_DIR);

  // For custom directories, enforce home-scoped paths for safety.
  if (customDir && !isPathWithinHome(customDir)) {
    throw new Error(
      `Unsafe path detected: ${customDir} - custom tuck directory must be within home directory`
    );
  }

  return tuckDir;
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
  return posix.join(FILES_DIR, toPosixPath(category), toPosixPath(filename));
};

/**
 * Convert a source path to a normalized path relative to the user's home directory.
 * Returns POSIX separators for cross-platform manifest stability.
 */
export const getHomeRelativeSourcePath = (sourcePath: string): string => {
  const expandedSource = resolve(expandPath(sourcePath));
  const resolvedHome = resolve(homedir());

  if (!(expandedSource === resolvedHome || expandedSource.startsWith(resolvedHome + sep))) {
    throw new Error(
      `Unsafe path detected: ${sourcePath} - source path must be within home directory`
    );
  }

  const relativePath = toPosixPath(relative(resolvedHome, expandedSource));
  const segments = relativePath
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== '.');

  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Unsafe path detected: ${sourcePath} - path traversal is not allowed`);
  }

  return segments.length > 0 ? segments.join('/') : 'home';
};

/**
 * Get repository destination for a source path.
 * Uses the full home-relative path to avoid filename collisions.
 */
export const getRelativeDestinationFromSource = (
  category: string,
  sourcePath: string,
  customFilename?: string
): string => {
  const relativeSource = getHomeRelativeSourcePath(sourcePath).split('/');

  if (customFilename) {
    const sanitizedCustomName = sanitizeFilename(customFilename);
    relativeSource[relativeSource.length - 1] = toPosixPath(sanitizedCustomName);
  }

  return posix.join(FILES_DIR, toPosixPath(category), ...relativeSource);
};

/**
 * Get absolute repository destination for a source path.
 */
export const getDestinationPathFromSource = (
  tuckDir: string,
  category: string,
  sourcePath: string,
  customFilename?: string
): string => {
  return join(tuckDir, getRelativeDestinationFromSource(category, sourcePath, customFilename));
};

export const sanitizeFilename = (filepath: string): string => {
  const base = basename(filepath);
  // Remove leading dot for storage, but keep track that it was a dotfile
  const result = base.startsWith('.') ? base.slice(1) : base;
  // Guard against '.' and '..' collapsing to non-file segments.
  if (result === '.' || result === '..') {
    return 'file';
  }
  // If result is empty (e.g., input was just '.'), return 'file' as fallback
  return result || 'file';
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
    const stats = await lstat(path);
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

  // Detect Windows-style absolute paths on all platforms
  // This catches cross-platform attacks in manifests
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
    return false;
  }

  // Detect traversal patterns with either separator on all platforms
  // This catches Windows-style attacks on Unix systems
  if (path.includes('..\\') || path.includes('../')) {
    // Normalize the path by replacing \ with / for consistent checking
    const normalizedForCheck = path.replace(/\\/g, '/');
    const expandedCheck = expandPath(normalizedForCheck);
    const resolvedCheck = resolve(expandedCheck);
    const normalizedHome = resolve(home);

    // Check if resolved path is still within home
    if (!resolvedCheck.startsWith(normalizedHome + sep) && resolvedCheck !== normalizedHome) {
      return false;
    }
  }

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
 */
export const validateSafeSourcePath = (source: string): void => {
  // Reject absolute paths that don't start with home-relative prefixes
  if (isAbsolute(source) && !source.startsWith(homedir())) {
    throw new Error(
      `Unsafe path detected: ${source} - absolute paths outside home directory are not allowed`
    );
  }

  // Reject obvious path traversal attempts
  if (source.includes('../') || source.includes('..\\')) {
    throw new Error(`Unsafe path detected: ${source} - path traversal is not allowed`);
  }

  // Validate the expanded path is within home
  if (!isPathWithinHome(source)) {
    throw new Error(`Unsafe path detected: ${source} - paths must be within home directory`);
  }
};

/**
 * Validate that a path resolves inside a specific root directory.
 * Throws if the path escapes that root.
 */
export const validatePathWithinRoot = (
  pathToValidate: string,
  root: string,
  label = 'path'
): void => {
  const resolvedPath = resolve(expandPath(pathToValidate));
  const resolvedRoot = resolve(expandPath(root));

  const isWithinRoot =
    resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);

  if (!isWithinRoot) {
    throw new Error(
      `Unsafe ${label} path detected: ${pathToValidate} - path must be within ${root}`
    );
  }
};

/**
 * Validate that a manifest destination is a safe, relative repository path.
 * Destinations must stay under the `files/` directory.
 */
export const validateSafeManifestDestination = (destination: string): void => {
  const trimmedDestination = destination.trim();

  if (!trimmedDestination) {
    throw new Error('Unsafe manifest destination detected: destination cannot be empty');
  }

  // Detect absolute paths on all platforms (including Windows-style on Unix)
  if (
    isAbsolute(trimmedDestination) ||
    /^[A-Za-z]:[\\/]/.test(trimmedDestination) ||
    trimmedDestination.startsWith('\\\\')
  ) {
    throw new Error(
      `Unsafe manifest destination detected: ${destination} - destination must be a relative path`
    );
  }

  // Normalize separators for cross-platform traversal checks
  const normalized = trimmedDestination.replace(/\\/g, '/');
  if (normalized.includes('../') || normalized.split('/').includes('..')) {
    throw new Error(
      `Unsafe manifest destination detected: ${destination} - path traversal is not allowed`
    );
  }

  if (!(normalized === FILES_DIR || normalized.startsWith(`${FILES_DIR}/`))) {
    throw new Error(
      `Unsafe manifest destination detected: ${destination} - destination must be inside ${FILES_DIR}/`
    );
  }
};

/**
 * Resolve a manifest destination to an absolute repository path safely.
 * Ensures the destination is a valid manifest path and cannot escape the tuck root.
 */
export const getSafeRepoPathFromDestination = (tuckDir: string, destination: string): string => {
  validateSafeManifestDestination(destination);
  const repoPath = join(tuckDir, destination);
  validatePathWithinRoot(repoPath, tuckDir, 'manifest destination');
  return repoPath;
};

/**
 * Validate that a destination path is safely within an allowed root.
 * Defaults to the user's home directory if no explicit roots are provided.
 */
export const validateSafeDestinationPath = (
  destination: string,
  allowedRoots?: string[]
): void => {
  const resolvedDestination = resolve(expandPath(destination));
  const roots = (allowedRoots && allowedRoots.length > 0 ? allowedRoots : [homedir()]).map((r) =>
    resolve(expandPath(r))
  );

  const isWithinAllowedRoot = roots.some((root) => {
    try {
      validatePathWithinRoot(resolvedDestination, root, 'destination');
      return true;
    } catch {
      return false;
    }
  });

  if (!isWithinAllowedRoot) {
    throw new Error(
      `Unsafe destination path detected: ${destination} - destination must be within allowed roots`
    );
  }
};

export const generateFileId = (source: string): string => {
  // Create a unique ID from the source path
  const collapsed = collapsePath(source);
  // Normalize to POSIX-style (forward slashes) before processing for cross-platform consistency
  const normalized = toPosixPath(collapsed);
  // Remove special characters and create a readable ID
  // 1. Remove ~/ prefix
  // 2. Replace / with _
  // 3. Replace . with -
  // 4. Strip all remaining unsafe characters (keep only a-z, A-Z, 0-9, _, -)
  // 5. Remove leading - if present
  return normalized
    .replace(/^~\//, '')
    .replace(/\//g, '_')
    .replace(/\./g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/^-/, '');
};
