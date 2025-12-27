import chalk from 'chalk';
import ora, { Ora } from 'ora';

/**
 * A beautiful progress tracker for file operations
 * Shows one-by-one progress with "X of Y" indicators
 */

export interface ProgressItem {
  label: string;
  description?: string;
}

export interface ProgressTrackerOptions {
  title?: string;
  showIndex?: boolean;
  animationDelay?: number;
}

export interface ProgressTracker {
  start: () => void;
  update: (index: number, status: 'pending' | 'in_progress' | 'completed' | 'error', message?: string) => void;
  complete: (message?: string) => void;
  fail: (message?: string) => void;
}

const ICONS = {
  pending: chalk.dim('○'),
  in_progress: chalk.cyan('●'),
  completed: chalk.green('✓'),
  error: chalk.red('✗'),
};

/**
 * Create a progress tracker for multiple items
 */
export const createProgressTracker = (
  items: ProgressItem[],
  options: ProgressTrackerOptions = {}
): ProgressTracker => {
  const { title, showIndex = true } = options;
  const total = items.length;
  const statuses: ('pending' | 'in_progress' | 'completed' | 'error')[] = items.map(() => 'pending');
  let spinner: Ora | null = null;
  let currentIndex = -1;

  const renderLine = (index: number): string => {
    const item = items[index];
    const status = statuses[index];
    const icon = ICONS[status];
    const indexStr = showIndex ? chalk.dim(`[${index + 1}/${total}]`) + ' ' : '';

    let line = `  ${icon} ${indexStr}${item.label}`;

    if (item.description && status !== 'in_progress') {
      line += chalk.dim(` - ${item.description}`);
    }

    return line;
  };

  return {
    start: () => {
      if (title) {
        console.log();
        console.log(chalk.bold.cyan(title));
        console.log(chalk.dim('─'.repeat(50)));
      }
    },

    update: (index: number, status: 'pending' | 'in_progress' | 'completed' | 'error', message?: string) => {
      statuses[index] = status;

      if (status === 'in_progress') {
        // Stop any existing spinner
        if (spinner) {
          spinner.stop();
        }

        currentIndex = index;
        const item = items[index];
        const indexStr = showIndex ? chalk.dim(`[${index + 1}/${total}]`) + ' ' : '';

        spinner = ora({
          text: `${indexStr}${message || item.label}`,
          color: 'cyan',
          spinner: 'dots',
          indent: 2,
        }).start();
      } else if (status === 'completed' || status === 'error') {
        if (spinner && currentIndex === index) {
          spinner.stop();
          spinner = null;
        }
        console.log(renderLine(index));
      }
    },

    complete: (message?: string) => {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      console.log();
      console.log(chalk.green('✓'), message || 'Completed successfully');
    },

    fail: (message?: string) => {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      console.log();
      console.log(chalk.red('✗'), message || 'Operation failed');
    },
  };
};

/**
 * Animated file tracking display
 * Shows files being tracked one by one with nice animations
 */
export interface FileTrackingOptions {
  delayBetween?: number;
  showCategory?: boolean;
  onProgress?: (current: number, total: number) => void;
}

export interface FileTrackingItem {
  path: string;
  category?: string;
  action: 'tracking' | 'copying' | 'syncing' | 'restoring';
  icon?: string;
}

/**
 * Display an animated file tracking progress
 */
export const trackFilesWithProgress = async <T>(
  items: FileTrackingItem[],
  processor: (item: FileTrackingItem, index: number) => Promise<T>,
  options: FileTrackingOptions = {}
): Promise<T[]> => {
  const { delayBetween = 50, showCategory = true, onProgress } = options;
  const results: T[] = [];
  const total = items.length;

  console.log();
  console.log(chalk.bold.cyan(`Tracking ${total} ${total === 1 ? 'file' : 'files'}...`));
  console.log(chalk.dim('─'.repeat(50)));
  console.log();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const indexStr = chalk.dim(`[${i + 1}/${total}]`);

    // Get action text
    const actionText = {
      tracking: 'Tracking',
      copying: 'Copying',
      syncing: 'Syncing',
      restoring: 'Restoring',
    }[item.action];

    // Show spinner while processing
    const spinner = ora({
      text: `${indexStr} ${actionText} ${chalk.cyan(item.path)}`,
      color: 'cyan',
      spinner: 'dots',
      indent: 2,
    }).start();

    try {
      const result = await processor(item, i);
      results.push(result);

      // Show completion
      spinner.stop();
      const categoryStr = showCategory && item.category
        ? chalk.dim(` [${item.icon || ''}${item.category}]`)
        : '';
      console.log(`  ${chalk.green('✓')} ${indexStr} ${item.path}${categoryStr}`);

      // Call progress callback
      if (onProgress) {
        onProgress(i + 1, total);
      }

      // Small delay for visual effect (unless it's the last item)
      if (i < items.length - 1 && delayBetween > 0) {
        await new Promise(resolve => setTimeout(resolve, delayBetween));
      }
    } catch (error) {
      spinner.stop();
      console.log(`  ${chalk.red('✗')} ${indexStr} ${item.path} ${chalk.red('- failed')}`);
      throw error;
    }
  }

  console.log();
  console.log(chalk.green('✓'), chalk.bold(`Tracked ${total} ${total === 1 ? 'file' : 'files'} successfully`));

  return results;
};

/**
 * Simple step-by-step progress display for multi-step operations
 */
export interface StepProgress {
  start: (text: string) => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  skip: (text?: string) => void;
}

export const createStepProgress = (totalSteps: number): StepProgress => {
  let currentStep = 0;
  let spinner: Ora | null = null;
  let currentText = '';

  return {
    start: (text: string) => {
      currentStep++;
      currentText = text;
      const stepStr = chalk.dim(`[${currentStep}/${totalSteps}]`);
      spinner = ora({
        text: `${stepStr} ${text}`,
        color: 'cyan',
        spinner: 'dots',
      }).start();
    },

    succeed: (text?: string) => {
      if (spinner) {
        const stepStr = chalk.dim(`[${currentStep}/${totalSteps}]`);
        spinner.succeed(`${stepStr} ${text || currentText}`);
        spinner = null;
      }
    },

    fail: (text?: string) => {
      if (spinner) {
        const stepStr = chalk.dim(`[${currentStep}/${totalSteps}]`);
        spinner.fail(`${stepStr} ${text || currentText}`);
        spinner = null;
      }
    },

    skip: (text?: string) => {
      if (spinner) {
        const stepStr = chalk.dim(`[${currentStep}/${totalSteps}]`);
        spinner.info(`${stepStr} ${text || currentText} ${chalk.dim('(skipped)')}`);
        spinner = null;
      }
    },
  };
};

/**
 * Progress bar display for file operations
 */
export const createProgressBar = (
  total: number,
  options: { width?: number; label?: string } = {}
): { update: (current: number, label?: string) => void; complete: () => void } => {
  const { width = 30, label = 'Progress' } = options;
  let lastOutput = '';

  const render = (current: number, currentLabel?: string) => {
    const percentage = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * width);
    const empty = width - filled;

    const bar = chalk.cyan('█').repeat(filled) + chalk.dim('░').repeat(empty);
    const countStr = chalk.dim(`${current}/${total}`);
    const labelStr = currentLabel || label;

    const output = `  ${bar} ${percentage}% ${countStr} ${labelStr}`;

    // Clear previous line and write new one
    if (lastOutput) {
      process.stdout.write('\r' + ' '.repeat(lastOutput.length) + '\r');
    }
    process.stdout.write(output);
    lastOutput = output;
  };

  return {
    update: (current: number, currentLabel?: string) => {
      render(current, currentLabel);
    },
    complete: () => {
      if (lastOutput) {
        process.stdout.write('\r' + ' '.repeat(lastOutput.length) + '\r');
      }
      console.log(`  ${chalk.green('✓')} ${label} complete`);
    },
  };
};

/**
 * Display a summary box after file operations
 */
export const showOperationSummary = (stats: {
  tracked?: number;
  copied?: number;
  synced?: number;
  failed?: number;
  skipped?: number;
}, title = 'Summary'): void => {
  console.log();
  console.log(chalk.bold.cyan(`${title}:`));

  if (stats.tracked !== undefined && stats.tracked > 0) {
    console.log(`  ${chalk.green('✓')} Tracked: ${stats.tracked} ${stats.tracked === 1 ? 'file' : 'files'}`);
  }
  if (stats.copied !== undefined && stats.copied > 0) {
    console.log(`  ${chalk.green('✓')} Copied: ${stats.copied} ${stats.copied === 1 ? 'file' : 'files'}`);
  }
  if (stats.synced !== undefined && stats.synced > 0) {
    console.log(`  ${chalk.green('✓')} Synced: ${stats.synced} ${stats.synced === 1 ? 'file' : 'files'}`);
  }
  if (stats.skipped !== undefined && stats.skipped > 0) {
    console.log(`  ${chalk.yellow('○')} Skipped: ${stats.skipped} ${stats.skipped === 1 ? 'file' : 'files'}`);
  }
  if (stats.failed !== undefined && stats.failed > 0) {
    console.log(`  ${chalk.red('✗')} Failed: ${stats.failed} ${stats.failed === 1 ? 'file' : 'files'}`);
  }
};
