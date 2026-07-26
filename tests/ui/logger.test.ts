/**
 * Logger JSON-mode gating.
 *
 * The jsonOutput contract is "exactly one JSON object on stdout" per --json run.
 * Every logger method writes human text via console.log (stdout), so in JSON
 * mode the informational methods must be silenced and the diagnostic ones
 * (warning/error) redirected to console.error (stderr) — otherwise a stray log
 * line corrupts the machine envelope an agent/CI parses (the root cause behind
 * apply/scan/secrets --json pollution). In human mode behavior is unchanged.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { logger } from '../../src/ui/logger.js';
import { setJsonMode } from '../../src/lib/jsonOutput.js';

afterEach(() => {
  setJsonMode(false);
  vi.restoreAllMocks();
});

describe('logger in JSON mode', () => {
  it('suppresses informational output (no console.log) when json is set', () => {
    setJsonMode(true, 'tuck test');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('reading source');
    logger.success('done');
    logger.heading('Applying:');
    logger.file('add', '~/.zshrc');
    logger.dim('hint');
    logger.blank();

    expect(log).not.toHaveBeenCalled();
  });

  it('routes warning/error to console.error (never console.log) when json is set', () => {
    setJsonMode(true, 'tuck test');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.warning('unsafe manifest entry');
    logger.error('boom');

    expect(log).not.toHaveBeenCalled();
    const errText = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errText).toContain('unsafe manifest entry');
    expect(errText).toContain('boom');
  });
});

describe('logger in human mode', () => {
  it('still writes informational output via console.log when json is off', () => {
    setJsonMode(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('hello human');

    const logText = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logText).toContain('hello human');
  });
});
