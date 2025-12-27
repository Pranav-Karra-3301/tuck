import { Command } from 'commander';
import { prompts, logger, withSpinner } from '../ui/index.js';
import {
  getTuckDir,
  expandPath,
  collapsePath,
  pathExists,
  isDirectory,
  detectCategory,
  sanitizeFilename,
  getDestinationPath,
  getRelativeDestination,
  generateFileId,
} from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import {
  addFileToManifest,
  isFileTracked,
  loadManifest,
} from '../lib/manifest.js';
import { copyFileOrDir, getFileChecksum, getDirectoryFileCount, getFileInfo } from '../lib/files.js';
import { NotInitializedError, FileNotFoundError, FileAlreadyTrackedError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { AddOptions } from '../types.js';

interface FileToAdd {
  source: string;
  destination: string;
  category: string;
  filename: string;
  isDir: boolean;
  fileCount: number;
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

    filesToAdd.push({
      source: collapsedPath,
      destination,
      category,
      filename,
      isDir,
      fileCount,
    });
  }

  return filesToAdd;
};

const addFiles = async (
  filesToAdd: FileToAdd[],
  tuckDir: string,
  options: AddOptions
): Promise<void> => {
  const config = await loadConfig(tuckDir);
  const strategy = options.symlink ? 'symlink' : (config.files.strategy || 'copy');

  for (const file of filesToAdd) {
    const expandedSource = expandPath(file.source);

    // Copy file to repository
    await withSpinner(`Copying ${file.source}...`, async () => {
      await copyFileOrDir(expandedSource, file.destination, { overwrite: true });
    });

    // Get file info
    const checksum = await getFileChecksum(file.destination);
    const info = await getFileInfo(expandedSource);
    const now = new Date().toISOString();

    // Generate unique ID
    const id = generateFileId(file.source);

    // Add to manifest
    await addFileToManifest(tuckDir, id, {
      source: file.source,
      destination: getRelativeDestination(file.category, file.filename),
      category: file.category,
      strategy,
      encrypted: options.encrypt || false,
      template: options.template || false,
      permissions: info.permissions,
      added: now,
      modified: now,
      checksum,
    });

    // Log result
    const categoryInfo = CATEGORIES[file.category];
    const icon = categoryInfo?.icon || '📄';
    logger.success(`Added ${file.source}`);
    logger.dim(`  ${icon} Category: ${file.category}`);
    if (file.isDir) {
      logger.dim(`  📁 Directory with ${file.fileCount} files`);
    }
  }
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

  logger.blank();
  logger.success(`Added ${filesToAdd.length} ${filesToAdd.length === 1 ? 'item' : 'items'}`);
  logger.info("Run 'tuck sync' to commit changes");
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
