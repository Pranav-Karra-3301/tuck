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

/** Whether the caller asked for repo-scoped tracking (`--repo [dir]`). */
const isRepoScopeRequested = (options: AddOptions): boolean =>
  options.repo !== undefined && options.repo !== false;

/**
 * Repo-scoped tracking is COPY-ONLY: the live file stays inside its repo
 * checkout (it can't be symlinked into the tuck repo without breaking the
 * checkout). Reject `--symlink --repo` up front with a clear message.
 */
const assertRepoScopeCompatible = (options: AddOptions): void => {
  if (isRepoScopeRequested(options) && options.symlink) {
    throw new Error('--symlink cannot be combined with --repo: repo-scoped files are copy-only');
  }
};

const addFiles = async (
  filesToAdd: FileToAdd[],
  tuckDir: string,
  options: AddOptions
): Promise<void> => {
  if (options.bundle) {
    await ensureBundle(tuckDir, options.bundle);
  }

  const filesToTrack: FileToTrack[] = filesToAdd.map((f) => {
    const isRepo = f.scope === 'repo';
    const trackedFile: FileToTrack = {
      // For repo files the live absolute path is what we copy FROM; for home
      // files the (home-relative) source doubles as the path.
      path: isRepo ? (f.liveSource ?? f.source) : f.source,
      category: f.category,
    };

    if (f.nameOverride) {
      trackedFile.name = f.nameOverride;
    }

    if (options.bundle) {
      trackedFile.bundle = options.bundle;
    }

    if (isRepo) {
      trackedFile.scope = 'repo';
      trackedFile.repoKey = f.repoKey;
      trackedFile.repoRelative = f.repoRelative;
      trackedFile.repoRoot = f.repoRoot;
      trackedFile.remoteUrl = f.remoteUrl;
      trackedFile.source = f.source;
      trackedFile.destination = f.destination;
    }

    return trackedFile;
  });

  await trackFilesWithProgress(filesToTrack, tuckDir, {
    showCategory: true,
    // Repo scope is always copy; --symlink is rejected upstream for repo adds.
    strategy: options.symlink ? 'symlink' : undefined,
    encrypt: options.encrypt,
    template: options.template,
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

  assertRepoScopeCompatible(options);

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
    repo: options.repo,
    repoKey: options.repoKey,
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

  assertRepoScopeCompatible(options);

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

  const candidates: TrackPathCandidate[] = paths.map((path) => ({
    path,
    category: options.category,
    name: options.name,
  }));

  // --plan / --dry-run: run the FULL preparation pipeline (category detection,
  // secret scan, validation) so the plan output is what a real `tuck add` would
  // produce — not an echo of raw input. preparePathsForTracking performs no
  // manifest writes; addFiles (skipped below) is the only mutating step.
  if (options.plan || options.dryRun) {
    const plannedFiles = await preparePathsForTracking(candidates, tuckDir, {
      category: options.category,
      name: options.name,
      force: options.force,
      secretHandling: isJsonMode() || options.yes ? 'strict' : 'interactive',
      forceBypassCommand: 'tuck add --force',
      repo: options.repo,
      repoKey: options.repoKey,
    });

    const bundle = options.bundle ?? 'default';
    if (isJsonMode()) {
      emitJsonOk({
        plan: plannedFiles.map((f) => ({
          source: f.source,
          category: f.category,
          destination: f.destination,
          sensitive: f.sensitive,
          scope: f.scope ?? 'home',
          bundle,
        })),
      });
    } else {
      logger.heading('Plan — would track:');
      for (const f of plannedFiles) logger.file('add', `${f.source} [${f.category}]`);
    }
    return;
  }

  const filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
    category: options.category,
    name: options.name,
    force: options.force,
    secretHandling: isJsonMode() || options.yes ? 'strict' : 'interactive',
    forceBypassCommand: 'tuck add --force',
    repo: options.repo,
    repoKey: options.repoKey,
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
  .option('--template', 'Mark as a template: rendered on apply (sync will not capture live edits)')
  .option('--encrypt', 'Encrypt the file at rest in the repo (decrypted on apply; needs an encryption password)')
  .option(
    '--repo [dir]',
    'Track as repo-scoped (file lives in a git repo; auto-detects the root from the path when no dir is given)'
  )
  .option('--repo-key <key>', 'Explicit stable repo identity (advanced; default derives from the remote)')
  .option('-f, --force', 'Skip secret scanning (not recommended)')
  .option('-b, --bundle <name>', 'Bundle to assign the file to (defaults to "default")')
  .option('--json', 'Emit JSON envelope to stdout (non-interactive)')
  .option('-y, --yes', 'Auto-confirm prompts (use with --json for full automation)')
  .option('--plan', 'Print the planned tracking operation as JSON and exit')
  .option('--dry-run', 'Print the planned tracking operation as text and exit')
  .action(async (paths: string[], options: AddOptions) => {
    await runAdd(paths, options);
  });
