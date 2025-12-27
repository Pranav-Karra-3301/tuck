import { Command } from 'commander';
import { basename } from 'path';
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
import { getDirectoryFileCount } from '../lib/files.js';

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
    encrypt: options.encrypt,
    template: options.template,
    actionVerb: 'Tracking',
  });
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
  const filesToAdd = await validateAndPrepareFiles(paths, tuckDir, options);

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
  .option('--encrypt', 'Encrypt this file (requires GPG setup)')
  .option('--template', 'Treat as template with variable substitution')
  .action(async (paths: string[], options: AddOptions) => {
    await runAdd(paths, options);
  });
