import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { logger } from '../ui/logger.js';
import { prompts } from '../ui/prompts.js';
import { IS_WINDOWS } from './platform.js';
import { isJsonMode, addJsonWarning } from './jsonOutput.js';
import { isNonInteractive } from './agentMode.js';

const execAsync = promisify(exec);

/**
 * Get the best available shell for Windows
 * Prefers PowerShell Core (pwsh) over Windows PowerShell (powershell.exe)
 * Falls back to cmd.exe if neither is available
 */
const getWindowsShell = (): string => {
  // Try PowerShell Core first (cross-platform, more modern)
  try {
    execSync('pwsh -Version', { stdio: 'ignore' });
    return 'pwsh';
  } catch {
    // pwsh not available
  }

  // Fall back to Windows PowerShell
  try {
    execSync('powershell.exe -Version', { stdio: 'ignore' });
    return 'powershell.exe';
  } catch {
    // powershell.exe not available
  }

  // Last resort: cmd.exe
  return 'cmd.exe';
};

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

export type HookDecision = 'skip' | 'run' | 'prompt' | 'skip-non-interactive';

/**
 * Decide whether/how to execute a hook. Hooks run arbitrary shell from the
 * config, so the rules are deliberately conservative:
 *   - no command or explicitly disabled  → skip
 *   - `--trust-hooks`                     → run
 *   - non-interactive (JSON/agent/no TTY) → skip (NEVER block on a prompt)
 *   - interactive                         → prompt for confirmation
 */
export const decideHookExecution = (input: {
  skipHooks?: boolean;
  hasCommand: boolean;
  trustHooks?: boolean;
  nonInteractive: boolean;
}): HookDecision => {
  if (input.skipHooks || !input.hasCommand) return 'skip';
  if (input.trustHooks) return 'run';
  if (input.nonInteractive) return 'skip-non-interactive';
  return 'prompt';
};

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

  // SECURITY: hooks execute arbitrary shell from the (possibly untrusted)
  // config. Decide how to proceed based on trust + interactivity.
  // Include stdin: the trust prompt reads from stdin, so a non-TTY stdin
  // (e.g. `tuck sync < /dev/null`) must take the skip path, not attempt a
  // prompt that ensureInteractive() would throw on and abort the command.
  // isNonInteractive() also covers the explicit `--non-interactive` flag (and
  // JSON mode / non-TTY stdin) so a PTY run of `--non-interactive` skips the
  // hook with a warning instead of dying on a confirm it can never answer.
  const nonInteractive = isNonInteractive() || !process.stdout.isTTY || !process.stdin.isTTY;
  const decision = decideHookExecution({
    skipHooks: options?.skipHooks,
    hasCommand: true,
    trustHooks: options?.trustHooks,
    nonInteractive,
  });

  if (decision === 'skip-non-interactive') {
    // Never block on a stdin prompt an agent can't answer, and never corrupt
    // the JSON stdout contract with a human warning block.
    const msg = `Hook ${hookType} skipped: pass --trust-hooks to run hooks in non-interactive mode`;
    if (isJsonMode()) addJsonWarning(msg);
    else if (!options?.silent) logger.warning(msg);
    return { success: true, skipped: true };
  }

  if (decision === 'prompt') {
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
    // On Windows, use the best available shell (pwsh > powershell.exe > cmd.exe)
    // On Unix-like systems, use the default shell
    const shellOptions = IS_WINDOWS
      ? { shell: getWindowsShell() }
      : {};

    const { stdout, stderr } = await execAsync(command, {
      cwd: tuckDir,
      timeout: 30000, // 30 second timeout
      env: {
        ...process.env,
        TUCK_DIR: tuckDir,
        TUCK_HOOK: hookType,
      },
      ...shellOptions,
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
