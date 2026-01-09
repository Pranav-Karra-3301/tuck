import { Command } from 'commander';
import { basename } from 'path';
import chalk from 'chalk';
import { prompts, logger } from '../ui/index.js';
import {
  getTuckDir,
  expandPath,
  collapsePath,
  pathExists,
  isDirectory,
  detectCategory,
  sanitizeFilename,
  getDestinationPath,
} from '../lib/paths.js';
import {
  isFileTracked,
  loadManifest,
} from '../lib/manifest.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { NotInitializedError, FileNotFoundError, FileAlreadyTrackedError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { AddOptions } from '../types.js';
import { getDirectoryFileCount, checkFileSizeThreshold, formatFileSize } from '../lib/files.js';
import { shouldExcludeFromBin } from '../lib/binary.js';
import { addToTuckignore, isIgnored } from '../lib/tuckignore.js';
import { loadConfig } from '../lib/config.js';
import {
  scanForSecrets,
  processSecretsForRedaction,
  redactFile,
  type ScanSummary,
} from '../lib/secrets/index.js';

// SSH private key patterns - NEVER allow these
const PRIVATE_KEY_PATTERNS = [
  /^id_rsa$/,
  /^id_dsa$/,
  /^id_ecdsa$/,
  /^id_ed25519$/,
  /^id_.*$/,  // Any id_ file without .pub
  /\.pem$/,
  /\.key$/,
  /^.*_key$/,  // aws_key, github_key, etc.
];

// Files that should trigger a warning
const SENSITIVE_FILE_PATTERNS = [
  /^\.netrc$/,
  /^\.aws\/credentials$/,
  /^\.docker\/config\.json$/,
  /^\.npmrc$/,      // May contain tokens
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
 * Check if a path is a private key (should never be tracked)
 */
const isPrivateKey = (path: string): boolean => {
  const name = basename(path);

  // SSH private keys (without .pub extension)
  if (path.includes('.ssh/') && !name.endsWith('.pub')) {
    for (const pattern of PRIVATE_KEY_PATTERNS) {
      if (pattern.test(name)) {
        return true;
      }
    }
  }

  // Other private key patterns
  if (name.endsWith('.pem') || name.endsWith('.key')) {
    return true;
  }

  return false;
};

/**
 * Check if a path contains potentially sensitive data
 */
const isSensitiveFile = (path: string): boolean => {
  // Strip ~/ prefix if present, since patterns with ^ anchor expect paths without it
  // e.g., ~/.netrc should match /^\.netrc$/ pattern
  const pathToTest = path.startsWith('~/') ? path.slice(2) : path;

  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(pathToTest)) {
      return true;
    }
  }
  return false;
};

interface FileToAdd {
  source: string;
  destination: string;
  category: string;
  filename: string;
  isDir: boolean;
  fileCount: number;
  sensitive: boolean;
}

const validateAndPrepareFiles = async (
  paths: string[],
  tuckDir: string,
  options: AddOptions
): Promise<FileToAdd[]> => {
  const filesToAdd: FileToAdd[] = [];

  for (const path of paths) {
    const expandedPath = expandPath(path);
    const collapsedPath = collapsePath(expandedPath);

    // SECURITY: Block private keys
    if (isPrivateKey(collapsedPath)) {
      throw new Error(
        `Cannot track private key: ${path}\n` +
        `Private keys should NEVER be committed to a repository.\n` +
        `If you need to backup SSH keys, use a secure password manager.`
      );
    }

    // Check if file exists
    if (!(await pathExists(expandedPath))) {
      throw new FileNotFoundError(path);
    }

    // Check if already tracked
    if (await isFileTracked(tuckDir, collapsedPath)) {
      throw new FileAlreadyTrackedError(path);
    }

    // Check if in .tuckignore
    if (await isIgnored(tuckDir, collapsedPath)) {
      logger.info(`Skipping ${path} (in .tuckignore)`);
      continue;
    }

    // Check if binary executable in bin directory
    if (await shouldExcludeFromBin(expandedPath)) {
      const sizeCheck = await checkFileSizeThreshold(expandedPath);
      logger.info(
        `Skipping binary executable: ${path}${sizeCheck.size > 0 ? ` (${formatFileSize(sizeCheck.size)})` : ''}` +
        ` - Add to .tuckignore to customize`
      );
      continue;
    }

    // Check file size
    const sizeCheck = await checkFileSizeThreshold(expandedPath);

    if (sizeCheck.block) {
      // >= 100MB: Block and offer to ignore
      logger.warning(
        `File ${path} is ${formatFileSize(sizeCheck.size)} (exceeds GitHub's 100MB limit)`
      );
      
      const action = await prompts.select(
        'How would you like to proceed?',
        [
          { value: 'ignore', label: 'Add to .tuckignore and skip' },
          { value: 'cancel', label: 'Cancel operation' },
        ]
      );
      
      if (action === 'ignore') {
        await addToTuckignore(tuckDir, collapsedPath);
        logger.success(`Added ${path} to .tuckignore`);
        continue; // Skip this file
      } else {
        throw new Error('Operation cancelled');
      }
    }

    if (sizeCheck.warn) {
      // 50-100MB: Warn and confirm
      logger.warning(
        `File ${path} is ${formatFileSize(sizeCheck.size)}. ` +
        `GitHub recommends files under 50MB.`
      );
      
      const action = await prompts.select(
        'How would you like to proceed?',
        [
          { value: 'continue', label: 'Track it anyway' },
          { value: 'ignore', label: 'Add to .tuckignore and skip' },
          { value: 'cancel', label: 'Cancel operation' },
        ]
      );
      
      if (action === 'ignore') {
        await addToTuckignore(tuckDir, collapsedPath);
        logger.success(`Added ${path} to .tuckignore`);
        continue;
      } else if (action === 'cancel') {
        throw new Error('Operation cancelled');
      }
      // 'continue' falls through to track the file
    }

    // Determine if it's a directory
    const isDir = await isDirectory(expandedPath);
    const fileCount = isDir ? await getDirectoryFileCount(expandedPath) : 1;

    // Determine category
    const category = options.category || detectCategory(expandedPath);

    // Generate filename for storage
    const filename = options.name || sanitizeFilename(expandedPath);

    // Determine destination path
    const destination = getDestinationPath(tuckDir, category, filename);

    // Check if sensitive
    const sensitive = isSensitiveFile(collapsedPath);

    filesToAdd.push({
      source: collapsedPath,
      destination,
      category,
      filename,
      isDir,
      fileCount,
      sensitive,
    });
  }

  return filesToAdd;
};

const addFiles = async (
  filesToAdd: FileToAdd[],
  tuckDir: string,
  options: AddOptions
): Promise<void> => {
  // Convert FileToAdd to FileToTrack
  const filesToTrack: FileToTrack[] = filesToAdd.map(f => ({
    path: f.source,
    category: f.category,
  }));

  // Use the shared tracking utility
  await trackFilesWithProgress(filesToTrack, tuckDir, {
    showCategory: true,
    strategy: options.symlink ? 'symlink' : undefined,
    actionVerb: 'Tracking',
  });
};

// ============================================================================
// Secret Scanning Integration
// ============================================================================

/**
 * Display scan results in a formatted way
 */
const displaySecretWarning = (summary: ScanSummary): void => {
  console.log();
  console.log(chalk.bold.red(`  Security Warning: Found ${summary.totalSecrets} potential secret(s)`));
  console.log();

  for (const result of summary.results) {
    console.log(`  ${chalk.cyan(result.collapsedPath)}`);

    for (const match of result.matches) {
      const severityColor =
        match.severity === 'critical'
          ? chalk.red
          : match.severity === 'high'
            ? chalk.yellow
            : match.severity === 'medium'
              ? chalk.blue
              : chalk.dim;

      console.log(
        `    ${chalk.dim(`Line ${match.line}:`)} ${match.redactedValue} ${severityColor(`[${match.severity}]`)}`
      );
    }
    console.log();
  }
};

/**
 * Handle secret detection with interactive user prompt
 * Returns true if operation should continue, false if aborted
 */
const handleSecretsDetected = async (
  summary: ScanSummary,
  filesToAdd: FileToAdd[],
  tuckDir: string
): Promise<{ continue: boolean; filesToAdd: FileToAdd[] }> => {
  displaySecretWarning(summary);

  const action = await prompts.select('How would you like to proceed?', [
    {
      value: 'abort',
      label: 'Abort operation',
      hint: 'Do not track these files',
    },
    {
      value: 'redact',
      label: 'Replace with placeholders',
      hint: 'Store originals in secrets.local.json (never committed)',
    },
    {
      value: 'ignore',
      label: 'Add files to .tuckignore',
      hint: 'Skip these files permanently',
    },
    {
      value: 'proceed',
      label: 'Proceed anyway',
      hint: 'Track files with secrets (dangerous!)',
    },
  ]);

  switch (action) {
    case 'abort':
      logger.info('Operation aborted');
      return { continue: false, filesToAdd: [] };

    case 'redact': {
      // Process secrets for redaction
      const redactionMaps = await processSecretsForRedaction(summary.results, tuckDir);

      // Redact each file
      let totalRedacted = 0;
      for (const result of summary.results) {
        const placeholderMap = redactionMaps.get(result.path);
        if (placeholderMap && placeholderMap.size > 0) {
          const redactionResult = await redactFile(result.path, result.matches, placeholderMap);
          totalRedacted += redactionResult.replacements.length;
        }
      }

      console.log();
      logger.success(`Replaced ${totalRedacted} secret(s) with placeholders`);
      logger.dim('Secrets stored in: ~/.tuck/secrets.local.json (never committed)');
      logger.dim("Run 'tuck secrets list' to see stored secrets");
      console.log();

      return { continue: true, filesToAdd };
    }

    case 'ignore': {
      // Add files with secrets to .tuckignore
      const filesWithSecrets = new Set(summary.results.map((r) => r.collapsedPath));

      for (const file of filesToAdd) {
        if (filesWithSecrets.has(file.source)) {
          await addToTuckignore(tuckDir, file.source);
          logger.success(`Added ${file.source} to .tuckignore`);
        }
      }

      // Remove files with secrets from the list
      const remainingFiles = filesToAdd.filter((f) => !filesWithSecrets.has(f.source));

      if (remainingFiles.length === 0) {
        logger.info('No files remaining to track');
        return { continue: false, filesToAdd: [] };
      }

      return { continue: true, filesToAdd: remainingFiles };
    }

    case 'proceed': {
      // Double-confirm for dangerous action
      const confirmed = await prompts.confirm(
        chalk.red('Are you SURE you want to track files containing secrets?'),
        false
      );

      if (!confirmed) {
        logger.info('Operation aborted');
        return { continue: false, filesToAdd: [] };
      }

      logger.warning('Proceeding with secrets - be careful not to push to a public repository!');
      return { continue: true, filesToAdd };
    }

    default:
      return { continue: false, filesToAdd: [] };
  }
};

/**
 * Scan files for secrets and handle results
 * Returns updated filesToAdd list (may be modified by user choices)
 */
const scanAndHandleSecrets = async (
  filesToAdd: FileToAdd[],
  tuckDir: string,
  options: AddOptions
): Promise<{ continue: boolean; filesToAdd: FileToAdd[] }> => {
  // Check if scanning is enabled
  const config = await loadConfig(tuckDir);
  const security = config.security || {};

  // Skip scanning if disabled or --force is used
  if (security.scanSecrets === false || options.force) {
    return { continue: true, filesToAdd };
  }

  // Get file paths for scanning
  const filePaths = filesToAdd.map((f) => expandPath(f.source));

  // Scan files
  const summary = await scanForSecrets(filePaths, tuckDir);

  // If no secrets found, continue normally
  if (summary.filesWithSecrets === 0) {
    return { continue: true, filesToAdd };
  }

  // Handle detected secrets
  return handleSecretsDetected(summary, filesToAdd, tuckDir);
};

const runInteractiveAdd = async (tuckDir: string): Promise<void> => {
  prompts.intro('tuck add');

  // Ask for paths
  const pathsInput = await prompts.text('Enter file paths to track (space-separated):', {
    placeholder: '~/.zshrc ~/.gitconfig',
    validate: (value) => {
      if (!value.trim()) return 'At least one path is required';
      return undefined;
    },
  });

  const paths = pathsInput.split(/\s+/).filter(Boolean);

  // Validate and prepare
  let filesToAdd: FileToAdd[];
  try {
    filesToAdd = await validateAndPrepareFiles(paths, tuckDir, {});
  } catch (error) {
    if (error instanceof Error) {
      prompts.log.error(error.message);
    }
    prompts.cancel();
    return;
  }

  // Show what will be added and ask for category confirmation
  for (const file of filesToAdd) {
    prompts.log.step(`${file.source}`);

    const categoryOptions = Object.entries(CATEGORIES).map(([name, config]) => ({
      value: name,
      label: `${config.icon} ${name}`,
      hint: file.category === name ? '(auto-detected)' : undefined,
    }));

    // Move detected category to top
    categoryOptions.sort((a, b) => {
      if (a.value === file.category) return -1;
      if (b.value === file.category) return 1;
      return 0;
    });

    const selectedCategory = await prompts.select('Category:', categoryOptions);
    file.category = selectedCategory as string;

    // Update destination with new category
    file.destination = getDestinationPath(tuckDir, file.category, file.filename);
  }

  // Confirm
  const confirm = await prompts.confirm(
    `Add ${filesToAdd.length} ${filesToAdd.length === 1 ? 'file' : 'files'}?`,
    true
  );

  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Add files
  await addFiles(filesToAdd, tuckDir, {});

  prompts.outro(`Added ${filesToAdd.length} ${filesToAdd.length === 1 ? 'file' : 'files'}`);
  logger.info("Run 'tuck sync' to commit changes");
};

/**
 * Add files programmatically (used by scan command)
 * Note: Secret scanning is skipped for programmatic use - callers should handle this separately
 */
export const addFilesFromPaths = async (paths: string[], options: AddOptions = {}): Promise<number> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Validate and prepare files
  const filesToAdd = await validateAndPrepareFiles(paths, tuckDir, options);

  if (filesToAdd.length === 0) {
    return 0;
  }

  // Scan for secrets (unless --force is used)
  // For programmatic use, we throw an error if secrets are detected
  if (!options.force) {
    const config = await loadConfig(tuckDir);
    const security = config.security || {};

    if (security.scanSecrets !== false) {
      const filePaths = filesToAdd.map((f) => expandPath(f.source));
      const summary = await scanForSecrets(filePaths, tuckDir);

      if (summary.filesWithSecrets > 0) {
        // For programmatic use, we just log a warning since this is typically
        // called from scan command which has its own flow
        logger.warning(`Found ${summary.totalSecrets} potential secret(s) in ${summary.filesWithSecrets} file(s)`);
        logger.dim('Use --force to skip secret scanning, or handle secrets interactively with `tuck add`');
      }
    }
  }

  // Add files
  await addFiles(filesToAdd, tuckDir, options);

  return filesToAdd.length;
};

const runAdd = async (paths: string[], options: AddOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  if (paths.length === 0) {
    await runInteractiveAdd(tuckDir);
    return;
  }

  // Validate and prepare files
  let filesToAdd = await validateAndPrepareFiles(paths, tuckDir, options);

  if (filesToAdd.length === 0) {
    logger.info('No files to add');
    return;
  }

  // Scan for secrets (unless --force is used)
  const secretScanResult = await scanAndHandleSecrets(filesToAdd, tuckDir, options);
  if (!secretScanResult.continue) {
    return;
  }
  filesToAdd = secretScanResult.filesToAdd;

  if (filesToAdd.length === 0) {
    return;
  }

  // Add files
  await addFiles(filesToAdd, tuckDir, options);

  // Ask if user wants to sync now
  console.log();
  const shouldSync = await prompts.confirm('Would you like to sync these changes now?', true);

  if (shouldSync) {
    console.log();
    // Dynamically import sync to avoid circular dependencies
    const { runSync } = await import('./sync.js');
    await runSync({});
  } else {
    console.log();
    logger.info("Run 'tuck sync' when you're ready to commit changes");
  }
};

export const addCommand = new Command('add')
  .description('Track new dotfiles')
  .argument('[paths...]', 'Paths to dotfiles to track')
  .option('-c, --category <name>', 'Category to organize under')
  .option('-n, --name <name>', 'Custom name for the file in manifest')
  .option('--symlink', 'Create symlink instead of copy')
  .option('-f, --force', 'Skip secret scanning (not recommended)')
  // TODO: Encryption and templating are planned for a future version
  // .option('--encrypt', 'Encrypt this file (requires GPG setup)')
  // .option('--template', 'Treat as template with variable substitution')
  .action(async (paths: string[], options: AddOptions) => {
    await runAdd(paths, options);
  });
