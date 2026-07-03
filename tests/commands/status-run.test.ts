/**
 * runStatus branch/envelope tests.
 *
 * status.test.ts covers detectFileChanges' manifest-safety paths. This file
 * drives the top-level runStatus over mocked git + manifest + state-model so we
 * pin: the NotInitialized guard, the remote-status derivation (up-to-date /
 * ahead / behind / diverged / no-remote), the --json envelope shape, and the
 * --short one-liner. No real git repo is touched.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const getStatusMock = vi.fn();
const hasRemoteMock = vi.fn();
const getRemoteUrlMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const computeStateModelMock = vi.fn();
const loadTuckignoreMock = vi.fn();

vi.mock('../../src/lib/git.js', () => ({
  getStatus: getStatusMock,
  hasRemote: hasRemoteMock,
  getRemoteUrl: getRemoteUrlMock,
  getCurrentBranch: getCurrentBranchMock,
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
}));

vi.mock('../../src/lib/stateModel.js', () => ({
  computeStateModel: computeStateModelMock,
}));

vi.mock('../../src/lib/tuckignore.js', () => ({
  loadTuckignore: loadTuckignoreMock,
}));

const cleanGitStatus = {
  ahead: 0,
  behind: 0,
  staged: [] as string[],
  modified: [] as string[],
  untracked: [] as string[],
};

const captureStdout = () => {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return { writes, spy };
};

describe('runStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadManifestMock.mockResolvedValue({
      files: {
        zshrc: { category: 'shell' },
        gitconfig: { category: 'git' },
      },
    });
    getAllTrackedFilesMock.mockResolvedValue({});
    computeStateModelMock.mockResolvedValue([]);
    loadTuckignoreMock.mockResolvedValue(new Set<string>());
    getStatusMock.mockResolvedValue({ ...cleanGitStatus });
    getCurrentBranchMock.mockResolvedValue('main');
    hasRemoteMock.mockResolvedValue(false);
    getRemoteUrlMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws NotInitializedError when the manifest cannot be loaded', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('no manifest'));
    const { runStatus } = await import('../../src/commands/status.js');
    const { NotInitializedError } = await import('../../src/errors.js');
    await expect(runStatus({})).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('emits a JSON envelope with the computed status (no remote → no-remote)', async () => {
    const { runStatus } = await import('../../src/commands/status.js');
    const { writes, spy } = captureStdout();

    await runStatus({ json: true });
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck status');
    expect(env.data.branch).toBe('main');
    expect(env.data.remoteStatus).toBe('no-remote');
    expect(env.data.trackedCount).toBe(2);
    expect(env.data.categoryCounts).toEqual({ shell: 1, git: 1 });
    expect(env.data.changes).toEqual([]);
  });

  it('derives remoteStatus = ahead when local is ahead of a remote', async () => {
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('https://github.com/u/dotfiles.git');
    getStatusMock.mockResolvedValue({ ...cleanGitStatus, ahead: 2 });

    const { runStatus } = await import('../../src/commands/status.js');
    const { writes, spy } = captureStdout();
    await runStatus({ json: true });
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.data.remoteStatus).toBe('ahead');
    expect(env.data.ahead).toBe(2);
    expect(env.data.remote).toBe('https://github.com/u/dotfiles.git');
  });

  it('derives remoteStatus = behind', async () => {
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('https://github.com/u/dotfiles.git');
    getStatusMock.mockResolvedValue({ ...cleanGitStatus, behind: 3 });

    const { runStatus } = await import('../../src/commands/status.js');
    const { writes, spy } = captureStdout();
    await runStatus({ json: true });
    spy.mockRestore();

    expect(JSON.parse(writes.join('').trim()).data.remoteStatus).toBe('behind');
  });

  it('derives remoteStatus = diverged when both ahead and behind', async () => {
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('https://github.com/u/dotfiles.git');
    getStatusMock.mockResolvedValue({ ...cleanGitStatus, ahead: 1, behind: 1 });

    const { runStatus } = await import('../../src/commands/status.js');
    const { writes, spy } = captureStdout();
    await runStatus({ json: true });
    spy.mockRestore();

    expect(JSON.parse(writes.join('').trim()).data.remoteStatus).toBe('diverged');
  });

  it('derives remoteStatus = up-to-date when a remote exists and is in sync', async () => {
    hasRemoteMock.mockResolvedValue(true);
    getRemoteUrlMock.mockResolvedValue('https://github.com/u/dotfiles.git');

    const { runStatus } = await import('../../src/commands/status.js');
    const { writes, spy } = captureStdout();
    await runStatus({ json: true });
    spy.mockRestore();

    expect(JSON.parse(writes.join('').trim()).data.remoteStatus).toBe('up-to-date');
  });

  it('surfaces detected file changes in the envelope', async () => {
    computeStateModelMock.mockResolvedValue([
      { source: '~/.zshrc', destination: 'files/shell/zshrc', state: 'drift-local' },
      { source: '~/.vimrc', destination: 'files/editors/vimrc', state: 'missing-live' },
      { source: '~/.ok', destination: 'files/misc/ok', state: 'ok' },
    ]);

    const { runStatus } = await import('../../src/commands/status.js');
    const { writes, spy } = captureStdout();
    await runStatus({ json: true });
    spy.mockRestore();

    const changes = JSON.parse(writes.join('').trim()).data.changes;
    // 'ok' produces no change entry; drift → modified, missing-live → deleted.
    expect(changes).toHaveLength(2);
    expect(changes.find((c: { path: string }) => c.path === '~/.zshrc').status).toBe('modified');
    expect(changes.find((c: { path: string }) => c.path === '~/.vimrc').status).toBe('deleted');
  });

  it('honors .tuckignore when building the change list', async () => {
    computeStateModelMock.mockResolvedValue([
      { source: '~/.zshrc', destination: 'files/shell/zshrc', state: 'drift-local' },
    ]);
    loadTuckignoreMock.mockResolvedValue(new Set(['~/.zshrc']));

    const { runStatus } = await import('../../src/commands/status.js');
    const { writes, spy } = captureStdout();
    await runStatus({ json: true });
    spy.mockRestore();

    expect(JSON.parse(writes.join('').trim()).data.changes).toEqual([]);
  });

  it('--short prints a compact one-line summary', async () => {
    getStatusMock.mockResolvedValue({ ...cleanGitStatus });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runStatus } = await import('../../src/commands/status.js');
    await runStatus({ short: true });

    const line = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    logSpy.mockRestore();
    expect(line).toContain('[main]');
    expect(line).toContain('(2 tracked)');
  });
});
