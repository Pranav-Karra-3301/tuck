/**
 * Agent / non-interactive mode unit tests.
 *
 * These signals are the contract that lets an agent safely drive tuck:
 *  - `isNonInteractive()` gates every prompt (explicit flag, JSON mode, or no TTY);
 *  - `configureColor()` strips ANSI for machine consumers while honoring FORCE_COLOR.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import {
  setNonInteractive,
  isNonInteractive,
  isNonInteractiveFlagSet,
  configureColor,
} from '../../src/lib/agentMode.js';
import { setJsonMode } from '../../src/lib/jsonOutput.js';

const originalStdinTTY = process.stdin.isTTY;
const originalStdoutTTY = process.stdout.isTTY;
const originalChalkLevel = chalk.level;
const originalNoColor = process.env.NO_COLOR;
const originalForceColor = process.env.FORCE_COLOR;

const setTTY = (stream: NodeJS.WriteStream | NodeJS.ReadStream, value: boolean): void => {
  Object.defineProperty(stream, 'isTTY', { value, writable: true, configurable: true });
};

beforeEach(() => {
  setNonInteractive(false);
  setJsonMode(false);
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  chalk.level = 3;
});

afterEach(() => {
  setNonInteractive(false);
  setJsonMode(false);
  setTTY(process.stdin, originalStdinTTY as boolean);
  setTTY(process.stdout, originalStdoutTTY as boolean);
  chalk.level = originalChalkLevel;
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
  vi.restoreAllMocks();
});

describe('isNonInteractive', () => {
  it('is false when stdin is a TTY and no flag / json mode is set', () => {
    setTTY(process.stdin, true);
    expect(isNonInteractive()).toBe(false);
  });

  it('is true when the explicit --non-interactive flag is set, even on a TTY', () => {
    setTTY(process.stdin, true);
    setNonInteractive(true);
    expect(isNonInteractive()).toBe(true);
    expect(isNonInteractiveFlagSet()).toBe(true);
  });

  it('is true in JSON mode even on a TTY (a prompt would corrupt the envelope)', () => {
    setTTY(process.stdin, true);
    setJsonMode(true);
    expect(isNonInteractive()).toBe(true);
    // JSON mode is not the explicit flag.
    expect(isNonInteractiveFlagSet()).toBe(false);
  });

  it('is true when stdin is not a TTY (piped / agent / CI)', () => {
    setTTY(process.stdin, false);
    expect(isNonInteractive()).toBe(true);
  });
});

describe('configureColor', () => {
  it('suppresses ANSI when stdout is not a TTY', () => {
    setTTY(process.stdout, false);
    configureColor();
    expect(chalk.level).toBe(0);
  });

  it('suppresses ANSI in JSON mode even on a TTY', () => {
    setTTY(process.stdout, true);
    setJsonMode(true);
    configureColor();
    expect(chalk.level).toBe(0);
  });

  it('suppresses ANSI when --non-interactive is set', () => {
    setTTY(process.stdout, true);
    setNonInteractive(true);
    configureColor();
    expect(chalk.level).toBe(0);
  });

  it('suppresses ANSI when NO_COLOR is set', () => {
    setTTY(process.stdout, true);
    process.env.NO_COLOR = '1';
    configureColor();
    expect(chalk.level).toBe(0);
  });

  it('leaves color enabled on an interactive TTY with no suppression signal', () => {
    setTTY(process.stdout, true);
    chalk.level = 2;
    configureColor();
    expect(chalk.level).toBe(2);
  });

  it('honors an explicit FORCE_COLOR even when stdout is not a TTY', () => {
    setTTY(process.stdout, false);
    process.env.FORCE_COLOR = '1';
    chalk.level = 2;
    configureColor();
    expect(chalk.level).toBe(2);
  });
});
