/**
 * init remote-URL validation unit tests.
 *
 * `tuck init` funneled GitLab/custom users through GitHub: the manual remote
 * URL prompt validated with validateGitHubUrl, which REJECTS any non-github.com
 * URL. validateRemoteUrlForMode validates against the chosen provider instead,
 * so GitLab/custom URLs are accepted.
 */
import { describe, it, expect } from 'vitest';
import { validateRemoteUrlForMode } from '../../src/commands/init.js';

describe('validateRemoteUrlForMode', () => {
  it('accepts a GitHub URL in github mode', () => {
    expect(validateRemoteUrlForMode('github', 'https://github.com/u/dotfiles.git')).toBeUndefined();
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

  it('requires a non-empty URL', () => {
    expect(validateRemoteUrlForMode('gitlab', '')).toBeTruthy();
  });
});
