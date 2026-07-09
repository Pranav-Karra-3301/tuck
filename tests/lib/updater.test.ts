/**
 * Update-check skip conditions.
 *
 * The update prompt uses a raw readline (waitForEnterOrCancel) that bypasses the
 * clack interactive gate. Under any non-interactive mode — an explicit
 * `--non-interactive`, `--json`, or a non-TTY stdin — an agent driving tuck in a
 * PTY would otherwise block forever. `shouldSkipUpdateCheck()` must return true
 * in every one of those cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldSkipUpdateCheck } from '../../src/lib/updater.js';
import { setNonInteractive } from '../../src/lib/agentMode.js';
import { setJsonMode } from '../../src/lib/jsonOutput.js';

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
