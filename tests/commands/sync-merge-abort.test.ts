import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MergeConflictsError } from '../../src/errors.js';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const getTrackedFileBySourceMock = vi.fn();
const pathExistsMock = vi.fn();
const getFileChecksumMock = vi.fn();
const loadTuckignoreMock = vi.fn();
const isIgnoredMock = vi.fn();
const resolveLiveTargetMock = vi.fn();

const stageAllMock = vi.fn();
const commitMock = vi.fn();
const getStatusMock = vi.fn();
const pushMock = vi.fn();
const hasRemoteMock = vi.fn();
const fetchMock = vi.fn();
const pullMock = vi.fn();

const detectConflictsMock = vi.fn();
const abortRebaseMock = vi.fn();
const continueRebaseMock = vi.fn();
const applyResolutionMock = vi.fn();

const createSnapshotMock = vi.fn();
const checkLocalModeMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    confirmDangerous: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    multiselect: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
  },
  logger: {
    info: vi.fn(),
    warning: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    file: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    dim: vi.fn(),
  },
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  colors: { dim: (x: string) => x },
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  pathExists: pathExistsMock,
  collapsePath: vi.fn((p: string) => p),
  getDestinationPathFromSource: vi.fn(),
  detectCategory: vi.fn(() => 'misc'),
  sanitizeFilename: vi.fn((path: string) => path.split('/').pop() || 'file'),
  isDirectory: vi.fn().mockResolvedValue(false),
  validateSafeSourcePath: vi.fn(),
  validateSafeManifestDestination: vi.fn(),
  validatePathWithinRoot: vi.fn(),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
  updateFileInManifest: vi.fn(),
  removeFileFromManifest: vi.fn(),
  getTrackedFileBySource: getTrackedFileBySourceMock,
  clearManifestCache: vi.fn(),
}));

vi.mock('../../src/lib/repoScope.js', () => ({
  resolveLiveTarget: resolveLiveTargetMock,
}));

vi.mock('../../src/lib/git.js', () => ({
  stageAll: stageAllMock,
  commit: commitMock,
  getStatus: getStatusMock,
  push: pushMock,
  hasRemote: hasRemoteMock,
  fetch: fetchMock,
  pull: pullMock,
}));

vi.mock('../../src/lib/mergeConflicts.js', () => ({
  detectConflicts: detectConflictsMock,
  abortRebase: abortRebaseMock,
  continueRebase: continueRebaseMock,
  applyResolution: applyResolutionMock,
}));

vi.mock('../../src/ui/merge.js', () => ({
  resolveConflictsInteractively: vi.fn(),
}));

vi.mock('../../src/lib/timemachine.js', () => ({
  createSnapshot: createSnapshotMock,
}));

vi.mock('../../src/lib/files.js', () => ({
  copyFileOrDir: vi.fn(),
  getFileChecksum: getFileChecksumMock,
  deleteFileOrDir: vi.fn(),
  checkFileSizeThreshold: vi.fn().mockResolvedValue({ warn: false, block: false, size: 10 }),
  formatFileSize: vi.fn((n: number) => `${n} B`),
  SIZE_BLOCK_THRESHOLD: 100 * 1024 * 1024,
}));

vi.mock('../../src/lib/tuckignore.js', () => ({
  addToTuckignore: vi.fn(),
  loadTuckignore: loadTuckignoreMock,
  isIgnored: isIgnoredMock,
}));

vi.mock('../../src/lib/hooks.js', () => ({
  runPreSyncHook: vi.fn(),
  runPostSyncHook: vi.fn(),
}));

vi.mock('../../src/lib/detect.js', () => ({
  detectDotfiles: vi.fn().mockResolvedValue([]),
  DETECTION_CATEGORIES: {},
}));

vi.mock('../../src/lib/fileTracking.js', () => ({
  trackFilesWithProgress: vi
    .fn()
    .mockResolvedValue({ succeeded: 0, failed: 0, errors: [], sensitiveFiles: [] }),
}));

vi.mock('../../src/lib/trackPipeline.js', () => ({
  preparePathsForTracking: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  scanForSecrets: vi.fn().mockResolvedValue({ totalSecrets: 0, results: [] }),
  isSecretScanningEnabled: vi.fn().mockResolvedValue(false),
  shouldBlockOnSecrets: vi.fn().mockResolvedValue(true),
  processSecretsForRedaction: vi.fn(),
  redactFile: vi.fn(),
}));

vi.mock('../../src/commands/secrets.js', () => ({
  displayScanResults: vi.fn(),
}));

vi.mock('../../src/lib/audit.js', () => ({
  logForceSecretBypass: vi.fn(),
}));

vi.mock('../../src/lib/remoteChecks.js', () => ({
  checkLocalMode: checkLocalModeMock,
}));

describe('sync --json pull-conflict: abort rebase, leave ~/.tuck clean', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    loadTuckignoreMock.mockResolvedValue(new Set());
    getAllTrackedFilesMock.mockResolvedValue({});
    pathExistsMock.mockResolvedValue(true);
    isIgnoredMock.mockResolvedValue(false);
    getFileChecksumMock.mockResolvedValue('checksum');
    checkLocalModeMock.mockResolvedValue(false);
    createSnapshotMock.mockResolvedValue(undefined);
    abortRebaseMock.mockResolvedValue(undefined);

    // Remote is behind by one commit, so a pull is attempted.
    hasRemoteMock.mockResolvedValue(true);
    fetchMock.mockResolvedValue(undefined);
    getStatusMock.mockResolvedValue({ behind: 1, ahead: 0 });
    // The rebase pull fails...
    pullMock.mockRejectedValue(new Error('CONFLICT (content): rebase failed'));
    // ...and the index is left with a conflicted file.
    detectConflictsMock.mockResolvedValue([
      { path: 'files/shell/.zshrc', ours: 'a', theirs: 'b' },
    ]);
  });

  it('aborts the in-progress rebase BEFORE throwing in JSON mode', async () => {
    const { runSync } = await import('../../src/commands/sync.js');

    await expect(
      runSync({ json: true, noHooks: true, scan: false } as never)
    ).rejects.toBeInstanceOf(MergeConflictsError);

    // The rebase MUST have been aborted so ~/.tuck is not left mid-rebase.
    expect(abortRebaseMock).toHaveBeenCalledWith('/test-home/.tuck');
  });

  it('throws a MergeConflictsError carrying a stable code and recovery hints', async () => {
    const { runSync } = await import('../../src/commands/sync.js');

    let caught: unknown;
    try {
      await runSync({ json: true, noHooks: true, scan: false } as never);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MergeConflictsError);
    const e = caught as MergeConflictsError;
    expect(e.code).toBe('MERGE_CONFLICTS');
    expect(e.conflicts).toEqual(['files/shell/.zshrc']);
    // Recovery instructions must be present for agents/JSON envelope.
    expect(e.suggestions && e.suggestions.length).toBeGreaterThan(0);
    // The JSON projection must expose the stable code + hint.
    const json = e.toJSON();
    expect(json.code).toBe('MERGE_CONFLICTS');
    expect(json.exit_code).toBe(3);
    expect(json.hint).toBeTruthy();
  });

  it('aborts the rebase before throwing in --yes (non-interactive) mode too', async () => {
    const { runSync } = await import('../../src/commands/sync.js');

    await expect(
      runSync({ yes: true, noHooks: true, scan: false } as never)
    ).rejects.toBeInstanceOf(MergeConflictsError);

    expect(abortRebaseMock).toHaveBeenCalledWith('/test-home/.tuck');
  });
});
