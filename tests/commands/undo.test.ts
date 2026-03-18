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

const promptsIntroMock = vi.fn();
const promptsOutroMock = vi.fn();
const promptsSelectMock = vi.fn();
const promptsConfirmMock = vi.fn();
const loggerWarningMock = vi.fn();
const loggerDimMock = vi.fn();
const loggerHeadingMock = vi.fn();
const loggerBlankMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerErrorMock = vi.fn();
const loggerSuccessMock = vi.fn();
const loggerFileMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: promptsIntroMock,
    outro: promptsOutroMock,
    select: promptsSelectMock,
    confirm: promptsConfirmMock,
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    note: vi.fn(),
    cancel: vi.fn(),
    log: {
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
  },
  logger: {
    warning: loggerWarningMock,
    dim: loggerDimMock,
    heading: loggerHeadingMock,
    blank: loggerBlankMock,
    info: loggerInfoMock,
    error: loggerErrorMock,
    success: loggerSuccessMock,
    file: loggerFileMock,
  },
  colors: {
    cyan: (value: string) => value,
    dim: (value: string) => value,
    bold: (value: string) => value,
  },
}));

vi.mock('../../src/lib/paths.js', () => ({
  collapsePath: vi.fn((value: string) => value),
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

describe('undo command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    listSnapshotsMock.mockResolvedValue([]);
    getSnapshotMock.mockResolvedValue({
      id: '2026-03-18-120000',
      reason: 'apply',
      machine: 'test-machine',
      files: [
        {
          originalPath: '~/.zshrc',
          existed: true,
        },
      ],
    });
    getLatestSnapshotMock.mockResolvedValue({
      id: '2026-03-18-120000',
      reason: 'apply',
      machine: 'test-machine',
      files: [],
    });
    restoreSnapshotMock.mockResolvedValue(['~/.zshrc']);
    restoreFileFromSnapshotMock.mockResolvedValue(undefined);
    deleteSnapshotMock.mockResolvedValue(undefined);
    getSnapshotsSizeMock.mockResolvedValue(1024);
    formatSnapshotSizeMock.mockReturnValue('1 KB');
    formatSnapshotDateMock.mockReturnValue('Mar 18, 2026');
    promptsSelectMock.mockResolvedValue('2026-03-18-120000');
    promptsConfirmMock.mockResolvedValue(true);
  });

  it('restores a single file from the latest snapshot when --latest and --file are combined', async () => {
    const { undoCommand } = await import('../../src/commands/undo.js');

    await undoCommand.parseAsync(['--latest', '--file', '~/.zshrc'], { from: 'user' });

    expect(getLatestSnapshotMock).toHaveBeenCalled();
    expect(restoreFileFromSnapshotMock).toHaveBeenCalledWith('2026-03-18-120000', '~/.zshrc');
    expect(restoreSnapshotMock).not.toHaveBeenCalled();
  });

  it('shows an error when --file is passed without a snapshot id or --latest', async () => {
    const { undoCommand } = await import('../../src/commands/undo.js');

    await undoCommand.parseAsync(['--file', '~/.zshrc'], { from: 'user' });

    expect(loggerErrorMock).toHaveBeenCalledWith(
      'The --file option requires a snapshot ID or --latest'
    );
    expect(promptsIntroMock).not.toHaveBeenCalled();
    expect(restoreFileFromSnapshotMock).not.toHaveBeenCalled();
  });

  it('reports when a snapshot id is not found', async () => {
    getSnapshotMock.mockResolvedValueOnce(null);
    listSnapshotsMock.mockResolvedValueOnce([]);
    const { undoCommand } = await import('../../src/commands/undo.js');

    await undoCommand.parseAsync(['missing-snapshot'], { from: 'user' });

    expect(loggerErrorMock).toHaveBeenCalledWith('Snapshot not found: missing-snapshot');
    expect(listSnapshotsMock).toHaveBeenCalled();
  });
});
