/**
 * init remote-URL validation unit tests.
 *
 * `tuck init` funneled GitLab/custom users through GitHub: the manual remote
 * URL prompt validated with validateGitHubUrl, which REJECTS any non-github.com
 * URL. validateRemoteUrlForMode validates against the chosen provider instead,
 * so GitLab/custom URLs are accepted.
 *
 * validateRemoteUrlForMode is now the validator wired into the interactive init
 * manual remote-URL prompts (src/commands/init.ts: promptForManualRepoUrl and
 * the fresh-init manual GitHub URL prompt both call
 * `validateRemoteUrlForMode('github', value)`), so the github-mode cases below
 * guard the real prompt behavior: if init reverted to funneling every URL
 * through a GitHub-only check, the gitlab/custom contract asserted here would
 * regress.
 */
import { describe, it, expect } from 'vitest';
import { validateRemoteUrlForMode } from '../../src/commands/init.js';

describe('validateRemoteUrlForMode', () => {
  it('accepts a GitHub URL in github mode (wired into the manual repo-URL prompt)', () => {
    expect(validateRemoteUrlForMode('github', 'https://github.com/u/dotfiles.git')).toBeUndefined();
    expect(validateRemoteUrlForMode('github', 'git@github.com:u/dotfiles.git')).toBeUndefined();
  });

  it('rejects a GitLab URL in github mode', () => {
    expect(validateRemoteUrlForMode('github', 'https://gitlab.com/u/dots.git')).toBeTruthy();
  });

  it('accepts a GitLab URL in gitlab mode (the funnel fix)', () => {
    expect(validateRemoteUrlForMode('gitlab', 'https://gitlab.com/u/dots.git')).toBeUndefined();
    expect(validateRemoteUrlForMode('gitlab', 'git@gitlab.com:u/dots.git')).toBeUndefined();
  });

  it('rejects a non-gitlab host in gitlab mode', () => {
    expect(validateRemoteUrlForMode('gitlab', 'https://github.com/u/dots.git')).toBeTruthy();
  });

  it('accepts any valid git URL in custom mode', () => {
    expect(
      validateRemoteUrlForMode('custom', 'https://git.example.com/u/dots.git')
    ).toBeUndefined();
  });

  it('accepts a URL in local mode (no remote URL needed)', () => {
    // local mode carries no remote URL, so a non-empty value is never rejected
    expect(validateRemoteUrlForMode('local', 'anything')).toBeUndefined();
  });

  it('requires a non-empty, non-whitespace URL', () => {
    // Every mode goes through the up-front presence guard before any
    // provider-specific check runs.
    for (const mode of ['github', 'gitlab', 'custom', 'local'] as const) {
      expect(validateRemoteUrlForMode(mode, '')).toBe('Repository URL is required');
      expect(validateRemoteUrlForMode(mode, '   ')).toBe('Repository URL is required');
    }
  });
});
