/**
 * cloneRepo timeout / maxBuffer guard tests.
 *
 * A hung or hostile remote must not let `tuck init` / `tuck apply` hang forever,
 * so cloneRepo configures the simple-git instance with a bounded timeout and a
 * maxBuffer limit (mirroring CustomProvider.cloneRepo). These tests assert the
 * git client is created with those guards wired up — the simple-git factory is
 * fully mocked so no real git process is ever spawned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GIT_OPERATION_TIMEOUTS } from '../../src/lib/validation.js';

// Hoisted so the vi.mock factory (which is itself hoisted to the top of the
// file) can safely reference these without a TDZ error.
const { cloneFn, simpleGitFactory } = vi.hoisted(() => {
  const cloneFn = vi.fn();
  const mockGitInstance = { clone: cloneFn };
  // Capture the options the factory is constructed with.
  const simpleGitFactory = vi.fn(() => mockGitInstance);
  return { cloneFn, simpleGitFactory };
});

vi.mock('simple-git', () => ({
  default: simpleGitFactory,
  simpleGit: simpleGitFactory,
}));

import { cloneRepo } from '../../src/lib/git.js';

describe('cloneRepo timeout/maxBuffer guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneFn.mockResolvedValue(undefined);
  });

  it('creates the git client with a bounded clone timeout', async () => {
    await cloneRepo('https://github.com/user/repo.git', '/test-home/cloned');

    expect(simpleGitFactory).toHaveBeenCalledTimes(1);
    const config = simpleGitFactory.mock.calls[0][0] as {
      timeout?: { block?: number };
    };
    expect(config).toBeDefined();
    expect(config.timeout?.block).toBe(GIT_OPERATION_TIMEOUTS.CLONE);
  });

  it('creates the git client with a maxBuffer limit', async () => {
    await cloneRepo('https://github.com/user/repo.git', '/test-home/cloned');

    const config = simpleGitFactory.mock.calls[0][0] as { maxBuffer?: number };
    expect(typeof config.maxBuffer).toBe('number');
    expect(config.maxBuffer).toBeGreaterThan(0);
  });

  it('clones the requested url into the target directory', async () => {
    await cloneRepo('https://github.com/user/repo.git', '/test-home/cloned');

    expect(cloneFn).toHaveBeenCalledWith(
      'https://github.com/user/repo.git',
      '/test-home/cloned'
    );
  });

  it('wraps clone failures in a GitError', async () => {
    cloneFn.mockRejectedValueOnce(new Error('boom'));

    await expect(
      cloneRepo('https://github.com/user/repo.git', '/test-home/cloned')
    ).rejects.toMatchObject({ code: 'GIT_ERROR' });
  });
});
