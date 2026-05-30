/**
 * Regression tests for the W4-B sync change-detection perf refactor.
 *
 * The old syncFiles() re-read the whole tracked-files map repeatedly and did a
 * linear Object.values(...).find() per change to recover each file id:
 *   - getAllTrackedFiles() once in detectChanges,
 *   - getAllTrackedFiles() once per change to home-confine the source,
 *   - getAllTrackedFiles() AGAIN inside the modified/deleted branch, then a
 *     `.find(f => f.source === change.source)` to recover the id.
 * That made id recovery O(changes × tracked) and the map reloads O(changes).
 *
 * The refactor carries the file `id` on each change (resolved once via the
 * source index) and loads the tracked-files map a small CONSTANT number of
 * times, independent of the change count. Observable outputs (copies, manifest
 * updates, commit) are unchanged — this only removes redundant work.
 *
 * Mirrors tests/commands/sync.test.ts' mock topology so the seams are identical.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const updateFileInManifestMock = vi.fn();
const removeFileFromManifestMock = vi.fn();
const getTrackedFileBySourceMock = vi.fn();
const buildSourceIndexMock = vi.fn();
const pathExistsMock = vi.fn();
const copyFileOrDirMock = vi.fn();
const getFileChecksumMock = vi.fn();
const deleteFileOrDirMock = vi.fn();
const loadTuckignoreMock = vi.fn();
const isIgnoredMock = vi.fn();
const resolveLiveTargetMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    confirmDangerous: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('abort'),
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
  validateSafeSourcePath: vi.fn(),
  validateSafeManifestDestination: vi.fn(),
  validatePathWithinRoot: vi.fn(),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
  updateFileInManifest: updateFileInManifestMock,
  removeFileFromManifest: removeFileFromManifestMock,
  getTrackedFileBySource: getTrackedFileBySourceMock,
  buildSourceIndex: buildSourceIndexMock,
}));

vi.mock('../../src/lib/repoScope.js', () => ({
  resolveLiveTarget: resolveLiveTargetMock,
}));

vi.mock('../../src/lib/git.js', () => ({
  stageAll: vi.fn(),
  commit: vi.fn().mockResolvedValue('abc123def456'),
  getStatus: vi.fn().mockResolvedValue({ behind: 0 }),
  push: vi.fn(),
  hasRemote: vi.fn().mockResolvedValue(false),
  fetch: vi.fn(),
  pull: vi.fn(),
}));

vi.mock('../../src/lib/files.js', () => ({
  copyFileOrDir: copyFileOrDirMock,
  getFileChecksum: getFileChecksumMock,
  deleteFileOrDir: deleteFileOrDirMock,
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
  trackFilesWithProgress: vi.fn().mockResolvedValue({
    succeeded: 0,
    failed: 0,
    errors: [],
    sensitiveFiles: [],
  }),
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  scanForSecrets: vi.fn().mockResolvedValue({ totalSecrets: 0, results: [] }),
  isSecretScanningEnabled: vi.fn().mockResolvedValue(false),
  shouldBlockOnSecrets: vi.fn().mockResolvedValue(true),
  processSecretsForRedaction: vi.fn(),
  redactFile: vi.fn(),
}));

vi.mock('../../src/commands/secrets.js', () => ({ displayScanResults: vi.fn() }));
vi.mock('../../src/lib/audit.js', () => ({ logForceSecretBypass: vi.fn() }));
vi.mock('../../src/lib/remoteChecks.js', () => ({ checkLocalMode: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ remote: { mode: 'github' } }),
}));
vi.mock('../../src/lib/providers/index.js', () => ({ assertRemoteAvailable: vi.fn() }));

describe('sync change-detection perf (W4-B)', () => {
  const TRACKED = {
    zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', checksum: 'old' },
    gitconfig: { source: '~/.gitconfig', destination: 'files/git/gitconfig', checksum: 'old' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadManifestMock.mockResolvedValue({ files: {} });
    loadTuckignoreMock.mockResolvedValue(new Set());
    getAllTrackedFilesMock.mockResolvedValue(TRACKED);
    buildSourceIndexMock.mockImplementation(async () => {
      const m = new Map<string, { id: string; file: unknown }>();
      for (const [id, file] of Object.entries(TRACKED)) m.set(file.source, { id, file });
      return m;
    });
    pathExistsMock.mockResolvedValue(true);
    isIgnoredMock.mockResolvedValue(false);
    // Every tracked file is modified (checksum 'old' -> 'new').
    getFileChecksumMock.mockResolvedValue('new');
    resolveLiveTargetMock.mockImplementation(async (file: { source: string }) =>
      file.source.replace(/^~\//, '/test-home/')
    );
  });

  it('updates the manifest once per modified file (id carried, no linear find drift)', async () => {
    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand('sync: multi', {
      noCommit: true,
      noHooks: true,
      scan: false,
      pull: false,
    } as never);

    // Two modified files → two copies, two manifest updates with the CORRECT ids.
    expect(copyFileOrDirMock).toHaveBeenCalledTimes(2);
    expect(updateFileInManifestMock).toHaveBeenCalledTimes(2);

    const updatedIds = updateFileInManifestMock.mock.calls.map((c) => c[1]).sort();
    expect(updatedIds).toEqual(['gitconfig', 'zshrc']);
  });

  it('does not reload the tracked-files map O(changes) times', async () => {
    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand('sync: multi', {
      noCommit: true,
      noHooks: true,
      scan: false,
      pull: false,
    } as never);

    // With the old code this grew with the number of changes (one reload per
    // change in syncFiles, plus another inside each branch). After the refactor
    // the map is loaded a small constant number of times, independent of the
    // 2 changes processed.
    expect(getAllTrackedFilesMock.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
