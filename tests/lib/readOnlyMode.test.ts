import { describe, it, expect, afterEach } from 'vitest';
import {
  enterReadOnlyMode,
  isReadOnlyMode,
  resetReadOnlyMode,
  assertNotReadOnly,
  withReadOnlyMode,
} from '../../src/lib/readOnlyMode.js';
import { ReadOnlyViolationError } from '../../src/errors.js';

describe('readOnlyMode', () => {
  afterEach(() => resetReadOnlyMode());

  it('starts off and flips on via enterReadOnlyMode', () => {
    expect(isReadOnlyMode()).toBe(false);
    enterReadOnlyMode();
    expect(isReadOnlyMode()).toBe(true);
  });

  it('is idempotent and reset restores the off state', () => {
    enterReadOnlyMode();
    enterReadOnlyMode();
    expect(isReadOnlyMode()).toBe(true);
    resetReadOnlyMode();
    expect(isReadOnlyMode()).toBe(false);
  });

  it('assertNotReadOnly is a no-op when off', () => {
    expect(() => assertNotReadOnly('read backend')).not.toThrow();
  });

  it('assertNotReadOnly throws ReadOnlyViolationError when on', () => {
    enterReadOnlyMode();
    expect(() => assertNotReadOnly('resolve secret "X"')).toThrow(ReadOnlyViolationError);
  });

  it('the violation error names the blocked operation and carries a stable code', () => {
    enterReadOnlyMode();
    try {
      assertNotReadOnly('resolve secret "API_KEY"');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReadOnlyViolationError);
      const e = err as ReadOnlyViolationError;
      expect(e.code).toBe('READ_ONLY_VIOLATION');
      expect(e.message).toContain('resolve secret "API_KEY"');
    }
  });

  it('withReadOnlyMode forces read-only for the callback then restores', async () => {
    expect(isReadOnlyMode()).toBe(false);
    const seen = await withReadOnlyMode(async () => isReadOnlyMode());
    expect(seen).toBe(true);
    expect(isReadOnlyMode()).toBe(false);
  });

  it('withReadOnlyMode restores the previous state even on throw', async () => {
    await expect(
      withReadOnlyMode(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isReadOnlyMode()).toBe(false);
  });
});
