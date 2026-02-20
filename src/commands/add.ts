import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir, getDestinationPathFromSource } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { NotInitializedError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { AddOptions } from '../types.js';
import {
  preparePathsForTracking,
  type PreparedTrackFile,
  type TrackPathCandidate,
} from '../lib/trackPipeline.js';

type FileToAdd = PreparedTrackFile;

const addFiles = async (
  filesToAdd: FileToAdd[],
  tuckDir: string,
  options: AddOptions
): Promise<void> => {
  const filesToTrack: FileToTrack[] = filesToAdd.map((f) => ({
    path: f.source,
    category: f.category,
  }));

  await trackFilesWithProgress(filesToTrack, tuckDir, {
    showCategory: true,
    strategy: options.symlink ? 'symlink' : undefined,
    actionVerb: 'Tracking',
  });
};

const runInteractiveAdd = async (tuckDir: string): Promise<void> => {
  prompts.intro('tuck add');

  const pathsInput = await prompts.text('Enter file paths to track (space-separated):', {
    placeholder: '~/.zshrc ~/.gitconfig',
    validate: (value) => {
      if (!value.trim()) return 'At least one path is required';
      return undefined;
    },
  });

  const paths = pathsInput.split(/\s+/).filter(Boolean);
  const candidates: TrackPathCandidate[] = paths.map((path) => ({ path }));

  let filesToAdd: FileToAdd[];
  try {
    filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
      secretHandling: 'interactive',
      forceBypassCommand: 'tuck add --force',
    });
  } catch (error) {
    if (error instanceof Error) {
      prompts.log.error(error.message);
    }
    prompts.cancel();
    return;
  }

  if (filesToAdd.length === 0) {
    logger.info('No files to add');
    return;
  }

  for (const file of filesToAdd) {
    prompts.log.step(`${file.source}`);

    const categoryOptions = Object.entries(CATEGORIES).map(([name, config]) => ({
      value: name,
      label: `${config.icon} ${name}`,
      hint: file.category === name ? '(auto-detected)' : undefined,
    }));

    categoryOptions.sort((a, b) => {
      if (a.value === file.category) return -1;
      if (b.value === file.category) return 1;
      return 0;
    });

    const selectedCategory = await prompts.select('Category:', categoryOptions);
    file.category = selectedCategory as string;
    file.destination = getDestinationPathFromSource(tuckDir, file.category, file.source);
  }

  const confirm = await prompts.confirm(
    `Add ${filesToAdd.length} ${filesToAdd.length === 1 ? 'file' : 'files'}?`,
    true
  );

  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  await addFiles(filesToAdd, tuckDir, {});

  prompts.outro(`Added ${filesToAdd.length} ${filesToAdd.length === 1 ? 'file' : 'files'}`);
  logger.info("Run 'tuck sync' to commit changes");
};

/**
 * Add files programmatically (used by scan/sync flows)
 * Note: Throws SecretsDetectedError when configured to block.
 */
export const addFilesFromPaths = async (
  paths: string[],
  options: AddOptions = {}
): Promise<number> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const candidates: TrackPathCandidate[] = paths.map((path) => ({
    path,
    category: options.category,
    name: options.name,
  }));

  const filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
    category: options.category,
    name: options.name,
    force: options.force,
    secretHandling: 'strict',
    forceBypassCommand: 'tuck add --force',
  });

  if (filesToAdd.length === 0) {
    return 0;
  }

  await addFiles(filesToAdd, tuckDir, options);
  return filesToAdd.length;
};

const runAdd = async (paths: string[], options: AddOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  if (paths.length === 0) {
    await runInteractiveAdd(tuckDir);
    return;
  }

  const candidates: TrackPathCandidate[] = paths.map((path) => ({
    path,
    category: options.category,
    name: options.name,
  }));

  const filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
    category: options.category,
    name: options.name,
    force: options.force,
    secretHandling: 'interactive',
    forceBypassCommand: 'tuck add --force',
  });

  if (filesToAdd.length === 0) {
    logger.info('No files to add');
    return;
  }

  await addFiles(filesToAdd, tuckDir, options);

  console.log();
  const shouldSync = await prompts.confirm('Would you like to sync these changes now?', true);

  if (shouldSync) {
    console.log();
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
  .option('--symlink', 'Copy into tuck repo, then replace source path with a symlink')
  .option('-f, --force', 'Skip secret scanning (not recommended)')
  .action(async (paths: string[], options: AddOptions) => {
    await runAdd(paths, options);
  });
