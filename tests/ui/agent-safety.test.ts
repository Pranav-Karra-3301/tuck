/**
 * Agent-safety guards for prompts/spinners.
 *
 *  - In JSON mode, spinners must emit nothing to stdout (they would otherwise
 *    interleave clack frames into the single-JSON-object stream).
 *  - prompts.cancel() must THROW OperationCancelledError (non-zero exit via
 *    handleError), not process.exit(0) (a misleading "success").
 *  - Interactive prompts must refuse (throw) when stdin is not a TTY rather than
 *    hanging on input an agent can never provide.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { prompts, withSpinner } from '../../src/ui/index.js';
import { OperationCancelledError } from '../../src/errors.js';
import { setJsonMode } from '../../src/lib/jsonOutput.js';

afterEach(() => {
  setJsonMode(false);
  vi.restoreAllMocks();
});

describe('withSpinner in JSON mode', () => {
  it('returns the result and writes nothing to stdout', async () => {
    setJsonMode(true, 'tuck test');
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      writes.push(String(c));
      return true;
    });

    const result = await withSpinner('working', async () => 42);

    expect(result).toBe(42);
    expect(writes.join('')).toBe('');
  });
});

describe('prompts.cancel', () => {
  it('throws OperationCancelledError instead of exiting', () => {
    setJsonMode(true, 'tuck test');
    expect(() => prompts.cancel()).toThrow(OperationCancelledError);
  });
});

describe('interactive prompts without a TTY', () => {
  it('confirm throws OperationCancelledError when stdin is not a TTY', async () => {
    // vitest stdin is not a TTY
    await expect(prompts.confirm('proceed?')).rejects.toThrow(OperationCancelledError);
  });
});
