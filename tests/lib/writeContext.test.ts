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
