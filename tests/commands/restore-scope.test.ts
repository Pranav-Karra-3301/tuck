/**
 * restore scope-guard unit tests.
 *
 * `tuck restore --yes` (or `--json`) with no paths and no --all must NOT be
 * interpreted as "restore everything over the live system". --yes means
 * "skip the confirmation", never "expand the scope to all files".
 */
import { describe, it, expect } from 'vitest';
import { assertRestoreScopeExplicit } from '../../src/commands/restore.js';

describe('assertRestoreScopeExplicit', () => {
  it('throws for --yes with no paths and no --all', () => {
    expect(() => assertRestoreScopeExplicit(0, { yes: true })).toThrow();
  });

  it('throws for --json with no paths and no --all', () => {
    expect(() => assertRestoreScopeExplicit(0, { json: true })).toThrow();
  });

  it('allows --all even non-interactively', () => {
    expect(() => assertRestoreScopeExplicit(0, { yes: true, all: true })).not.toThrow();
  });

  it('allows explicit paths', () => {
    expect(() => assertRestoreScopeExplicit(2, { yes: true })).not.toThrow();
  });

  it('does not throw when neither --json nor --yes (interactive path handles it)', () => {
    expect(() => assertRestoreScopeExplicit(0, {})).not.toThrow();
  });
});
