import { Command } from 'commander';
import chalk from 'chalk';
import { prompts, logger, banner } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest, getTrackedFileBySource } from '../lib/manifest.js';
import {
  detectDotfiles,
  DETECTION_CATEGORIES,
  DetectedFile,
} from '../lib/detect.js';
import { NotInitializedError } from '../errors.js';

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
const groupSelectableByCategory = (
  files: SelectableFile[]
): Record<string, SelectableFile[]> => {
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
const displayGroupedFiles = (
  files: SelectableFile[],
  showAll: boolean
): void => {
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
      chalk.bold(`${config.icon} ${config.name}`) +
        chalk.dim(` (${newFiles.length} new, ${trackedFiles.length} tracked)`)
    );
    console.log(chalk.dim('─'.repeat(50)));

    for (const file of categoryFiles) {
      if (!showAll && file.alreadyTracked) continue;

      const status = file.selected ? chalk.green('[x]') : chalk.dim('[ ]');
      const name = file.path;
      const tracked = file.alreadyTracked ? chalk.dim(' (tracked)') : '';
      const sensitive = file.sensitive ? chalk.yellow(' [!]') : '';
      const dir = file.isDirectory ? chalk.cyan(' [dir]') : '';

      console.log(`  ${status} ${name}${dir}${sensitive}${tracked}`);
      console.log(chalk.dim(`      ${file.description}`));
    }
  }
};

/**
 * Interactive file selection
 */
const runInteractiveSelection = async (
  files: SelectableFile[]
): Promise<SelectableFile[]> => {
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
    console.log(chalk.bold(`${config.icon} ${config.name}`));
    console.log(chalk.dim(config.description || ''));
    console.log();

    // Create options for multiselect
    const options = categoryFiles.map((file: SelectableFile) => {
      let label = file.path;
      if (file.sensitive) {
        label += chalk.yellow(' [!]');
      }
      if (file.isDirectory) {
        label += chalk.cyan(' [dir]');
      }

      return {
        value: file.path,
        label,
        hint: file.description,
      };
    });

    // All selected by default
    const selected = await prompts.multiselect(
      `Select files to track from ${config.name}:`,
      options.map((opt: { value: string; label: string; hint: string }) => ({ ...opt, selected: true }))
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
    chalk.bold.cyan('Detected Dotfiles: ') +
      chalk.white(`${newFiles.length} new, ${trackedFiles.length} already tracked`)
  );

  displayGroupedFiles(files, false);

  console.log();
  console.log(chalk.dim('─'.repeat(60)));
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
  console.log(chalk.bold.green(`Selected ${selected.length} files to track:`));
  console.log();

  const grouped = groupSelectableByCategory(selected);

  for (const [category, files] of Object.entries(grouped)) {
    const config = DETECTION_CATEGORIES[category] || { icon: '-', name: category };
    console.log(chalk.bold(`${config.icon} ${config.name}`));

    for (const file of files) {
      const sensitive = file.sensitive ? chalk.yellow(' [!]') : '';
      console.log(chalk.dim(`  • ${file.path}${sensitive}`));
    }
  }

  console.log();

  // Show warnings for sensitive files
  const sensitiveFiles = selected.filter((f) => f.sensitive);
  if (sensitiveFiles.length > 0) {
    console.log(chalk.yellow('Warning: Some selected files may contain sensitive data:'));
    for (const file of sensitiveFiles) {
      console.log(chalk.yellow(`  • ${file.path}`));
    }
    console.log(chalk.dim('  Make sure your repository is private!'));
    console.log();
  }

  // Show command to add files
  const paths = selected.map((f) => f.path).join(' ');
  console.log(chalk.bold('Run this command to add the selected files:'));
  console.log();
  console.log(chalk.cyan(`  tuck add ${paths}`));
  console.log();
};

/**
 * Main scan function
 */
const runScan = async (options: ScanOptions): Promise<void> => {
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
        console.log(chalk.dim(`  ${config.icon} ${key} - ${config.name}`));
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

  // Confirm selection
  showSummary(selected);

  const confirmed = await prompts.confirm(
    `Add ${selected.length} files to tuck?`,
    true
  );

  if (!confirmed) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Add the files
  const { addFilesFromPaths } = await import('./add.js');
  const paths = selected.map((f) => f.path);

  await addFilesFromPaths(paths, {});

  prompts.outro(`Added ${selected.length} files to tuck!`);
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
