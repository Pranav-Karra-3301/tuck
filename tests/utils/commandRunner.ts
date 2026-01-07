/**
 * Utilities for running and testing commands
 */

import { vi } from 'vitest';

export interface CommandResult {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

/**
 * Capture console output during command execution
 */
export const captureOutput = (): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  console.warn = (...args: unknown[]) => stderr.push(args.join(' '));

  return {
    stdout,
    stderr,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
};

/**
 * Run a command action and capture its output
 */
export const runCommand = async <
  T extends (...args: unknown[]) => Promise<void>,
>(
  action: T,
  ...args: Parameters<T>
): Promise<CommandResult> => {
  const { stdout, stderr, restore } = captureOutput();
  let exitCode = 0;

  // Mock process.exit
  const originalExit = process.exit;
  process.exit = vi.fn((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as never;

  try {
    await action(...args);
  } catch (error) {
    if (
      !(error instanceof Error && error.message.startsWith('process.exit'))
    ) {
      // Re-throw if not a process.exit mock
      stderr.push(error instanceof Error ? error.message : String(error));
      exitCode = 1;
    }
  } finally {
    restore();
    process.exit = originalExit;
  }

  return { stdout, stderr, exitCode };
};

/**
 * Assert command output contains expected strings
 */
export const assertOutputContains = (
  result: CommandResult,
  expected: string[]
): void => {
  const allOutput = [...result.stdout, ...result.stderr].join('\n');
  for (const str of expected) {
    if (!allOutput.includes(str)) {
      throw new Error(
        `Expected output to contain "${str}"\n\nActual output:\n${allOutput}`
      );
    }
  }
};

/**
 * Assert command output does NOT contain strings
 */
export const assertOutputNotContains = (
  result: CommandResult,
  notExpected: string[]
): void => {
  const allOutput = [...result.stdout, ...result.stderr].join('\n');
  for (const str of notExpected) {
    if (allOutput.includes(str)) {
      throw new Error(
        `Expected output to NOT contain "${str}"\n\nActual output:\n${allOutput}`
      );
    }
  }
};

/**
 * Create a mock for @clack/prompts
 */
export const createPromptsMock = (responses: Record<string, unknown>) => {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockImplementation((message: string) => {
      // Check for partial matches in response keys
      for (const [key, value] of Object.entries(responses)) {
        if (message.includes(key)) {
          return Promise.resolve(value);
        }
      }
      return Promise.resolve(false);
    }),
    select: vi.fn().mockImplementation((message: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (message.includes(key)) {
          return Promise.resolve(value);
        }
      }
      return Promise.resolve(null);
    }),
    text: vi.fn().mockImplementation((message: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (message.includes(key)) {
          return Promise.resolve(value);
        }
      }
      return Promise.resolve('');
    }),
    multiselect: vi.fn().mockImplementation((message: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (message.includes(key)) {
          return Promise.resolve(value);
        }
      }
      return Promise.resolve([]);
    }),
    spinner: vi.fn().mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    }),
    note: vi.fn(),
    cancel: vi.fn(),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
    isCancel: vi.fn().mockReturnValue(false),
    group: vi.fn().mockImplementation(async (steps: Record<string, () => Promise<unknown>>) => {
      const results: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(steps)) {
        results[key] = await fn();
      }
      return results;
    }),
  };
};

/**
 * Create a mock for simple-git
 */
export const createGitMock = (options?: {
  status?: {
    current?: string;
    tracking?: string;
    ahead?: number;
    behind?: number;
    files?: Array<{ path: string; index: string; working_dir: string }>;
  };
  remotes?: Array<{ name: string; refs: { fetch: string; push: string } }>;
}) => {
  const defaultStatus = {
    current: 'main',
    tracking: 'origin/main',
    ahead: 0,
    behind: 0,
    files: [],
    isClean: () => true,
    ...options?.status,
  };

  return {
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc1234' }),
    push: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue(defaultStatus),
    getRemotes: vi.fn().mockResolvedValue(options?.remotes ?? []),
    addRemote: vi.fn().mockResolvedValue(undefined),
    removeRemote: vi.fn().mockResolvedValue(undefined),
    clone: vi.fn().mockResolvedValue(undefined),
    branch: vi.fn().mockResolvedValue({ current: 'main', all: ['main'] }),
    log: vi.fn().mockResolvedValue({ all: [], latest: null }),
    diff: vi.fn().mockResolvedValue(''),
    raw: vi.fn().mockResolvedValue(''),
  };
};
