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
import { copyFileOrDir, createSymlink, getFileChecksum, getFileInfo, getSourceStatCache } from './files.js';
import { loadConfig } from './config.js';
import { CATEGORIES } from '../constants.js';
import { ensureDir } from 'fs-extra';
import { dirname, join } from 'path';
import type { FileStrategy } from '../types.js';
import { toPosixPath } from './platform.js';
import { bindRepo } from './repoScope.js';
import { readFile, writeFile } from 'fs/promises';
import { encryptFileContent } from './crypto/fileEncryption.js';
import { keystorePassphrase } from './materialize.js';
import { EncryptionError } from '../errors.js';

export interface FileToTrack {
  path: string;
  category?: string;
  name?: string;
  /** Bundle to assign the tracked file to. Defaults to "default". */
  bundle?: string;
  /**
   * Repo-scoped tracking metadata. When `scope === 'repo'` the file lives inside
   * a git repo whose absolute path differs per machine; it is stored by stable
   * (repoKey, repoRelative) and the precomputed repo-scoped `destination`/`source`
   * are used verbatim instead of being derived from a home-relative path.
   */
  scope?: 'home' | 'repo';
  /** Stable cross-machine repo identity (repo scope only). */
  repoKey?: string;
  /** POSIX path relative to the repo root (repo scope only). */
  repoRelative?: string;
  /** Absolute repo root on THIS machine (repo scope only). */
  repoRoot?: string;
  /** Canonicalized remote URL, recorded in the binding when known. */
  remoteUrl?: string;
  /** Manifest source identity to store verbatim (repo scope only). */
  source?: string;
  /** Relative manifest destination to store verbatim (repo scope only). */
  destination?: string;
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

  /** Encrypt the file at rest in the repo using the keystore passphrase (decrypted on apply). */
  encrypt?: boolean;

  /** Mark the file as a template — stored verbatim, rendered on apply/restore. */
  template?: boolean;

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
    encrypt = false,
    template = false,
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

  // Encrypted/template files are COPY-ONLY: they are decrypted/rendered into place
  // on apply, never symlinked (a symlink would expose ciphertext or the raw {{ }}
  // source at the live path). Reject the combination up front with a clear message.
  if ((encrypt || template) && strategy === 'symlink') {
    throw new Error(
      'The symlink strategy cannot be combined with --encrypt/--template: these files are copied (and decrypted/rendered on apply), not linked.'
    );
  }
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
    const isRepo = file.scope === 'repo';
    const expandedPath = expandPath(file.path);
    const indexStr = chalk.dim(`[${i + 1}/${total}]`);
    const category = file.category || detectCategory(expandedPath);
    const categoryInfo = CATEGORIES[category];
    const icon = categoryInfo?.icon || '○';
    // Repo-scoped files store a stable `<repoKey>:<repoRelative>` source and a
    // precomputed, namespaced destination; home-scoped files derive both from
    // the home-relative path.
    const sourcePath = isRepo ? (file.source ?? file.path) : collapsePath(file.path);
    const relativeDestination =
      isRepo && file.destination
        ? file.destination
        : getRelativeDestinationFromSource(category, expandedPath, file.name);
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

      // Get destination path (absolute, inside the tuck repo).
      const destination = isRepo && file.destination
        ? join(tuckDir, file.destination)
        : getDestinationPathFromSource(tuckDir, category, expandedPath, file.name);

      // Ensure destination directory exists
      await ensureDir(dirname(destination));

      // Capture the LIVE source's stat BEFORE the copy/symlink, so the recorded
      // mtime+size correspond to the content we are about to hash. If the file
      // were edited mid-track, the live file then diverges from this stat and the
      // next status re-hashes (rather than trusting a now-stale checksum). Empty
      // (no fields) for directories — they are never short-circuited.
      const statCache = await getSourceStatCache(expandedPath);

      // Copy or symlink based on strategy. Repo-scoped tracking is copy-only:
      // the live file stays put inside its repo checkout (never symlinked).
      if (strategy === 'symlink' && !isRepo) {
        // Symlink strategy keeps the repository as source of truth. Order is
        // safety-critical:
        //   1) Copy source into the repo FIRST so a durable copy exists before
        //      we touch the user's original at all.
        //   2) Only then replace the source with a symlink to the repo copy.
        // The original is never removed by us until the durable repo copy is in
        // place — createSymlink performs the replacement against that durable
        // copy, so if it fails we can always restore from the repo.
        await copyFileOrDir(expandedPath, destination, { overwrite: true });

        try {
          await createSymlink(destination, expandedPath, { overwrite: true });
        } catch (symlinkError) {
          // The symlink failed. createSymlink's overwrite step may have already
          // removed the user's original source, so restore it from the durable
          // repo copy. NEVER swallow errors here: if the restore ALSO fails the
          // user could be left without their file, and they must be told loudly.
          try {
            await copyFileOrDir(destination, expandedPath, { overwrite: true });
          } catch (restoreError) {
            const symlinkMsg =
              symlinkError instanceof Error ? symlinkError.message : String(symlinkError);
            const restoreMsg =
              restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new Error(
              `Failed to create symlink for ${collapsePath(file.path)} (${symlinkMsg}) ` +
                `and restoring the original from the repository copy also failed (${restoreMsg}). ` +
                `A durable copy may remain at ${destination}.`
            );
          }
          // Restore succeeded: surface the original symlink failure so the
          // caller records it and the user is never told this silently "worked".
          throw symlinkError;
        }
      } else if (encrypt) {
        // Encrypt at rest: store TCKE1 ciphertext in the repo (decrypted on apply).
        const passphrase = await keystorePassphrase();
        if (!passphrase) {
          throw new EncryptionError('No encryption password set. Run `tuck encryption setup` first.');
        }
        const plaintext = await readFile(expandedPath);
        await writeFile(destination, await encryptFileContent(plaintext, passphrase));
      } else {
        // Default: copy file into the repository (from the absolute live path).
        await copyFileOrDir(expandedPath, destination, { overwrite: true });
      }

      // Get file info
      const checksum = await getFileChecksum(destination);
      const info = await getFileInfo(expandedPath);
      const now = new Date().toISOString();

      // Generate unique ID (from the stable identity for repo files).
      const id = generateFileId(sourcePath);

      // Add to manifest
      await addFileToManifest(tuckDir, id, {
        source: sourcePath,
        destination: relativeDestination,
        category,
        // Repo scope is copy-only regardless of the configured global strategy.
        strategy: isRepo ? 'copy' : strategy,
        encrypted: encrypt,
        template,
        permissions: info.permissions,
        added: now,
        modified: now,
        checksum,
        ...statCache,
        bundle: file.bundle ?? 'default',
        ...(isRepo
          ? {
              scope: 'repo' as const,
              repoKey: file.repoKey,
              repoRelative: file.repoRelative,
            }
          : {}),
      });

      // Bind the repo on THIS machine so the stable key resolves to the live
      // root for later sync/restore. Idempotent upsert.
      if (isRepo && file.repoKey && file.repoRoot) {
        await bindRepo(file.repoKey, file.repoRoot, {
          ...(file.remoteUrl ? { remoteUrl: file.remoteUrl } : {}),
        });
      }

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
