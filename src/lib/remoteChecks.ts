/**
 * Remote Configuration Checks
 *
 * Shared utilities for checking remote configuration and local mode.
 */

import { prompts } from '../ui/index.js';
import { loadConfig } from './config.js';

/**
 * Check if tuck is in local-only mode
 */
export const checkLocalMode = async (tuckDir: string): Promise<boolean> => {
  try {
    const config = await loadConfig(tuckDir);
    if (config.remote?.mode === 'local') {
      return true;
    }
  } catch {
    // Config not found or invalid - proceed with remote operations
  }
  return false;
};

/**
 * Show local mode warning (for pull command)
 */
export const showLocalModeWarningForPull = async (): Promise<void> => {
  prompts.log.warning('Tuck is configured for local-only mode (no remote sync).');
  console.log();
  prompts.note(
    'Your dotfiles are tracked locally but not synced to a remote.\n\n' +
      'To enable remote sync, run:\n' +
      '  tuck config remote\n\n' +
      'Or re-initialize with:\n' +
      '  tuck init',
    'Local Mode'
  );
};

/**
 * Show local mode warning and offer to configure remote (for push command)
 */
export const showLocalModeWarningForPush = async (): Promise<boolean> => {
  prompts.log.warning('Tuck is configured for local-only mode (no remote sync).');
  console.log();
  prompts.note(
    'Your dotfiles are tracked locally but not synced to a remote.\n\n' +
      'To enable remote sync, run:\n' +
      '  tuck config remote\n\n' +
      'Or re-initialize with:\n' +
      '  tuck init',
    'Local Mode'
  );
  console.log();

  const configureNow = await prompts.confirm('Would you like to configure a remote now?');

  if (configureNow) {
    prompts.log.info("Run 'tuck config remote' to set up a remote repository.");
  }

  return configureNow;
};
