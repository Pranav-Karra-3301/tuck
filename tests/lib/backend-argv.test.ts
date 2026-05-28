/**
 * Secret-backend argument-injection guard unit tests.
 *
 * backendPath comes from a committed mappings file and is passed as an argv
 * element to an external CLI (op/bw/pass). execFile uses no shell, so a single
 * argv element can only be reinterpreted as a flag if it starts with '-'.
 * Reject leading-dash paths to close the injection vector.
 */
import { describe, it, expect } from 'vitest';
import { assertSafeBackendPath } from '../../src/lib/secretBackends/types.js';

describe('assertSafeBackendPath', () => {
  it('accepts a normal backend path', () => {
    expect(() => assertSafeBackendPath('pass', 'GITHUB_TOKEN', 'work/github/token')).not.toThrow();
  });

  it('accepts an op:// reference', () => {
    expect(() =>
      assertSafeBackendPath('1password', 'TOKEN', 'op://vault/item/field')
    ).not.toThrow();
  });

  it('rejects a path starting with a dash (flag injection)', () => {
    expect(() => assertSafeBackendPath('pass', 'X', '--version')).toThrow();
  });

  it('rejects a short-flag-style path', () => {
    expect(() => assertSafeBackendPath('bitwarden', 'X', '-rf')).toThrow();
  });
});
