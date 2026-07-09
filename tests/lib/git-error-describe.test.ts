/**
 * describeGitError classification tests (issue #52).
 *
 * Git stderr is terse; tuck names the likely cause and the fix. These tests pin
 * the classification so the machine-readable suggestions stay stable for agents.
 */
import { describe, it, expect } from 'vitest';
import { describeGitError, scrubCredentials } from '../../src/lib/git.js';
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

  it('surfaces the raw first line as a suggestion on the generic fallback', () => {
    const raw = "fatal: '/nowhere/repo' does not appear to be a git repository\nfatal: Could not read from remote repository.";
    for (const op of ['push', 'pull', 'fetch'] as const) {
      const err = describeGitError(op, raw);
      expect(err.suggestions?.join(' ')).toContain("does not appear to be a git repository");
    }
  });

  it('serializes git_output in the JSON envelope', () => {
    const raw = 'fatal: some entirely novel git failure';
    const err = describeGitError('push', raw);
    expect(err.toJSON().git_output).toBe(raw);
  });

  it('classified auth failures do not leak into substring re-classification traps', () => {
    // The message deliberately contains the word "rejected" — command layers
    // must not remap it to "push rejected" (they rethrow GitError as-is now).
    const err = describeGitError('push', 'remote: Invalid credentials');
    expect(err.message).toContain('authentication');
    expect(err.message).not.toContain('commits you do not have');
  });
});

describe('scrubCredentials', () => {
  it('redacts userinfo (user:token@) from an https URL', () => {
    const out = scrubCredentials('https://alice:ghp_secretTOKEN123@github.com/alice/dotfiles.git');
    expect(out).toBe('https://***@github.com/alice/dotfiles.git');
    expect(out).not.toContain('ghp_secretTOKEN123');
    expect(out).not.toContain('alice:');
  });

  it('redacts a bare token embedded as userinfo', () => {
    const out = scrubCredentials('fatal: unable to access https://ghp_abc123DEF@github.com/x/y.git');
    expect(out).toContain('https://***@github.com/x/y.git');
    expect(out).not.toContain('ghp_abc123DEF');
  });

  it('redacts a standalone ghp_ token even without a URL', () => {
    const out = scrubCredentials('token was ghp_ABCdef0123456789 rejected');
    expect(out).toBe('token was ghp_*** rejected');
  });

  it('redacts github_pat_ fine-grained tokens', () => {
    const out = scrubCredentials('using github_pat_11ABCDEFG_someMoreChars99 here');
    expect(out).not.toContain('github_pat_11ABCDEFG_someMoreChars99');
    expect(out).toContain('github_pat_***');
  });

  it('redacts glpat- GitLab tokens', () => {
    const out = scrubCredentials('remote glpat-XYZ-123-abc denied');
    expect(out).not.toContain('glpat-XYZ-123-abc');
    expect(out).toContain('glpat-***');
  });

  it('leaves credential-free text unchanged', () => {
    const raw = 'https://github.com/user/repo.git\n! [rejected] main -> main (non-fast-forward)';
    expect(scrubCredentials(raw)).toBe(raw);
  });
});

describe('describeGitError credential scrubbing', () => {
  it('scrubs userinfo from gitOutput and its JSON projection', () => {
    const raw =
      "fatal: unable to access 'https://bob:ghp_LEAKED12345@github.com/bob/dotfiles.git/': The requested URL returned error: 403";
    const err = describeGitError('push', raw);
    expect(err.gitOutput).not.toContain('ghp_LEAKED12345');
    expect(err.gitOutput).not.toContain('bob:ghp_');
    expect(err.gitOutput).toContain('https://***@github.com');
    // ...and the serialized envelope an agent parses.
    expect(err.toJSON().git_output).not.toContain('ghp_LEAKED12345');
  });

  it('scrubs the token out of the raw-first-line suggestion on the generic fallback', () => {
    // A novel (unclassified) failure that carries a token in the URL falls
    // through to the generic branch, which copies the first raw line into a
    // suggestion (and thus the hint). That copy must be scrubbed too.
    const raw =
      'fatal: weird breakage talking to https://ghp_TOKENinSuggestion@github.com/x/y.git during the operation';
    const err = describeGitError('fetch', raw);
    const suggestions = (err.suggestions ?? []).join(' ');
    // Confirm we actually exercised the raw-first-line path.
    expect(suggestions).toContain('git said:');
    expect(suggestions).not.toContain('ghp_TOKENinSuggestion');
    expect(suggestions).toContain('https://***@github.com');
    expect(err.toJSON().hint ?? '').not.toContain('ghp_TOKENinSuggestion');
  });
});
