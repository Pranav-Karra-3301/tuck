/**
 * apply <source> classification unit tests.
 *
 * To reduce GitHub reliance, `tuck apply` must accept a fully provider-free
 * source: a local directory or tarball (no remote at all), in addition to
 * provider:owner/repo, full git URLs, and bare owner/repo.
 */
import { describe, it, expect } from 'vitest';
import { isTarballPath } from '../../src/commands/apply.js';

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
