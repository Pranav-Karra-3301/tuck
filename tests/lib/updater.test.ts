/**
 * Update-check skip conditions and the interactive update prompt.
 *
 * The update prompt (promptForUpdate) is interactive. Under any non-interactive
 * mode — an explicit `--non-interactive`, `--json`, or a non-TTY stdin — an agent
 * driving tuck in a PTY would otherwise block forever. `shouldSkipUpdateCheck()`
 * must return true in every one of those cases. promptForUpdate itself must skip
 * (return false) rather than abort on Ctrl+C, and must not leak a SIGINT handler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setNonInteractive } from '../../src/lib/agentMode.js';
import { setJsonMode } from '../../src/lib/jsonOutput.js';

// The cancel sentinel @clack/prompts returns from `isCancel`. Using a real
// symbol lets us drive `promptForUpdate` through its Ctrl+C path without a TTY.
const CANCEL_SYMBOL = Symbol('clack:cancel');

const confirmMock = vi.fn();

vi.mock('@clack/prompts', () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  isCancel: (value: unknown) => value === CANCEL_SYMBOL,
}));

const { shouldSkipUpdateCheck, promptForUpdate } = await import('../../src/lib/updater.js');

const originalStdinTTY = process.stdin.isTTY;
const originalCI = process.env.CI;
const originalNpx = process.env.npm_execpath;
const originalNoUpdate = process.env.NO_UPDATE_CHECK;

const setStdinTTY = (value: boolean): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value, writable: true, configurable: true });
};

beforeEach(() => {
  setNonInteractive(false);
  setJsonMode(false);
  delete process.env.CI;
  delete process.env.npm_execpath;
  delete process.env.NO_UPDATE_CHECK;
  // A real interactive terminal: without the fixes below this is the only case
  // where the update check would proceed.
  setStdinTTY(true);
});

afterEach(() => {
  setNonInteractive(false);
  setJsonMode(false);
  setStdinTTY(originalStdinTTY as boolean);
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
  if (originalNpx === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = originalNpx;
  if (originalNoUpdate === undefined) delete process.env.NO_UPDATE_CHECK;
  else process.env.NO_UPDATE_CHECK = originalNoUpdate;
});

describe('shouldSkipUpdateCheck', () => {
  it('does NOT skip on a plain interactive TTY with no suppression signal', () => {
    expect(shouldSkipUpdateCheck()).toBe(false);
  });

  it('skips when the explicit --non-interactive flag is set, even on a TTY', () => {
    setNonInteractive(true);
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it('skips in JSON mode even on a TTY (the prompt would corrupt the envelope)', () => {
    setJsonMode(true);
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it('skips when stdin is not a TTY (piped / agent / CI)', () => {
    setStdinTTY(false);
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it('skips in CI', () => {
    process.env.CI = 'true';
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it('skips when NO_UPDATE_CHECK is set', () => {
    process.env.NO_UPDATE_CHECK = '1';
    expect(shouldSkipUpdateCheck()).toBe(true);
  });
});

describe('promptForUpdate', () => {
  beforeEach(() => {
    confirmMock.mockReset();
  });

  it('returns true when the user confirms', async () => {
    confirmMock.mockResolvedValue(true);
    await expect(promptForUpdate()).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it('returns false when the user declines', async () => {
    confirmMock.mockResolvedValue(false);
    await expect(promptForUpdate()).resolves.toBe(false);
  });

  it('returns false (skip, do not abort) when the prompt is cancelled with Ctrl+C', async () => {
    confirmMock.mockResolvedValue(CANCEL_SYMBOL);
    // Must resolve false rather than throw: the update prompt is optional and
    // the surrounding command has to keep running after a skip.
    await expect(promptForUpdate()).resolves.toBe(false);
  });

  it('does not leak a persistent process-level SIGINT listener', async () => {
    // Regression guard for the old readline implementation, which registered a
    // `process.on('SIGINT', ...)` handler on every invocation and never removed
    // it. @clack/prompts owns its own keypress lifecycle, so the process-level
    // SIGINT listener count must be unchanged across many prompt cycles.
    confirmMock.mockResolvedValue(CANCEL_SYMBOL);
    const before = process.listenerCount('SIGINT');
    for (let i = 0; i < 5; i++) {
      await promptForUpdate();
    }
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
