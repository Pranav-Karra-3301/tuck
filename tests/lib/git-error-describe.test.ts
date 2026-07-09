/**
 * describeGitError classification tests (issue #52).
 *
 * Git stderr is terse; tuck names the likely cause and the fix. These tests pin
 * the classification so the machine-readable suggestions stay stable for agents.
 */
import { describe, it, expect } from 'vitest';
import { describeGitError } from '../../src/lib/git.js';
import { GitError } from '../../src/errors.js';

describe('describeGitError', () => {
  it('classifies a non-fast-forward push rejection with pull/force suggestions', () => {
    const raw =
      '! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to ...';
    const err = describeGitError('push', raw);
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe('GIT_ERROR');
    expect(err.message).toContain('remote has commits you do not have locally');
    expect(err.suggestions?.join(' ')).toContain('tuck pull');
    expect(err.suggestions?.join(' ')).toContain('tuck push --force');
    // Raw output is preserved for debugging.
    expect(err.gitOutput).toBe(raw);
  });

  it('classifies a missing upstream on push', () => {
    const err = describeGitError('push', 'fatal: The current branch main has no upstream branch.');
    expect(err.message).toContain('no upstream configured');
    expect(err.suggestions?.join(' ')).toContain('upstream');
  });

  it('classifies authentication failure on push', () => {
    const err = describeGitError('push', 'remote: Invalid username or password.\nfatal: Authentication failed');
    expect(err.message).toContain('authentication with the remote was rejected');
    expect(err.suggestions?.join(' ')).toContain('gh auth login');
  });

  it('classifies an unreachable host on fetch', () => {
    const err = describeGitError('fetch', "fatal: unable to access 'https://...': Could not resolve host: github.com");
    expect(err.message).toContain('could not reach the remote');
    expect(err.suggestions?.join(' ')).toContain('network');
  });

  it('classifies merge conflicts on pull', () => {
    const err = describeGitError('pull', 'CONFLICT (content): Merge conflict in .zshrc');
    expect(err.message).toContain('merge conflicts');
    expect(err.suggestions?.join(' ')).toContain('git status');
  });

  it('classifies divergent branches on pull', () => {
    const err = describeGitError('pull', 'fatal: Need to specify how to reconcile divergent branches.');
    expect(err.message).toContain('diverged');
  });

  it('classifies uncommitted local changes on pull', () => {
    const err = describeGitError(
      'pull',
      'error: Your local changes to the following files would be overwritten by merge'
    );
    expect(err.message).toContain('uncommitted local changes');
    expect(err.suggestions?.join(' ')).toContain('tuck sync');
  });

  it('falls back to a generic message with the raw output preserved', () => {
    const raw = 'fatal: some entirely novel git failure';
    const err = describeGitError('push', raw);
    expect(err.message).toContain('Failed to push');
    expect(err.gitOutput).toBe(raw);
    // Generic path still ships actionable suggestions.
    expect(err.suggestions && err.suggestions.length).toBeGreaterThan(0);
  });
});
