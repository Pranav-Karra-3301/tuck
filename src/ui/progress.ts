/**
 * Progress display utilities for tuck CLI
 * Provides beautiful, adaptive progress displays for file operations
 *
 * Display Modes:
 * - detailed (≤20 files): Show each file with spinner
 * - compact (21-100 files): Progress bar with current file
 * - minimal (>100 files): Spinner with count only
 */

import * as p from '@clack/prompts';
import logSymbols from 'log-symbols';
import figures from 'figures';
import { colors as c, divider, indent, DIVIDER_WIDTH, getProgressMode } from './theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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
  update: (
    index: number,
    status: 'pending' | 'in_progress' | 'completed' | 'error',
    message?: string
  ) => void;
  complete: (message?: string) => void;
  fail: (message?: string) => void;
}

export interface FileOperationItem {
  path: string;
  category?: string;
  action: 'tracking' | 'copying' | 'syncing' | 'restoring';
  icon?: string;
}

export interface FileOperationOptions {
  delayBetween?: number;
  showCategory?: boolean;
  onProgress?: (current: number, total: number) => void;
  actionVerb?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Bar Component
// ─────────────────────────────────────────────────────────────────────────────

const createProgressBarLine = (current: number, total: number, width = 30): string => {
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;

  const bar = c.brand('█').repeat(filled) + c.muted('░').repeat(empty);
  const stats = c.muted(`${current}/${total}`);
  const pct = c.bold(`${percentage}%`);

  return `${bar} ${pct} ${stats}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Detailed Mode: Show Each File
// ─────────────────────────────────────────────────────────────────────────────

const processDetailed = async <T>(
  items: FileOperationItem[],
  processor: (item: FileOperationItem, index: number) => Promise<T>,
  options: FileOperationOptions
): Promise<T[]> => {
  const { showCategory = true, onProgress, actionVerb, delayBetween = 50 } = options;
  const results: T[] = [];
  const total = items.length;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const indexStr = c.muted(`[${i + 1}/${total}]`);
    const actionText = actionVerb || getActionText(item.action);

    // Show spinner while processing
    const spinner = p.spinner();
    spinner.start(`${indexStr} ${actionText} ${c.brand(item.path)}`);

    try {
      const result = await processor(item, i);
      results.push(result);

      // Format completion line
      const categoryStr =
        showCategory && item.category ? c.muted(` [${item.icon || ''}${item.category}]`) : '';

      spinner.stop(`${logSymbols.success} ${indexStr} ${item.path}${categoryStr}`);

      if (onProgress) {
        onProgress(i + 1, total);
      }

      // Small delay for visual effect (except last item)
      if (i < items.length - 1 && delayBetween > 0) {
        await sleep(delayBetween);
      }
    } catch (error) {
      spinner.stop(`${logSymbols.error} ${indexStr} ${item.path} ${c.error('failed')}`);
      throw error;
    }
  }

  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// Compact Mode: Progress Bar + Current File
// ─────────────────────────────────────────────────────────────────────────────

const processCompact = async <T>(
  items: FileOperationItem[],
  processor: (item: FileOperationItem, index: number) => Promise<T>,
  options: FileOperationOptions
): Promise<T[]> => {
  const { onProgress, delayBetween = 10 } = options;
  const results: T[] = [];
  const total = items.length;

  // Track if we've written output that needs clearing
  let hasOutput = false;

  const clearLines = () => {
    if (hasOutput) {
      // Move cursor up one line, clear it, move up again, clear it
      process.stdout.write('\x1b[1A\x1b[2K\x1b[1A\x1b[2K');
    }
  };

  const writeProgress = (progressBar: string, currentFile: string) => {
    if (hasOutput) {
      clearLines();
    }
    console.log(`${indent()}${progressBar}`);
    console.log(`${indent()}${c.brand(figures.pointer)} ${currentFile}`);
    hasOutput = true;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Show progress bar + current file
    const progressBar = createProgressBarLine(i, total);
    const currentFile = c.muted(truncatePath(item.path, 40));
    writeProgress(progressBar, currentFile);

    try {
      const result = await processor(item, i);
      results.push(result);

      if (onProgress) {
        onProgress(i + 1, total);
      }

      if (delayBetween > 0) {
        await sleep(delayBetween);
      }
    } catch (error) {
      clearLines();
      console.log(`${indent()}${logSymbols.error} ${item.path} ${c.error('failed')}`);
      throw error;
    }
  }

  // Final state - clear and show completed progress bar
  clearLines();
  const finalBar = createProgressBarLine(total, total);
  console.log(`${indent()}${finalBar}`);

  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// Minimal Mode: Spinner with Count
// ─────────────────────────────────────────────────────────────────────────────

const processMinimal = async <T>(
  items: FileOperationItem[],
  processor: (item: FileOperationItem, index: number) => Promise<T>,
  options: FileOperationOptions
): Promise<T[]> => {
  const { actionVerb, onProgress, delayBetween = 5 } = options;
  const results: T[] = [];
  const total = items.length;
  const actionText = actionVerb || 'Processing';

  const spinner = p.spinner();
  spinner.start(`${actionText} ${total} files...`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const pct = Math.round(((i + 1) / total) * 100);

    spinner.message(`${actionText}... ${i + 1}/${total} (${pct}%)`);

    try {
      const result = await processor(item, i);
      results.push(result);

      if (onProgress) {
        onProgress(i + 1, total);
      }

      if (delayBetween > 0 && i < items.length - 1) {
        await sleep(delayBetween);
      }
    } catch (error) {
      spinner.stop(`${logSymbols.error} Failed at ${item.path}`);
      throw error;
    }
  }

  spinner.stop(`${logSymbols.success} ${actionText} complete`);
  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process files with adaptive progress display
 * Automatically selects the best display mode based on item count
 */
export const processFilesWithProgress = async <T>(
  items: FileOperationItem[],
  processor: (item: FileOperationItem, index: number) => Promise<T>,
  options: FileOperationOptions = {}
): Promise<T[]> => {
  const { actionVerb } = options;
  const total = items.length;
  const mode = getProgressMode(total);

  // Header
  const displayAction = actionVerb || getActionText(items[0]?.action || 'tracking');
  console.log();
  console.log(c.brandBold(`${displayAction} ${total} ${total === 1 ? 'file' : 'files'}...`));
  console.log(divider(DIVIDER_WIDTH));
  console.log();

  // Process based on mode
  let results: T[];

  switch (mode) {
    case 'detailed':
      results = await processDetailed(items, processor, options);
      break;
    case 'compact':
      results = await processCompact(items, processor, options);
      break;
    case 'minimal':
      results = await processMinimal(items, processor, options);
      break;
  }

  // Summary
  console.log();
  const pastTense = getPastTense(displayAction);
  console.log(
    logSymbols.success,
    c.bold(`${pastTense} ${total} ${total === 1 ? 'file' : 'files'}`)
  );

  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Exports (backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use processFilesWithProgress instead */
export const trackFilesWithProgress = processFilesWithProgress;

/** @deprecated Use FileOperationItem instead */
export type FileTrackingItem = FileOperationItem;

/** @deprecated Use FileOperationOptions instead */
export type FileTrackingOptions = FileOperationOptions;

// ─────────────────────────────────────────────────────────────────────────────
// Step Progress (for multi-step operations)
// ─────────────────────────────────────────────────────────────────────────────

export interface StepProgress {
  start: (text: string) => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  skip: (text?: string) => void;
}

export const createStepProgress = (totalSteps: number): StepProgress => {
  let currentStep = 0;
  let spinner: ReturnType<typeof p.spinner> | null = null;
  let currentText = '';

  return {
    start: (text: string) => {
      currentStep++;
      currentText = text;
      const stepStr = c.muted(`[${currentStep}/${totalSteps}]`);
      spinner = p.spinner();
      spinner.start(`${stepStr} ${text}`);
    },

    succeed: (text?: string) => {
      if (spinner) {
        const stepStr = c.muted(`[${currentStep}/${totalSteps}]`);
        spinner.stop(`${logSymbols.success} ${stepStr} ${text || currentText}`);
        spinner = null;
      }
    },

    fail: (text?: string) => {
      if (spinner) {
        const stepStr = c.muted(`[${currentStep}/${totalSteps}]`);
        spinner.stop(`${logSymbols.error} ${stepStr} ${text || currentText}`);
        spinner = null;
      }
    },

    skip: (text?: string) => {
      if (spinner) {
        const stepStr = c.muted(`[${currentStep}/${totalSteps}]`);
        spinner.stop(
          `${logSymbols.info} ${stepStr} ${text || currentText} ${c.muted('(skipped)')}`
        );
        spinner = null;
      }
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Simple Progress Bar
// ─────────────────────────────────────────────────────────────────────────────

export const createProgressBar = (
  total: number,
  options: { width?: number; label?: string } = {}
): { update: (current: number, label?: string) => void; complete: () => void } => {
  const { width = 30, label = 'Progress' } = options;
  let lastOutput = '';

  const render = (current: number, currentLabel?: string) => {
    const bar = createProgressBarLine(current, total, width);
    const labelStr = currentLabel || label;
    const output = `${indent()}${bar} ${labelStr}`;

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
      console.log(`${indent()}${logSymbols.success} ${label} complete`);
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Operation Summary
// ─────────────────────────────────────────────────────────────────────────────

export const showOperationSummary = (
  stats: {
    tracked?: number;
    copied?: number;
    synced?: number;
    failed?: number;
    skipped?: number;
  },
  title = 'Summary'
): void => {
  console.log();
  console.log(c.brandBold(`${title}:`));

  if (stats.tracked !== undefined && stats.tracked > 0) {
    console.log(
      `${indent()}${logSymbols.success} Tracked: ${stats.tracked} ${stats.tracked === 1 ? 'file' : 'files'}`
    );
  }
  if (stats.copied !== undefined && stats.copied > 0) {
    console.log(
      `${indent()}${logSymbols.success} Copied: ${stats.copied} ${stats.copied === 1 ? 'file' : 'files'}`
    );
  }
  if (stats.synced !== undefined && stats.synced > 0) {
    console.log(
      `${indent()}${logSymbols.success} Synced: ${stats.synced} ${stats.synced === 1 ? 'file' : 'files'}`
    );
  }
  if (stats.skipped !== undefined && stats.skipped > 0) {
    console.log(
      `${indent()}${c.muted(figures.circle)} Skipped: ${stats.skipped} ${stats.skipped === 1 ? 'file' : 'files'}`
    );
  }
  if (stats.failed !== undefined && stats.failed > 0) {
    console.log(
      `${indent()}${logSymbols.error} Failed: ${stats.failed} ${stats.failed === 1 ? 'file' : 'files'}`
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getActionText = (action: string): string => {
  const texts: Record<string, string> = {
    tracking: 'Tracking',
    copying: 'Copying',
    syncing: 'Syncing',
    restoring: 'Restoring',
  };
  return texts[action] || 'Processing';
};

const getPastTense = (verb: string): string => {
  if (verb.endsWith('ing')) {
    const base = verb.slice(0, -3);
    // Handle consonant + y -> ied (e.g., Copy -> Copied)
    if (base.endsWith('y') && base.length > 1) {
      const beforeY = base[base.length - 2];
      // Check if preceded by consonant (not a vowel)
      if (!'aeiouAEIOU'.includes(beforeY)) {
        return base.slice(0, -1) + 'ied';
      }
    }
    // Handle words ending in 'e' that was dropped (e.g., Sync -> Synced)
    // Most -ing words just need +ed on the base
    return base + 'ed';
  }
  return verb;
};

const truncatePath = (path: string, maxLength: number): string => {
  if (path.length <= maxLength) return path;
  return '...' + path.slice(-(maxLength - 3));
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Progress Tracker (for backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

export const createProgressTracker = (
  items: ProgressItem[],
  options: ProgressTrackerOptions = {}
): ProgressTracker => {
  const { title, showIndex = true } = options;
  const total = items.length;
  const statuses: ('pending' | 'in_progress' | 'completed' | 'error')[] = items.map(
    () => 'pending'
  );
  let spinner: ReturnType<typeof p.spinner> | null = null;
  let currentIndex = -1;

  const getIcon = (status: 'pending' | 'in_progress' | 'completed' | 'error'): string => {
    switch (status) {
      case 'pending':
        return c.muted(figures.circle);
      case 'in_progress':
        return c.brand(figures.circleFilled);
      case 'completed':
        return logSymbols.success;
      case 'error':
        return logSymbols.error;
    }
  };

  const renderLine = (index: number): string => {
    const item = items[index];
    const status = statuses[index];
    const icon = getIcon(status);
    const indexStr = showIndex ? c.muted(`[${index + 1}/${total}]`) + ' ' : '';

    let line = `${indent()}${icon} ${indexStr}${item.label}`;

    if (item.description && status !== 'in_progress') {
      line += c.muted(` - ${item.description}`);
    }

    return line;
  };

  return {
    start: () => {
      if (title) {
        console.log();
        console.log(c.brandBold(title));
        console.log(divider(DIVIDER_WIDTH));
      }
    },

    update: (
      index: number,
      status: 'pending' | 'in_progress' | 'completed' | 'error',
      message?: string
    ) => {
      statuses[index] = status;

      if (status === 'in_progress') {
        if (spinner) {
          spinner.stop();
        }

        currentIndex = index;
        const item = items[index];
        const indexStr = showIndex ? c.muted(`[${index + 1}/${total}]`) + ' ' : '';

        spinner = p.spinner();
        spinner.start(`${indexStr}${message || item.label}`);
      } else if (status === 'completed' || status === 'error') {
        if (spinner && currentIndex === index) {
          spinner.stop(renderLine(index));
          spinner = null;
        } else {
          console.log(renderLine(index));
        }
      }
    },

    complete: (message?: string) => {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      console.log();
      console.log(logSymbols.success, message || 'Completed successfully');
    },

    fail: (message?: string) => {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      console.log();
      console.log(logSymbols.error, message || 'Operation failed');
    },
  };
};
