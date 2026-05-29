/**
 * Repo-scope path-guard unit tests.
 *
 * Repo-scoped files live under a repo root that may be OUTSIDE $HOME, so the
 * home-only validateSafeSourcePath cannot gate them. validateSafeRepoSourcePath
 * confines a repo file to its (bound) repo root instead — still rejecting ..
 * traversal and absolute paths. getRepoScopedDestination namespaces the repo
 * copy under files/repos/<key>/... and stays a safe relative manifest path.
 */
import { describe, it, expect } from 'vitest';
import {
  validateSafeRepoSourcePath,
  getRepoScopedDestination,
} from '../../src/lib/paths.js';

describe('validateSafeRepoSourcePath', () => {
  it('accepts a file under a repo root OUTSIDE $HOME', () => {
    expect(() => validateSafeRepoSourcePath('/tmp/foo', '.vscode/settings.json')).not.toThrow();
    expect(() => validateSafeRepoSourcePath('/srv/work/proj', 'CLAUDE.md')).not.toThrow();
  });

  it('rejects a .. traversal out of the repo root', () => {
    expect(() => validateSafeRepoSourcePath('/tmp/foo', '../escape')).toThrow();
    expect(() => validateSafeRepoSourcePath('/tmp/foo', 'a/../../escape')).toThrow();
  });

  it('rejects an absolute repoRelative', () => {
    expect(() => validateSafeRepoSourcePath('/tmp/foo', '/etc/passwd')).toThrow();
  });
});

describe('getRepoScopedDestination', () => {
  it('namespaces the repo copy under files/repos/<key>/', () => {
    expect(getRepoScopedDestination('abc123', '.vscode/settings.json')).toBe(
      'files/repos/abc123/.vscode/settings.json'
    );
  });

  it('rejects a traversal in the repoRelative', () => {
    expect(() => getRepoScopedDestination('abc123', '../../etc/passwd')).toThrow();
  });
});
