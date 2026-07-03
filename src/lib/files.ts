import { createHash, randomBytes } from 'crypto';
import {
  readFile,
  writeFile,
  rename,
  stat,
  lstat,
  readdir,
  copyFile,
  symlink,
  unlink,
  rm,
} from 'fs/promises';
import { copy, ensureDir } from 'fs-extra';
import { join, dirname, basename, relative } from 'path';
import { constants, lstatSync } from 'fs';
import { FileNotFoundError, PermissionError, TuckError } from '../errors.js';
import { expandPath, pathExists, isDirectory, validateSafeDestinationPath } from './paths.js';
import { allowedRoots } from './writeContext.js';
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

/**
 * Atomically write `content` to `filepath`.
 *
 * Writes to a uniquely-named temp file in the **same directory** (so the final
 * `rename` is a same-filesystem atomic swap), then renames it into place. A
 * crash, SIGINT, or ENOSPC mid-write therefore leaves the target as either its
 * previous content or the full new content — never a truncated fragment. This
 * is the only safe way to persist source-of-truth files (manifest, config,
 * secrets store).
 *
 * Mode resolution (in priority order):
 *   1. `options.mode` when provided (e.g. `0o600` for the secrets store).
 *   2. The existing file's mode when overwriting.
 *   3. `0o600` for new dotfiles (basename starting with `.`).
 *   4. The platform default otherwise.
 */
export const atomicWriteFile = async (
  filepath: string,
  content: string,
  options?: { mode?: number }
): Promise<void> => {
  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = join(dirname(filepath), `.${basename(filepath)}.tmp.${tempSuffix}`);

  try {
    let mode: number | undefined = options?.mode;

    if (mode === undefined) {
      let fileExists = false;
      try {
        const stats = await stat(filepath);
        mode = stats.mode;
        fileExists = true;
      } catch {
        // File does not exist yet.
      }
      // New security-sensitive dotfiles default to owner-only.
      if (!fileExists && basename(filepath).startsWith('.')) {
        mode = 0o600;
      }
    }

    const writeOptions: { encoding: 'utf-8'; mode?: number } = { encoding: 'utf-8' };
    if (typeof mode === 'number') writeOptions.mode = mode;
    await writeFile(tempPath, content, writeOptions);
    await rename(tempPath, filepath);
  } catch (error) {
    // Best-effort cleanup so a failed write never orphans a temp file.
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw error;
  }
};

export const getFileChecksum = async (filepath: string): Promise<string> => {
  const expandedPath = expandPath(filepath);

  if (await isDirectory(expandedPath)) {
    // For directories, hash each entry's RELATIVE PATH together with its content
    // so the digest is sensitive to renames, additions, and deletions — not just
    // raw content. (Hashing content alone meant a rename inside a tracked dir
    // produced an identical checksum and the change was silently never synced.)
    const files = await getDirectoryFiles(expandedPath);

    // Handle empty directories - return hash of empty string for consistency
    if (files.length === 0) {
      return createHash('sha256').update('').digest('hex');
    }

    const entries: string[] = [];
    for (const file of files) {
      const relPath = relative(expandedPath, file).replace(/\\/g, '/');
      const content = await readFile(file);
      const contentHash = createHash('sha256').update(content).digest('hex');
      entries.push(`${relPath}\0${contentHash}`);
    }
    // Deterministic order regardless of readdir order.
    entries.sort();

    return createHash('sha256').update(entries.join('\n')).digest('hex');
  }

  const content = await readFile(expandedPath);
  return createHash('sha256').update(content).digest('hex');
};

/**
 * Live-source stat cache for the mtime+size short-circuit.
 *
 * Returns `{ sourceMtimeMs, sourceSize }` ONLY for an existing regular file, so
 * the caller can persist them next to the recorded checksum and later skip
 * re-hashing an unchanged single file (see `stateModel.computeLiveChecksum`).
 *
 * Directories deliberately yield `{}`: a nested file change does not move a
 * directory's own mtime/size, so a stat short-circuit on a dir would MISS real
 * changes. Missing/inaccessible paths also yield `{}` (fall back to hashing).
 */
export const getSourceStatCache = async (
  filepath: string
): Promise<{ sourceMtimeMs?: number; sourceSize?: number }> => {
  const expandedPath = expandPath(filepath);
  try {
    const stats = await stat(expandedPath);
    if (!stats.isFile()) return {};
    return { sourceMtimeMs: stats.mtimeMs, sourceSize: stats.size };
  } catch {
    return {};
  }
};

export const getFileInfo = async (filepath: string): Promise<FileInfo> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    throw new FileNotFoundError(filepath);
  }

  try {
    const stats = await stat(expandedPath);
    const linkStats = await lstat(expandedPath);
    // On Windows, Unix-style permissions are not meaningful
    // Return a sensible default (644 for files, 755 for dirs)
    const permissions = IS_WINDOWS
      ? (stats.isDirectory() ? '755' : '644')
      : (stats.mode & 0o777).toString(8).padStart(3, '0');

    return {
      path: expandedPath,
      isDirectory: stats.isDirectory(),
      isSymlink: linkStats.isSymbolicLink(),
      size: stats.size,
      permissions,
      modified: stats.mtime,
    };
  } catch (error) {
    throw new PermissionError(filepath, 'read');
  }
};

/**
 * Result of a single recursive directory walk.
 *
 * `files` is the deterministically sorted list of tracked regular files (the
 * exact same list `getDirectoryFiles` returns). `totalSize` is the summed byte
 * size of those files, collected during the SAME walk so callers that need the
 * size never have to traverse the tree a second time.
 */
export interface DirectoryTreeStats {
  files: string[];
  totalSize: number;
}

// Names that are always skipped when walking a tracked directory. Kept in a
// single place so getDirectoryFiles and getDirectoryTreeStats can never drift.
const DIRECTORY_SKIP_PATTERNS = [
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

const shouldSkipEntry = (name: string): boolean =>
  DIRECTORY_SKIP_PATTERNS.some((pattern) => {
    if (pattern.includes('*')) {
      // Escape special regex characters (especially .) before replacing * with .*
      const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp('^' + escapedPattern + '$');
      return regex.test(name);
    }
    return name === pattern;
  });

/**
 * Single recursive walk shared by `getDirectoryFiles` and
 * `getDirectoryTreeStats`. Pushes regular-file paths into `accFiles` and, when
 * `collectSize` is true, adds each file's byte size to the returned running
 * total. Sizes come from the same `lstat` used for symlink detection — since
 * symlinks are skipped, every collected entry is a regular file whose `lstat`
 * size equals its `stat` size, so the total is identical to the previous
 * stat()-per-file approach.
 *
 * The file list is NOT sorted here; callers sort the fully-collected list so
 * ordering matches the historical (sort-after-recurse) behavior exactly.
 */
const walkDirectory = async (
  expandedPath: string,
  accFiles: string[],
  collectSize: boolean
): Promise<number> => {
  let entries;
  try {
    entries = await readdir(expandedPath, { withFileTypes: true });
  } catch (error) {
    // Handle permission errors and other read failures gracefully
    if (process.env.DEBUG) {
      console.warn(`[tuck] Warning: Could not read directory ${expandedPath}:`, error);
    }
    return 0;
  }

  let totalSize = 0;

  for (const entry of entries) {
    const entryPath = join(expandedPath, entry.name);

    if (shouldSkipEntry(entry.name)) {
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
        totalSize += await walkDirectory(entryPath, accFiles, collectSize);
      } else if (entry.isFile()) {
        accFiles.push(entryPath);
        if (collectSize) {
          // Same size stat() would report for a regular (non-symlink) file.
          totalSize += lstats.size;
        }
      }
    } catch (error) {
      // Skip entries we can't access (permission errors, etc.)
      if (process.env.DEBUG) {
        console.warn(`[tuck] Warning: Could not access ${entryPath}:`, error);
      }
      continue;
    }
  }

  return totalSize;
};

export const getDirectoryFiles = async (dirpath: string): Promise<string[]> => {
  const expandedPath = expandPath(dirpath);
  const files: string[] = [];
  await walkDirectory(expandedPath, files, false);
  return files.sort();
};

/**
 * Walk a directory tree ONCE, returning both the (sorted) file list and the
 * total byte size of those files. Use this instead of calling
 * `getDirectoryFiles`/`getDirectoryFileCount` and then re-walking to stat each
 * file when you need the size — it produces an identical file list and size
 * while traversing the tree a single time.
 */
export const getDirectoryTreeStats = async (
  dirpath: string
): Promise<DirectoryTreeStats> => {
  const expandedPath = expandPath(dirpath);
  const files: string[] = [];
  const totalSize = await walkDirectory(expandedPath, files, true);
  return { files: files.sort(), totalSize };
};

export const getDirectoryFileCount = async (dirpath: string): Promise<number> => {
  const files = await getDirectoryFiles(dirpath);
  return files.length;
};

/**
 * Convert a single glob pattern (as used in detect.ts pattern `exclude` lists,
 * e.g. "logs", "cache", "projects/[globstar]/*.jsonl", "[globstar]/*.db") into
 * an anchored RegExp matched against a POSIX relative path. A globstar ("**")
 * matches across path separators (including zero segments); a single "*"
 * matches within one segment only.
 */
const excludeGlobToRegExp = (glob: string): RegExp => {
  const g = glob.replace(/\\/g, '/').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\?'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$');
};

/**
 * True when a POSIX relative path should be excluded from a directory copy by
 * any of the given patterns. A bare name (no slash, no wildcard) matches that
 * name at ANY depth (so `logs` skips a `logs/` subdirectory wherever it sits);
 * patterns with separators/wildcards are matched against the full relative path.
 */
export const matchesExcludePattern = (relPosix: string, patterns: string[]): boolean => {
  if (!relPosix) return false;
  for (const raw of patterns) {
    const pat = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!pat) continue;
    if (!pat.includes('/') && !pat.includes('*')) {
      if (relPosix.split('/').includes(pat)) return true;
      continue;
    }
    if (excludeGlobToRegExp(pat).test(relPosix)) return true;
  }
  return false;
};

export const copyFileOrDir = async (
  source: string,
  destination: string,
  options?: { overwrite?: boolean; exclude?: string[] }
): Promise<CopyResult> => {
  const expandedSource = expandPath(source);
  const expandedDest = expandPath(destination);

  if (!(await pathExists(expandedSource))) {
    throw new FileNotFoundError(source);
  }

  // Validate against the active allowed roots ($HOME + bound repo roots, or the
  // sandbox root) — not just $HOME — so repo-scoped writes to a bound checkout
  // outside home are permitted while everything else stays confined.
  validateSafeDestinationPath(expandedDest, allowedRoots());

  // Ensure destination directory exists
  await ensureDir(dirname(expandedDest));

  const sourceIsDir = await isDirectory(expandedSource);
  const shouldOverwrite = options?.overwrite ?? true;

  // When overwrite is disabled, never silently MERGE a source directory into an
  // already-populated target directory: fs-extra's copy would happily union the
  // two trees, leaving the caller unaware its config landed on top of someone
  // else's. Fail clearly instead, mirroring the EEXIST guard COPYFILE_EXCL gives
  // single files below. (We check before any directory is created or copied.)
  if (sourceIsDir && !shouldOverwrite && (await pathExists(expandedDest))) {
    throw new TuckError(
      `Destination already exists: ${expandedDest}`,
      'DESTINATION_EXISTS',
      [
        'Remove or rename the existing destination first',
        'Pass overwrite to replace it (only if you intend to)',
      ]
    );
  }

  try {
    if (sourceIsDir) {
      const excludePatterns = options?.exclude ?? [];
      // Copy directory but skip .git and other problematic files
      await copy(expandedSource, expandedDest, {
        overwrite: shouldOverwrite,
        errorOnExist: !shouldOverwrite,
        filter: (src: string) => {
          const name = basename(src);
          // Use the SAME skip predicate as the directory walk that computes
          // checksums (shouldSkipEntry / DIRECTORY_SKIP_PATTERNS), so the copied
          // repo tree exactly matches the checksummed tree. Otherwise a copied
          // nested .gitignore could silently exclude sibling tracked files from
          // commits, and edits to skipped names (e.g. .npmrc) would never
          // register as drift yet get reverted by apply/restore.
          if (shouldSkipEntry(name)) return false;
          // SECURITY (symlink TOCTOU): never recreate an in-tree symlink onto the
          // live system. A committed symlink — especially one whose target
          // escapes $HOME — would be planted verbatim, and a subsequent write
          // through it could escape confinement. Copy file/dir CONTENT, never
          // link topology. Sync stat only: fs-extra treats a Promise-returning
          // filter as always-true, so an async check would silently no-op.
          try {
            if (lstatSync(src).isSymbolicLink()) return false;
          } catch {
            // Undeterminable → fall through; the apply write-path guard
            // (assertRealTargetWithinRoots) is the authoritative confinement.
          }
          // Honor pattern-declared excludes (e.g. ~/.claude excludes
          // projects/**/*.jsonl transcripts, caches) so ephemeral/sensitive
          // content is never copied into the repo.
          if (excludePatterns.length > 0) {
            const rel = relative(expandedSource, src).split('\\').join('/');
            if (matchesExcludePattern(rel, excludePatterns)) return false;
          }
          return true;
        }
      });
      // Single walk: collect the file list AND its total size in one traversal
      // (was previously a getDirectoryFileCount + getDirectoryFiles + per-file
      // stat — three passes over the same tree).
      const { files, totalSize } = await getDirectoryTreeStats(expandedDest);
      return {
        source: expandedSource,
        destination: expandedDest,
        fileCount: files.length,
        totalSize,
      };
    } else {
      // Use COPYFILE_EXCL flag to prevent overwriting when overwrite is false
      // If overwrite is true (default), use mode 0 which allows overwriting
      const copyFlags = shouldOverwrite ? 0 : constants.COPYFILE_EXCL;
      await copyFile(expandedSource, expandedDest, copyFlags);
      const stats = await stat(expandedDest);
      return { source: expandedSource, destination: expandedDest, fileCount: 1, totalSize: stats.size };
    }
  } catch (error) {
    // Preserve the REAL failure cause. A blanket PermissionError hid whether the
    // copy ran out of disk (ENOSPC), hit a missing path (ENOENT), or collided
    // with an existing target (EEXIST) — all of which need different handling
    // upstream. Only translate genuine permission failures into PermissionError;
    // rethrow everything else with its original .code/.errno intact.
    if (error instanceof TuckError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === undefined) {
      throw new PermissionError(destination, 'write');
    }
    throw error;
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

  validateSafeDestinationPath(expandedLink, allowedRoots());

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
