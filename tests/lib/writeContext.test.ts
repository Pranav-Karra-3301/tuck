/**
 * Write-context (sandbox / confined-home) unit tests.
 *
 * When tuck runs with --root <dir>, every home-relative write must be redirected
 * UNDER that root and any attempt to escape it (.. or an absolute path outside
 * the root) must be rejected — so an agent can apply/restore/preset into a fake
 * home without any possibility of touching the real ~.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  setWriteContext,
  resetWriteContext,
  setKnownRepoRoots,
  getWriteRoot,
  isSandbox,
  allowedRoots,
  resolveWriteTarget,
} from '../../src/lib/writeContext.js';

afterEach(() => resetWriteContext());

describe('default (no sandbox)', () => {
  it('uses the real home as the write root', () => {
    expect(getWriteRoot()).toBe('/test-home');
    expect(isSandbox()).toBe(false);
    expect(resolveWriteTarget('~/.zshrc')).toBe('/test-home/.zshrc');
  });

  it('still rejects a traversal escape from the real home', () => {
    expect(() => resolveWriteTarget('~/../../etc/passwd')).toThrow();
  });
});

describe('sandbox (--root)', () => {
  it('redirects ~/ writes under the sandbox root', () => {
    setWriteContext({ root: '/tmp/fake-home', isSandbox: true });
    expect(isSandbox()).toBe(true);
    expect(allowedRoots()).toEqual(['/tmp/fake-home']);
    expect(resolveWriteTarget('~/.zshrc')).toBe('/tmp/fake-home/.zshrc');
    expect(resolveWriteTarget('$HOME/.config/x')).toBe('/tmp/fake-home/.config/x');
  });

  it('re-bases an absolute real-home path into the sandbox root', () => {
    setWriteContext({ root: '/tmp/fake-home', isSandbox: true });
    expect(resolveWriteTarget('/test-home/.gitconfig')).toBe('/tmp/fake-home/.gitconfig');
  });

  it('rejects a traversal escape out of the sandbox root', () => {
    setWriteContext({ root: '/tmp/fake-home', isSandbox: true });
    expect(() => resolveWriteTarget('~/../../etc/passwd')).toThrow();
  });

  it('rejects an absolute path outside the sandbox root', () => {
    setWriteContext({ root: '/tmp/fake-home', isSandbox: true });
    expect(() => resolveWriteTarget('/etc/cron.d/evil')).toThrow();
  });
});

describe('repo-scoped write targets', () => {
  const REPO = { repoKey: 'proj-abc12345', repoRelative: 'a/b.txt', repoRoot: '/srv/work/proj' };

  it('resolves to the genuine repo path when not sandboxed', () => {
    expect(resolveWriteTarget('ignored', REPO)).toBe('/srv/work/proj/a/b.txt');
  });

  it('rebases under the sandbox by stable identity (real repoRoot never places the file)', () => {
    setWriteContext({ root: '/tmp/fake-home', isSandbox: true });
    expect(resolveWriteTarget('ignored', REPO)).toBe('/tmp/fake-home/repos/proj-abc12345/a/b.txt');
  });

  it('a hostile repoRoot/repoRelative cannot escape the sandbox', () => {
    setWriteContext({ root: '/tmp/fake-home', isSandbox: true });
    const out = resolveWriteTarget('ignored', {
      repoKey: 'k',
      repoRelative: 'etc/passwd',
      repoRoot: '/',
    });
    expect(out.startsWith('/tmp/fake-home/repos/')).toBe(true);
  });

  it('allowedRoots includes known repo roots (non-sandbox) and only the sandbox root (sandbox)', () => {
    setKnownRepoRoots(['/srv/work/proj']);
    expect(allowedRoots()).toContain('/srv/work/proj');
    expect(allowedRoots()).toContain('/test-home'); // home still allowed

    setWriteContext({ root: '/tmp/fake-home', isSandbox: true });
    setKnownRepoRoots(['/srv/work/proj']);
    expect(allowedRoots()).toEqual(['/tmp/fake-home']);
  });

  it('1-arg resolveWriteTarget is unchanged (home path)', () => {
    expect(resolveWriteTarget('~/.zshrc')).toBe('/test-home/.zshrc');
  });
});
