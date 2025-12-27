import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { logger } from '../ui/logger.js';
import { prompts } from '../ui/prompts.js';

const execAsync = promisify(exec);

export type HookType = 'preSync' | 'postSync' | 'preRestore' | 'postRestore';

export interface HookResult {
  success: boolean;
  output?: string;
  error?: string;
  skipped?: boolean;
}

export interface HookOptions {
  silent?: boolean;
  skipHooks?: boolean;
  trustHooks?: boolean;
}

/**
 * SECURITY: This function executes shell commands from the configuration file.
 * When cloning from untrusted repositories, hooks could contain malicious commands.
 * We require explicit user confirmation before executing any hooks.
 */
export const runHook = async (
  hookType: HookType,
  tuckDir: string,
  options?: HookOptions
): Promise<HookResult> => {
  // If hooks are explicitly disabled, skip execution
  if (options?.skipHooks) {
    return { success: true, skipped: true };
  }

  const config = await loadConfig(tuckDir);
  const command = config.hooks[hookType];

  if (!command) {
    return { success: true };
  }

  // SECURITY: Always show the hook command and require confirmation
  // unless trustHooks is explicitly set (for non-interactive/scripted use)
  if (!options?.trustHooks) {
    console.log();
    console.log(chalk.yellow.bold('WARNING: Hook Execution'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.white(`Hook type: ${chalk.cyan(hookType)}`));
    console.log(chalk.white('Command:'));
    console.log(chalk.red(`  ${command}`));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(
      chalk.yellow(
        'SECURITY: Hooks can execute arbitrary commands on your system.'
      )
    );
    console.log(
      chalk.yellow(
        'Only proceed if you trust the source of this configuration.'
      )
    );
    console.log();

    const confirmed = await prompts.confirm(
      'Execute this hook?',
      false // Default to NO for safety
    );

    if (!confirmed) {
      logger.warning(`Hook ${hookType} skipped by user`);
      return { success: true, skipped: true };
    }
  }

  if (!options?.silent) {
    logger.dim(`Running ${hookType} hook...`);
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: tuckDir,
      timeout: 30000, // 30 second timeout
      env: {
        ...process.env,
        TUCK_DIR: tuckDir,
        TUCK_HOOK: hookType,
      },
    });

    if (stdout && !options?.silent) {
      logger.dim(stdout.trim());
    }

    if (stderr && !options?.silent) {
      logger.warning(stderr.trim());
    }

    return { success: true, output: stdout };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (!options?.silent) {
      logger.error(`Hook ${hookType} failed: ${errorMessage}`);
    }

    return { success: false, error: errorMessage };
  }
};

export const runPreSyncHook = async (
  tuckDir: string,
  options?: HookOptions
): Promise<HookResult> => {
  return runHook('preSync', tuckDir, options);
};

export const runPostSyncHook = async (
  tuckDir: string,
  options?: HookOptions
): Promise<HookResult> => {
  return runHook('postSync', tuckDir, options);
};

export const runPreRestoreHook = async (
  tuckDir: string,
  options?: HookOptions
): Promise<HookResult> => {
  return runHook('preRestore', tuckDir, options);
};

export const runPostRestoreHook = async (
  tuckDir: string,
  options?: HookOptions
): Promise<HookResult> => {
  return runHook('postRestore', tuckDir, options);
};

export const hasHook = async (hookType: HookType, tuckDir: string): Promise<boolean> => {
  const config = await loadConfig(tuckDir);
  return Boolean(config.hooks[hookType]);
};

export const getHookCommand = async (
  hookType: HookType,
  tuckDir: string
): Promise<string | undefined> => {
  const config = await loadConfig(tuckDir);
  return config.hooks[hookType];
};

/**
 * Check if any hooks are configured
 */
export const hasAnyHooks = async (tuckDir: string): Promise<boolean> => {
  const config = await loadConfig(tuckDir);
  return Boolean(
    config.hooks.preSync ||
    config.hooks.postSync ||
    config.hooks.preRestore ||
    config.hooks.postRestore
  );
};

/**
 * Get all configured hooks for display
 */
export const getAllHooks = async (
  tuckDir: string
): Promise<Record<HookType, string | undefined>> => {
  const config = await loadConfig(tuckDir);
  return {
    preSync: config.hooks.preSync,
    postSync: config.hooks.postSync,
    preRestore: config.hooks.preRestore,
    postRestore: config.hooks.postRestore,
  };
};
