/**
 * apply <source> classification unit tests.
 *
 * To reduce GitHub reliance, `tuck apply` must accept a fully provider-free
 * source: a local directory or tarball (no remote at all), in addition to
 * provider:owner/repo, full git URLs, and bare owner/repo.
 */
import { describe, it, expect } from 'vitest';
import { classifyApplySource, isTarballPath } from '../../src/commands/apply.js';

describe('classifyApplySource', () => {
  it('detects a provider-prefixed source', () => {
    expect(classifyApplySource('gitlab:user/dots', false)).toBe('provider-prefixed');
  });

  it('treats an existing local path as local (highest precedence)', () => {
    // Even though "./dots" has no slash-owner form, an existing path wins.
    expect(classifyApplySource('/home/me/dots', true)).toBe('local');
    expect(classifyApplySource('user/dots', true)).toBe('local');
  });

  it('detects a full git URL when no local path exists', () => {
    expect(classifyApplySource('https://example.com/u/dots.git', false)).toBe('git-url');
    expect(classifyApplySource('git@example.com:u/dots.git', false)).toBe('git-url');
  });

  it('detects a bare owner/repo identifier', () => {
    expect(classifyApplySource('user/dotfiles', false)).toBe('repo-id');
  });

  it('falls back to username for a bare token', () => {
    expect(classifyApplySource('someuser', false)).toBe('username');
  });
});

describe('isTarballPath', () => {
  it('recognizes tar archives', () => {
    expect(isTarballPath('/x/dots.tar.gz')).toBe(true);
    expect(isTarballPath('/x/dots.tgz')).toBe(true);
    expect(isTarballPath('/x/dots.tar')).toBe(true);
  });
  it('rejects non-tarballs', () => {
    expect(isTarballPath('/x/dots')).toBe(false);
    expect(isTarballPath('/x/dots.zip')).toBe(false);
  });
});
