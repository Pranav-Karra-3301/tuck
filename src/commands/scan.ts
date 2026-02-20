import { Command } from 'commander';
import { prompts, logger, banner, colors as c } from '../ui/index.js';
import { getTuckDir, collapsePath, expandPath } from '../lib/paths.js';
import { loadManifest, getTrackedFileBySource } from '../lib/manifest.js';
import { detectDotfiles, DETECTION_CATEGORIES, DetectedFile } from '../lib/detect.js';
import { NotInitializedError } from '../errors.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { preparePathsForTracking } from '../lib/trackPipeline.js';
import { shouldExcludeFromBin } from '../lib/binary.js';
import { isIgnored } from '../lib/tuckignore.js';

export interface ScanOptions {
  all?: boolean;
  category?: string;
  json?: boolean;
  quick?: boolean;
}

interface SelectableFile extends DetectedFile {
  selected: boolean;
  alreadyTracked: boolean;
}

/**
 * Group selectable files by category
 */
const groupSelectableByCategory = (files: SelectableFile[]): Record<string, SelectableFile[]> => {
  const grouped: Record<string, SelectableFile[]> = {};

  for (const file of files) {
    if (!grouped[file.category]) {
      grouped[file.category] = [];
    }
    grouped[file.category].push(file);
  }

  return grouped;
};

/**
 * Display detected files grouped by category
 */
const displayGroupedFiles = (files: SelectableFile[], showAll: boolean): void => {
  const grouped = groupSelectableByCategory(files);
  const categories = Object.keys(grouped).sort((a, b) => {
    // Sort by category order in DETECTION_CATEGORIES
    const order = Object.keys(DETECTION_CATEGORIES);
    return order.indexOf(a) - order.indexOf(b);
  });

  for (const category of categories) {
    const categoryFiles = grouped[category];
    const config = DETECTION_CATEGORIES[category] || { icon: '-', name: category };
    const newFiles = categoryFiles.filter((f) => !f.alreadyTracked);
    const trackedFiles = categoryFiles.filter((f) => f.alreadyTracked);

    console.log();
    console.log(
      c.bold(`${config.icon} ${config.name}`) +
        c.dim(` (${newFiles.length} new, ${trackedFiles.length} tracked)`)
    );
    console.log(c.dim('─'.repeat(50)));

    for (const file of categoryFiles) {
      if (!showAll && file.alreadyTracked) continue;

      const status = file.selected ? c.green('[x]') : c.dim('[ ]');
      const name = file.path;
      const tracked = file.alreadyTracked ? c.dim(' (tracked)') : '';
      const sensitive = file.sensitive ? c.yellow(' [!]') : '';
      const dir = file.isDirectory ? c.cyan(' [dir]') : '';

      console.log(`  ${status} ${name}${dir}${sensitive}${tracked}`);
      console.log(c.dim(`      ${file.description}`));
    }
  }
};

/**
 * Interactive file selection
 */
const runInteractiveSelection = async (files: SelectableFile[]): Promise<SelectableFile[]> => {
  const newFiles = files.filter((f) => !f.alreadyTracked);

  if (newFiles.length === 0) {
    prompts.log.success('All detected dotfiles are already being tracked!');
    return [];
  }

  // Group files for selection
  const grouped = groupSelectableByCategory(newFiles);
  const selectedFiles: SelectableFile[] = [];

  // Ask for each category
  for (const [category, categoryFiles] of Object.entries(grouped)) {
    const config = DETECTION_CATEGORIES[category] || { icon: '-', name: category };

    console.log();
    console.log(c.bold(`${config.icon} ${config.name}`));
    console.log(c.dim(config.description || ''));
    console.log();

    // Create options for multiselect
    const options = categoryFiles.map((file: SelectableFile) => {
      let label = file.path;
      if (file.sensitive) {
        label += c.yellow(' [!]');
      }
      if (file.isDirectory) {
        label += c.cyan(' [dir]');
      }

      return {
        value: file.path,
        label,
        hint: file.description,
      };
    });

    // Pre-select all non-sensitive files by default
    const nonSensitiveFiles = categoryFiles.filter((f) => !f.sensitive);
    const initialValues = nonSensitiveFiles.map((f) => f.path);

    const selected = await prompts.multiselect(
      `Select files to track from ${config.name}:`,
      options,
      { initialValues }
    );

    // Mark selected files
    for (const file of categoryFiles) {
      if (selected.includes(file.path)) {
        file.selected = true;
        selectedFiles.push(file);
      }
    }
  }

  return selectedFiles;
};

/**
 * Quick display mode - just show what's detected
 */
const runQuickScan = async (files: SelectableFile[]): Promise<void> => {
  const newFiles = files.filter((f) => !f.alreadyTracked);
  const trackedFiles = files.filter((f) => f.alreadyTracked);

  console.log();
  console.log(
    c.bold.cyan('Detected Dotfiles: ') +
      c.white(`${newFiles.length} new, ${trackedFiles.length} already tracked`)
  );

  displayGroupedFiles(files, false);

  console.log();
  console.log(c.dim('─'.repeat(60)));
  console.log();

  if (newFiles.length > 0) {
    logger.info(`Found ${newFiles.length} new dotfiles to track`);
    logger.dim('Run `tuck scan` (without --quick) to interactively select files');
    logger.dim('Or run `tuck add <path>` to add specific files');
  } else {
    logger.success('All detected dotfiles are already being tracked!');
  }
};

/**
 * Summary display after selection
 */
const showSummary = (selected: SelectableFile[]): void => {
  if (selected.length === 0) {
    logger.info('No files selected');
    return;
  }

  console.log();
  console.log(c.bold.cyan(`Selected ${selected.length} files to track:`));
  console.log(c.dim('─'.repeat(50)));
  console.log();

  const grouped = groupSelectableByCategory(selected);

  for (const [category, files] of Object.entries(grouped)) {
    const config = DETECTION_CATEGORIES[category] || { icon: '-', name: category };
    console.log(c.bold(`${config.icon} ${config.name}`));

    for (const file of files) {
      const sensitive = file.sensitive ? c.yellow(' ⚠') : '';
      console.log(c.dim(`  • ${collapsePath(file.path)}${sensitive}`));
    }
    console.log();
  }

  // Show warnings for sensitive files
  const sensitiveFiles = selected.filter((f) => f.sensitive);
  if (sensitiveFiles.length > 0) {
    console.log(c.yellow('⚠ Warning: Some files may contain sensitive data'));
    console.log(c.dim('  Make sure your repository is private!'));
    console.log();
  }
};

/**
 * Add selected files with beautiful progress display
 */
const addFilesWithProgress = async (
  selected: SelectableFile[],
  tuckDir: string
): Promise<number> => {
  const prepared = await preparePathsForTracking(
    selected.map((file) => ({
      path: file.path,
      category: file.category,
    })),
    tuckDir,
    {
      secretHandling: 'interactive',
    }
  );

  if (prepared.length === 0) {
    return 0;
  }

  const filesToTrack: FileToTrack[] = prepared.map((file) => ({
    path: file.source,
    category: file.category,
  }));

  // Use the shared tracking utility
  const result = await trackFilesWithProgress(filesToTrack, tuckDir, {
    showCategory: true,
    actionVerb: 'Tracking',
  });

  return result.succeeded;
};

/**
 * Main scan function
 */
export const runScan = async (options: ScanOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Check if tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Detect dotfiles
  const spinner = prompts.spinner();
  spinner.start('Scanning for dotfiles...');

  const detected = await detectDotfiles();

  spinner.stop(`Found ${detected.length} dotfiles on this system`);

  if (detected.length === 0) {
    logger.warning('No common dotfiles detected on this system');
    return;
  }

  // Check which files are already tracked
  const selectableFiles: SelectableFile[] = [];

  for (const file of detected) {
    const tracked = await getTrackedFileBySource(tuckDir, file.path);

    // Skip if in .tuckignore
    if (await isIgnored(tuckDir, file.path)) {
      continue;
    }

    // Skip if binary executable in bin directory
    if (await shouldExcludeFromBin(expandPath(file.path))) {
      continue;
    }

    selectableFiles.push({
      ...file,
      selected: true, // All selected by default
      alreadyTracked: tracked !== null,
    });
  }

  // Filter by category if specified
  let filesToShow = selectableFiles;
  if (options.category) {
    filesToShow = selectableFiles.filter((f) => f.category === options.category);
    if (filesToShow.length === 0) {
      logger.warning(`No dotfiles found in category: ${options.category}`);
      logger.info('Available categories:');
      for (const [key, config] of Object.entries(DETECTION_CATEGORIES)) {
        console.log(c.dim(`  ${config.icon} ${key} - ${config.name}`));
      }
      return;
    }
  }

  // JSON output
  if (options.json) {
    console.log(JSON.stringify(filesToShow, null, 2));
    return;
  }

  // Quick mode - just display
  if (options.quick) {
    await runQuickScan(filesToShow);
    return;
  }

  // Interactive mode
  banner();
  prompts.intro('tuck scan');

  const newFiles = filesToShow.filter((f) => !f.alreadyTracked);
  const trackedCount = filesToShow.filter((f) => f.alreadyTracked).length;

  prompts.log.info(
    `Found ${filesToShow.length} dotfiles (${newFiles.length} new, ${trackedCount} tracked)`
  );

  if (newFiles.length === 0) {
    prompts.log.success('All detected dotfiles are already being tracked!');
    prompts.outro('Nothing to do');
    return;
  }

  // Ask how to proceed
  const action = await prompts.select('How would you like to proceed?', [
    {
      value: 'all',
      label: 'Track all new files',
      hint: `Add all ${newFiles.length} files`,
    },
    {
      value: 'select',
      label: 'Select files to track',
      hint: 'Choose which files to add',
    },
    {
      value: 'preview',
      label: 'Just show me what was found',
      hint: 'Display files without tracking',
    },
  ]);

  if (action === 'preview') {
    displayGroupedFiles(filesToShow, options.all || false);
    prompts.outro('Run `tuck scan` again to select files');
    return;
  }

  let selected: SelectableFile[];

  if (action === 'all') {
    selected = newFiles.map((f) => ({ ...f, selected: true }));
  } else {
    selected = await runInteractiveSelection(filesToShow);
  }

  if (selected.length === 0) {
    prompts.cancel('No files selected');
    return;
  }

  // Show summary of what will be tracked
  showSummary(selected);

  const confirmed = await prompts.confirm(`Track these ${selected.length} files?`, true);

  if (!confirmed) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Add the files with beautiful progress display
  const addedCount = await addFilesWithProgress(selected, tuckDir);

  if (addedCount > 0) {
    // Ask if user wants to sync now
    console.log();
    const shouldSync = await prompts.confirm('Would you like to sync these changes now?', true);

    if (shouldSync) {
      console.log();
      const { runSync } = await import('./sync.js');
      await runSync({});
    } else {
      prompts.outro("Run 'tuck sync' when you're ready to commit changes");
    }
  } else {
    prompts.outro('No files were added');
  }
};

export const scanCommand = new Command('scan')
  .description('Scan system for dotfiles and select which to track')
  .option('-a, --all', 'Show all files including already tracked ones')
  .option('-c, --category <name>', 'Filter by category (shell, git, editors, etc.)')
  .option('-q, --quick', 'Quick scan - just show detected files without interactive selection')
  .option('--json', 'Output results as JSON')
  .action(async (options: ScanOptions) => {
    await runScan(options);
  });
