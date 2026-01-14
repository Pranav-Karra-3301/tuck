/**
 * Auto-update checker for tuck CLI
 * Checks for updates on npm registry and prompts user to update
 */

import updateNotifier from 'update-notifier';
import { execSync, spawnSync } from 'child_process';
import chalk from 'chalk';
import boxen from 'boxen';
import { createInterface } from 'readline';
import { APP_NAME, VERSION } from '../constants.js';

// Package info for update-notifier
const pkg = {
  name: '@prnv/tuck',
  version: VERSION,
};

/**
 * Detect which package manager was used to install tuck
 * Checks npm_config_user_agent first, then falls back to detection
 */
const detectPackageManager = (): 'npm' | 'pnpm' => {
  // Check if pnpm is in the user agent (set when running via pnpm)
  const userAgent = process.env.npm_config_user_agent || '';
  if (userAgent.includes('pnpm')) {
    return 'pnpm';
  }

  // Try to detect if tuck was installed via pnpm global
  try {
    const pnpmList = execSync('pnpm list -g --depth=0 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (pnpmList.includes('@prnv/tuck')) {
      return 'pnpm';
    }
  } catch {
    // pnpm not available or command failed
  }

  // Default to npm
  return 'npm';
};

/**
 * Get the update command for the detected package manager
 */
const getUpdateCommand = (packageManager: 'npm' | 'pnpm'): string => {
  if (packageManager === 'pnpm') {
    return 'pnpm update -g @prnv/tuck';
  }
  return 'npm update -g @prnv/tuck';
};

/**
 * Wait for user to press Enter or cancel
 * Returns true if Enter pressed, false if cancelled
 */
const waitForEnterOrCancel = (): Promise<boolean> => {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Handle Ctrl+C
    rl.on('close', () => {
      resolve(false);
    });

    // Handle Enter
    rl.on('line', () => {
      rl.close();
      resolve(true);
    });

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      rl.close();
      resolve(false);
    });
  });
};

/**
 * Execute the update command
 */
const executeUpdate = (packageManager: 'npm' | 'pnpm'): boolean => {
  const command = getUpdateCommand(packageManager);
  console.log(chalk.dim(`\nUpdating ${APP_NAME} via ${packageManager}...`));

  try {
    const result = spawnSync(packageManager, ['update', '-g', '@prnv/tuck'], {
      stdio: 'inherit',
      shell: true,
    });

    if (result.status === 0) {
      console.log(chalk.green(`\nSuccessfully updated ${APP_NAME}!`));
      console.log(chalk.dim('Restart tuck to use the new version.\n'));
      return true;
    } else {
      console.log(chalk.red('\nUpdate failed.'));
      console.log(chalk.dim(`Run manually: ${command}\n`));
      return false;
    }
  } catch (error) {
    console.log(chalk.red('\nUpdate failed.'));
    console.log(chalk.dim(`Run manually: ${command}\n`));
    return false;
  }
};

/**
 * Check if running in an environment where we should skip update checks
 */
const shouldSkipUpdateCheck = (): boolean => {
  // Skip in CI environments
  if (process.env.CI) {
    return true;
  }

  // Skip if running via npx (one-time execution)
  const execPath = process.env.npm_execpath || '';
  if (execPath.includes('npx')) {
    return true;
  }

  // Skip if NO_UPDATE_CHECK is set
  if (process.env.NO_UPDATE_CHECK) {
    return true;
  }

  // Skip if not a TTY (non-interactive)
  if (!process.stdin.isTTY) {
    return true;
  }

  return false;
};

/**
 * Main function to check for updates and prompt user
 * Called at startup before command execution
 */
export const checkForUpdates = async (): Promise<void> => {
  // Skip in certain environments
  if (shouldSkipUpdateCheck()) {
    return;
  }

  // Check for updates using update-notifier
  // It caches results and only checks periodically (default: once per day)
  const notifier = updateNotifier({
    pkg,
    updateCheckInterval: 1000 * 60 * 60 * 24, // 24 hours
  });

  // If no update available, return early
  if (!notifier.update || notifier.update.latest === VERSION) {
    return;
  }

  const { latest } = notifier.update;
  const packageManager = detectPackageManager();
  const updateCommand = getUpdateCommand(packageManager);

  // Show update notification box
  const message = [
    '',
    chalk.bold(`Update available: ${chalk.red(VERSION)} ${chalk.dim('->')} ${chalk.green(latest)}`),
    '',
    chalk.dim('Press Enter to update, or Ctrl+C to skip'),
    '',
  ].join('\n');

  console.log(
    boxen(message, {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'cyan',
      textAlignment: 'center',
    })
  );

  // Wait for user input
  const shouldUpdate = await waitForEnterOrCancel();

  if (shouldUpdate) {
    const success = executeUpdate(packageManager);
    if (success) {
      // Exit after successful update so user uses new version
      process.exit(0);
    }
    // If update failed, continue with current version
  } else {
    // User skipped update
    console.log(chalk.dim(`\nSkipped. Run '${updateCommand}' to update later.\n`));
  }
};
