/**
 * cloneRepo timeout / maxBuffer guard tests.
 *
 * A hung or hostile remote must not let `tuck init` / `tuck apply` hang forever,
 * and must not let a huge remote buffer unbounded output into memory. simple-git
 * v3 does NOT forward `maxBuffer` to the child process, so cloneRepo shells out
 * to git via Node's `execFile` directly (mirroring CustomProvider.cloneRepo),
 * passing a bounded `timeout` and a `maxBuffer` limit. These tests fully mock
 * `child_process.execFile` so no real git process is ever spawned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GIT_OPERATION_TIMEOUTS } from '../../src/lib/validation.js';

// Hoisted so the vi.mock factory (which is itself hoisted to the top of the
// file) can safely reference these without a TDZ error.
const { execFileMock } = vi.hoisted(() => {
  return { execFileMock: vi.fn() };
});

// Mock child_process.execFile. promisify(execFile) calls execFile with a
// trailing node-style callback; emulate that so the promisified form resolves
// or rejects based on what the test configures.
vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

import { cloneRepo } from '../../src/lib/git.js';

/**
 * Configure execFileMock so the promisified wrapper resolves successfully.
 */
const resolveExecFile = () => {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    callback?.(null, { stdout: '', stderr: '' });
  });
};

describe('cloneRepo timeout/maxBuffer guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveExecFile();
  });

  it('invokes git clone via execFile with a bounded clone timeout', async () => {
    await cloneRepo('https://github.com/user/repo.git', '/test-home/cloned');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { timeout?: number; maxBuffer?: number },
    ];
    expect(cmd).toBe('git');
    expect(args).toEqual(['clone', 'https://github.com/user/repo.git', '/test-home/cloned']);
    expect(opts.timeout).toBe(GIT_OPERATION_TIMEOUTS.CLONE);
  });

  it('invokes git clone via execFile with a maxBuffer limit', async () => {
    await cloneRepo('https://github.com/user/repo.git', '/test-home/cloned');

    const [, , opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { maxBuffer?: number },
    ];
    expect(typeof opts.maxBuffer).toBe('number');
    expect(opts.maxBuffer).toBeGreaterThan(0);
  });

  it('clones the requested url into the target directory', async () => {
    await cloneRepo('https://github.com/user/repo.git', '/test-home/cloned');

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      'clone',
      'https://github.com/user/repo.git',
      '/test-home/cloned',
    ]);
  });

  it('wraps clone failures in a GitError', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback?.(new Error('boom'));
    });

    await expect(
      cloneRepo('https://github.com/user/repo.git', '/test-home/cloned')
    ).rejects.toMatchObject({ code: 'GIT_ERROR' });
  });
});
