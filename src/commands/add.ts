import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest, ensureBundle } from '../lib/manifest.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { NotInitializedError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { AddOptions } from '../types.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
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
  if (options.bundle) {
    await ensureBundle(tuckDir, options.bundle);
  }

  const filesToTrack: FileToTrack[] = filesToAdd.map((f) => {
    const trackedFile: FileToTrack = {
      path: f.source,
      category: f.category,
    };

    if (f.nameOverride) {
      trackedFile.name = f.nameOverride;
    }

    if (options.bundle) {
      trackedFile.bundle = options.bundle;
    }

    return trackedFile;
  });

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
  if (options.json) setJsonMode(true, 'tuck add');
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  if (paths.length === 0) {
    if (isJsonMode() || options.yes) {
      // In agent mode an empty add is a no-op rather than an interactive prompt.
      if (isJsonMode()) emitJsonOk({ added: 0, files: [] });
      else logger.info('No paths provided.');
      return;
    }
    await runInteractiveAdd(tuckDir);
    return;
  }

  // --plan / --dry-run: print what would be added without mutating.
  if (options.plan || options.dryRun) {
    const planned = paths.map((p) => ({
      path: p,
      category: options.category,
      bundle: options.bundle ?? 'default',
    }));
    if (isJsonMode()) {
      emitJsonOk({ plan: planned });
    } else {
      logger.heading('Plan — would track:');
      for (const p of planned) logger.file('add', `${p.path} [${p.category ?? 'auto'}]`);
    }
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
    secretHandling: isJsonMode() || options.yes ? 'strict' : 'interactive',
    forceBypassCommand: 'tuck add --force',
  });

  if (filesToAdd.length === 0) {
    if (isJsonMode()) emitJsonOk({ added: 0, files: [] });
    else logger.info('No files to add');
    return;
  }

  await addFiles(filesToAdd, tuckDir, options);

  if (isJsonMode()) {
    emitJsonOk({
      added: filesToAdd.length,
      files: filesToAdd.map((f) => ({ source: f.source, category: f.category })),
      bundle: options.bundle ?? 'default',
    });
    return;
  }

  if (options.yes) {
    logger.success(`Added ${filesToAdd.length} file${filesToAdd.length > 1 ? 's' : ''}`);
    return;
  }

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
  .option('-b, --bundle <name>', 'Bundle to assign the file to (defaults to "default")')
  .option('--json', 'Emit JSON envelope to stdout (non-interactive)')
  .option('-y, --yes', 'Auto-confirm prompts (use with --json for full automation)')
  .option('--plan', 'Print the planned tracking operation as JSON and exit')
  .option('--dry-run', 'Print the planned tracking operation as text and exit')
  .action(async (paths: string[], options: AddOptions) => {
    await runAdd(paths, options);
  });
