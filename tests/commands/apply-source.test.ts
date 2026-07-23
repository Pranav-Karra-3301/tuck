/**
 * apply <source> classification unit tests.
 *
 * To reduce GitHub reliance, `tuck apply` must accept a fully provider-free
 * source: a local directory or tarball (no remote at all), in addition to
 * provider:owner/repo, full git URLs, and bare owner/repo.
 */
import { describe, it, expect } from 'vitest';
import { isTarballPath, isGzipTarball, tarExtractArgs } from '../../src/commands/apply.js';

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

describe('isGzipTarball', () => {
  it('recognizes gzip-compressed archives', () => {
    expect(isGzipTarball('/x/dots.tar.gz')).toBe(true);
    expect(isGzipTarball('/x/dots.TAR.GZ')).toBe(true);
    expect(isGzipTarball('/x/dots.tgz')).toBe(true);
  });
  it('treats a plain .tar as uncompressed', () => {
    expect(isGzipTarball('/x/dots.tar')).toBe(false);
  });
  it('rejects non-tarballs', () => {
    expect(isGzipTarball('/x/dots')).toBe(false);
    expect(isGzipTarball('/x/dots.zip')).toBe(false);
  });
});

describe('tarExtractArgs', () => {
  it('passes -z only for gzip archives', () => {
    expect(tarExtractArgs('/x/dots.tar.gz', '/tmp/out')).toEqual([
      '-xzf',
      '/x/dots.tar.gz',
      '-C',
      '/tmp/out',
    ]);
    expect(tarExtractArgs('/x/dots.tgz', '/tmp/out')).toEqual([
      '-xzf',
      '/x/dots.tgz',
      '-C',
      '/tmp/out',
    ]);
  });
  it('omits -z for a plain uncompressed .tar so GNU tar does not error on gzip check', () => {
    const args = tarExtractArgs('/x/dots.tar', '/tmp/out');
    expect(args).toEqual(['-xf', '/x/dots.tar', '-C', '/tmp/out']);
    // Regression guard: -z must never be forced on a plain .tar.
    expect(args[0]).not.toContain('z');
  });
});
