/**
 * undo command branch coverage.
 *
 * Complements undo.test.ts (which covers --latest/--file, not-found, and the
 * --latest/--delete JSON happy paths). Here we pin the remaining decision
 * branches: --list (human + JSON), the dry-run envelopes, confirm-cancelled,
 * single-file not-found, delete-not-found, --latest with no snapshots, and the
 * no-argument JSON hint envelope. All timemachine + UI deps are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSnapshotsMock = vi.fn();
const getSnapshotMock = vi.fn();
const getLatestSnapshotMock = vi.fn();
const restoreSnapshotMock = vi.fn();
const restoreFileFromSnapshotMock = vi.fn();
const deleteSnapshotMock = vi.fn();
const getSnapshotsSizeMock = vi.fn();
const formatSnapshotSizeMock = vi.fn();
const formatSnapshotDateMock = vi.fn();

const promptsConfirmMock = vi.fn();
const loggerWarningMock = vi.fn();
const loggerErrorMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerHeadingMock = vi.fn();
const loggerFileMock = vi.fn();
const loggerSuccessMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    select: vi.fn(),
    confirm: promptsConfirmMock,
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    note: vi.fn(),
    cancel: vi.fn(),
    log: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  },
  logger: {
    warning: loggerWarningMock,
    dim: vi.fn(),
    heading: loggerHeadingMock,
    blank: vi.fn(),
    info: loggerInfoMock,
    error: loggerErrorMock,
    success: loggerSuccessMock,
    file: loggerFileMock,
  },
  colors: {
    cyan: (v: string) => v,
    dim: (v: string) => v,
    bold: (v: string) => v,
  },
}));

vi.mock('../../src/lib/paths.js', () => ({
  collapsePath: vi.fn((v: string) => v),
}));

vi.mock('../../src/lib/timemachine.js', () => ({
  listSnapshots: listSnapshotsMock,
  getSnapshot: getSnapshotMock,
  getLatestSnapshot: getLatestSnapshotMock,
  restoreSnapshot: restoreSnapshotMock,
  restoreFileFromSnapshot: restoreFileFromSnapshotMock,
  deleteSnapshot: deleteSnapshotMock,
  getSnapshotsSize: getSnapshotsSizeMock,
  formatSnapshotSize: formatSnapshotSizeMock,
  formatSnapshotDate: formatSnapshotDateMock,
}));

const SNAP = {
  id: '2026-03-18-120000',
  reason: 'apply',
  machine: 'test-machine',
  files: [
    { originalPath: '~/.zshrc', existed: true },
    { originalPath: '~/.vimrc', existed: false },
  ],
};

const captureStdout = () => {
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
  return { writes, spy };
};

describe('undo command branches', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    listSnapshotsMock.mockResolvedValue([SNAP]);
    getSnapshotMock.mockResolvedValue(SNAP);
    getLatestSnapshotMock.mockResolvedValue(SNAP);
    restoreSnapshotMock.mockResolvedValue(['~/.zshrc']);
    restoreFileFromSnapshotMock.mockResolvedValue(undefined);
    deleteSnapshotMock.mockResolvedValue(undefined);
    getSnapshotsSizeMock.mockResolvedValue(2048);
    formatSnapshotSizeMock.mockReturnValue('2 KB');
    formatSnapshotDateMock.mockReturnValue('Mar 18, 2026');
    promptsConfirmMock.mockResolvedValue(true);
  });

  it('--list --json emits an envelope with the snapshot summary', async () => {
    const { writes, spy } = captureStdout();
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['--list', '--json'], { from: 'user' });
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.data.count).toBe(1);
    expect(env.data.snapshots[0].id).toBe(SNAP.id);
    // fileCount counts only files that existed at snapshot time.
    expect(env.data.snapshots[0].fileCount).toBe(1);
  });

  it('--list (human) warns when there are no snapshots', async () => {
    listSnapshotsMock.mockResolvedValue([]);
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['--list'], { from: 'user' });
    expect(loggerWarningMock).toHaveBeenCalledWith('No backup snapshots found');
  });

  it('--list (human) prints a heading when snapshots exist', async () => {
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['--list'], { from: 'user' });
    expect(loggerHeadingMock).toHaveBeenCalledWith('Backup Snapshots:');
  });

  it('cancels the restore when the confirm prompt is declined', async () => {
    promptsConfirmMock.mockResolvedValue(false);
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['2026-03-18-120000'], { from: 'user' });

    expect(promptsConfirmMock).toHaveBeenCalled();
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith('Restore cancelled');
  });

  it('restores immediately with --force (no confirm prompt)', async () => {
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['2026-03-18-120000', '--force'], { from: 'user' });

    expect(promptsConfirmMock).not.toHaveBeenCalled();
    expect(restoreSnapshotMock).toHaveBeenCalledWith('2026-03-18-120000');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Restored 1 file(s)');
  });

  it('--dry-run --json reports wouldRestore / wouldRemove without restoring', async () => {
    const { writes, spy } = captureStdout();
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['2026-03-18-120000', '--dry-run', '--json'], { from: 'user' });
    spy.mockRestore();

    expect(restoreSnapshotMock).not.toHaveBeenCalled();
    const env = JSON.parse(writes.join('').trim());
    expect(env.data.dryRun).toBe(true);
    expect(env.data.wouldRestore).toEqual(['~/.zshrc']);
    expect(env.data.wouldRemove).toEqual(['~/.vimrc']);
  });

  it('--dry-run (human) lists modify/delete without restoring', async () => {
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['2026-03-18-120000', '--dry-run'], { from: 'user' });
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
    expect(loggerFileMock).toHaveBeenCalledWith('modify', '~/.zshrc');
  });

  it('--file with a missing snapshot emits found:false in JSON', async () => {
    getSnapshotMock.mockResolvedValue(null);
    const { writes, spy } = captureStdout();
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(
      ['2026-03-18-120000', '--file', '~/.zshrc', '--json'],
      { from: 'user' }
    );
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.data.found).toBe(false);
    expect(env.data.restored).toBe(false);
    expect(restoreFileFromSnapshotMock).not.toHaveBeenCalled();
  });

  it('--file --dry-run --json short-circuits before restoring the file', async () => {
    const { writes, spy } = captureStdout();
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(
      ['2026-03-18-120000', '--file', '~/.zshrc', '--dry-run', '--json'],
      { from: 'user' }
    );
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.data.dryRun).toBe(true);
    expect(restoreFileFromSnapshotMock).not.toHaveBeenCalled();
  });

  it('--delete on a missing snapshot emits found:false in JSON', async () => {
    getSnapshotMock.mockResolvedValue(null);
    const { writes, spy } = captureStdout();
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['--delete', 'ghost', '--json'], { from: 'user' });
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.data.found).toBe(false);
    expect(env.data.deleted).toBeNull();
    expect(deleteSnapshotMock).not.toHaveBeenCalled();
  });

  it('--latest with no snapshots emits found:false in JSON', async () => {
    getLatestSnapshotMock.mockResolvedValue(null);
    const { writes, spy } = captureStdout();
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['--latest', '--json'], { from: 'user' });
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.data.found).toBe(false);
    expect(env.data.restored).toEqual([]);
  });

  it('--latest with no snapshots warns in human mode', async () => {
    getLatestSnapshotMock.mockResolvedValue(null);
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['--latest'], { from: 'user' });
    expect(loggerWarningMock).toHaveBeenCalledWith('No backup snapshots available');
  });

  it('no arguments in JSON mode emits a hint envelope instead of prompting', async () => {
    const { writes, spy } = captureStdout();
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['--json'], { from: 'user' });
    spy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.data.restored).toEqual([]);
    expect(env.data.hint).toContain('snapshot id');
  });

  it('restores a single file (human) via a snapshot id + --file', async () => {
    const { undoCommand } = await import('../../src/commands/undo.js');
    await undoCommand.parseAsync(['2026-03-18-120000', '--file', '~/.zshrc'], { from: 'user' });
    expect(restoreFileFromSnapshotMock).toHaveBeenCalledWith('2026-03-18-120000', '~/.zshrc');
    expect(loggerSuccessMock).toHaveBeenCalledWith('Restored ~/.zshrc');
  });
});
