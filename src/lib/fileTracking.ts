import chalk from 'chalk';
import ora from 'ora';
import {
  expandPath,
  collapsePath,
  getDestinationPathFromSource,
  getRelativeDestinationFromSource,
  generateFileId,
  detectCategory,
} from './paths.js';
import { addFileToManifest, loadManifest } from './manifest.js';
import { copyFileOrDir, createSymlink, deleteFileOrDir, getFileChecksum, getFileInfo } from './files.js';
import { loadConfig } from './config.js';
import { CATEGORIES } from '../constants.js';
import { ensureDir } from 'fs-extra';
import { dirname } from 'path';
import type { FileStrategy } from '../types.js';
import { toPosixPath } from './platform.js';

export interface FileToTrack {
  path: string;
  category?: string;
  name?: string;
}

export interface FileTrackingOptions {
  /**
   * Show category icons after file names
   */
  showCategory?: boolean;

  /**
   * Custom strategy (copy, symlink, etc.)
   */
  strategy?: FileStrategy;

  // TODO: Encryption and templating are planned for a future version
  // /**
  //  * Encrypt files
  //  */
  // encrypt?: boolean;
  //
  // /**
  //  * Treat as template
  //  */
  // template?: boolean;

  /**
   * Delay between file operations in milliseconds
   * Automatically reduced for large batches (>=50 files)
   */
  delayBetween?: number;

  /**
   * Action verb for display (e.g., "Tracking", "Adding", "Processing")
   */
  actionVerb?: string;

  /**
   * Callback called after each file is processed
   */
  onProgress?: (current: number, total: number) => void;
}

export interface FileTrackingResult {
  succeeded: number;
  failed: number;
  errors: Array<{ path: string; error: Error }>;
  sensitiveFiles: string[];
}

/**
 * Pattern matching for sensitive files
 */
const SENSITIVE_FILE_PATTERNS = [
  /^\.netrc$/,
  /^\.aws\/credentials$/,
  /^\.docker\/config\.json$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.kube\/config$/,
  /^\.ssh\/config$/,
  /^\.gnupg\//,
  /credentials/i,
  /secrets?/i,
  /tokens?\.json$/i,
  /\.env$/,
  /\.env\./,
];

/**
 * Check if a path contains potentially sensitive data
 */
const isSensitiveFile = (path: string): boolean => {
  const pathToTest = path.startsWith('~/') ? path.slice(2) : path;
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(pathToTest)) {
      return true;
    }
  }
  return false;
};

/**
 * Shared file tracking logic used by add, scan, and init commands.
 * Processes files one by one with beautiful progress display.
 * 
 * @param files - Array of files to track with their paths and optional categories
 * @param tuckDir - Path to the tuck directory
 * @param options - Options for tracking behavior and display
 * @returns Result containing success/failure counts and accumulated errors
 */
export const trackFilesWithProgress = async (
  files: FileToTrack[],
  tuckDir: string,
  options: FileTrackingOptions = {}
): Promise<FileTrackingResult> => {
  const {
    showCategory = true,
    strategy: customStrategy,
    // TODO: Encryption and templating are planned for a future version
    // encrypt = false,
    // template = false,
    actionVerb = 'Tracking',
    onProgress,
  } = options;

  // Adaptive delay: reduce delay for large batches
  let { delayBetween } = options;
  if (delayBetween === undefined) {
    delayBetween = files.length >= 50 ? 10 : 30; // 10ms for large batches, 30ms for small
  }

  const config = await loadConfig(tuckDir);
  const strategy: FileStrategy = customStrategy || config.files.strategy || 'copy';
  const total = files.length;
  const errors: Array<{ path: string; error: Error }> = [];
  const sensitiveFiles: string[] = [];
  const trackedDestinations = new Map<string, string>();
  let succeeded = 0;

  const manifest = await loadManifest(tuckDir);
  for (const existingFile of Object.values(manifest.files)) {
    trackedDestinations.set(toPosixPath(existingFile.destination), existingFile.source);
  }

  console.log();
  console.log(chalk.bold.cyan(`${actionVerb} ${total} ${total === 1 ? 'file' : 'files'}...`));
  console.log(chalk.dim('─'.repeat(50)));
  console.log();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const expandedPath = expandPath(file.path);
    const indexStr = chalk.dim(`[${i + 1}/${total}]`);
    const category = file.category || detectCategory(expandedPath);
    const categoryInfo = CATEGORIES[category];
    const icon = categoryInfo?.icon || '○';
    const sourcePath = collapsePath(file.path);
    const relativeDestination = getRelativeDestinationFromSource(category, expandedPath, file.name);
    const normalizedDestination = toPosixPath(relativeDestination);
    const existingSource = trackedDestinations.get(normalizedDestination);

    // Show spinner while processing
    const spinner = ora({
      text: `${indexStr} ${actionVerb} ${chalk.cyan(sourcePath)}`,
      color: 'cyan',
      spinner: 'dots',
      indent: 2,
    }).start();

    try {
      if (existingSource && existingSource !== sourcePath) {
        throw new Error(
          `Destination collision detected: ${relativeDestination} is already used by ${existingSource}`
        );
      }

      // Get destination path
      const destination = getDestinationPathFromSource(tuckDir, category, expandedPath, file.name);

      // Ensure category directory exists
      await ensureDir(dirname(destination));

      // Copy or symlink based on strategy
      if (strategy === 'symlink') {
        // Symlink strategy keeps the repository as source of truth:
        // 1) copy source into repo, 2) replace source with symlink to repo.
        await copyFileOrDir(expandedPath, destination, { overwrite: true });

        try {
          await createSymlink(destination, expandedPath, { overwrite: true });
        } catch (error) {
          // Best effort rollback so users keep a working source file if symlinking fails.
          await deleteFileOrDir(expandedPath).catch(() => undefined);
          await copyFileOrDir(destination, expandedPath, { overwrite: true }).catch(() => undefined);
          throw error;
        }
      } else {
        // Default: copy file into the repository
        await copyFileOrDir(expandedPath, destination, { overwrite: true });
      }

      // Get file info
      const checksum = await getFileChecksum(destination);
      const info = await getFileInfo(expandedPath);
      const now = new Date().toISOString();

      // Generate unique ID
      const id = generateFileId(file.path);

      // Add to manifest
      await addFileToManifest(tuckDir, id, {
        source: sourcePath,
        destination: relativeDestination,
        category,
        strategy,
        // TODO: Encryption and templating are planned for a future version
        encrypted: false,
        template: false,
        permissions: info.permissions,
        added: now,
        modified: now,
        checksum,
      });

      spinner.stop();
      const categoryStr = showCategory ? chalk.dim(` ${icon} ${category}`) : '';
      console.log(`  ${chalk.green('✓')} ${indexStr} ${sourcePath}${categoryStr}`);

      // Track sensitive files for warning at the end
      if (isSensitiveFile(sourcePath)) {
        sensitiveFiles.push(file.path);
      }

      trackedDestinations.set(normalizedDestination, sourcePath);

      succeeded++;

      // Call progress callback
      if (onProgress) {
        onProgress(i + 1, total);
      }

      // Small delay for visual effect (unless it's the last item)
      if (i < files.length - 1 && delayBetween > 0) {
        await new Promise(resolve => setTimeout(resolve, delayBetween));
      }
    } catch (error) {
      spinner.stop();
      const errorObj = error instanceof Error ? error : new Error(String(error));
      errors.push({ path: file.path, error: errorObj });
      console.log(`  ${chalk.red('✗')} ${indexStr} ${collapsePath(file.path)} ${chalk.red('- failed')}`);
    }
  }

  // Show summary
  console.log();
  if (succeeded > 0) {
    console.log(chalk.green('✓'), chalk.bold(`Tracked ${succeeded} ${succeeded === 1 ? 'file' : 'files'} successfully`));
  }

  // Show accumulated errors if any
  if (errors.length > 0) {
    console.log();
    console.log(chalk.red('✗'), chalk.bold(`Failed to track ${errors.length} ${errors.length === 1 ? 'file' : 'files'}:`));
    for (const { path, error } of errors) {
      console.log(chalk.dim(`   • ${collapsePath(path)}: ${error.message}`));
    }
  }

  // Warn about sensitive files at the end (not inline to avoid clutter)
  if (sensitiveFiles.length > 0) {
    console.log();
    console.log(chalk.yellow('⚠'), chalk.yellow('Warning: Some files may contain sensitive data:'));
    for (const path of sensitiveFiles) {
      console.log(chalk.dim(`   • ${collapsePath(path)}`));
    }
    console.log(chalk.dim('  Make sure your repository is private!'));
  }

  return {
    succeeded,
    failed: errors.length,
    errors,
    sensitiveFiles,
  };
};
