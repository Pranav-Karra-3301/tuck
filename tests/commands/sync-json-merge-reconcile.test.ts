/**
 * Non-interactive sync-time JSON reconcile (findings 2, 4, 6).
 *
 * The `--json` / `--yes` and `-m <msg>` sync paths must pull, capture the
 * pre-pull repo copy as the merge base, three-way merge every diverged
 * JSON-policy file, and — on an unresolvable conflict — persist the bases and
 * throw JsonMergeConflictsError (exit 3) BEFORE any commit/push, so a stale
 * local value can never be pushed over the remote's version.
 *
 * Uses the global memfs fs mock for real file content (live + repo copies) so
 * captureMergeBases / detectChanges / reconcileJsonMerges run their real logic;
 * git, manifest, snapshots, and secrets are mocked. jsonMergeSync (base
 * persistence) is REAL and writes to the memfs-backed state dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { JsonMergeConflictsError } from '../../src/errors.js';
import {
  loadPendingMergeBases,
  persistPendingMergeBases,
  clearPendingMergeBases,
} from '../../src/lib/jsonMergeSync.js';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const resolveLiveTargetMock = vi.fn();
const getFileChecksumMock = vi.fn();
const loadTuckignoreMock = vi.fn();

const stageAllMock = vi.fn();
const commitMock = vi.fn();
const getStatusMock = vi.fn();
const pushMock = vi.fn();
const hasRemoteMock = vi.fn();
const fetchMock = vi.fn();
const pullMock = vi.fn();
const abortRebaseMock = vi.fn();
const detectConflictsMock = vi.fn();

const createSnapshotMock = vi.fn();
const checkLocalModeMock = vi.fn();
const loadConfigMock = vi.fn();
const assertRemoteAvailableMock = vi.fn();
const copyFileOrDirMock = vi.fn();

const SOURCE = '~/.claude/settings.json';
const DEST_REL = 'files/agent/settings.json';
const TUCK_DIR = '/test-home/.tuck';
const DEST_PATH = join(TUCK_DIR, DEST_REL);
const LIVE_PATH = '/test-home/.claude/settings.json';

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
  colors: new Proxy({}, { get: () => (x: string) => x }),
}));

// paths.js is mocked so getTuckDir/expandPath/pathExists are deterministic.
// pathExists always-true lets the REAL captureMergeBases/reconcile read the
// memfs files we set up; realpath (from fs/promises, memfs) still resolves them.
// NOTE: vitest runs with mockReset:true, which strips `.mockResolvedValue()`
// overrides from factory mocks but PRESERVES implementations passed as
// `vi.fn(impl)`. So every factory default that must survive across tests is
// written as `vi.fn(impl)`, not `vi.fn().mockResolvedValue(...)`.
vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => TUCK_DIR),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  pathExists: vi.fn(async () => true),
  collapsePath: vi.fn((p: string) => p),
  isDirectory: vi.fn(async () => false),
  validateSafeSourcePath: vi.fn(),
  validateSafeManifestDestination: vi.fn(),
  validatePathWithinRoot: vi.fn(),
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
  updateFileInManifest: vi.fn(),
  removeFileFromManifest: vi.fn(),
  buildSourceIndex: vi.fn(),
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
  continueRebase: vi.fn(),
  applyResolution: vi.fn(),
}));

vi.mock('../../src/ui/merge.js', () => ({
  resolveConflictsInteractively: vi.fn(),
}));

vi.mock('../../src/lib/timemachine.js', () => ({
  createSnapshot: createSnapshotMock,
}));

vi.mock('../../src/lib/files.js', () => ({
  copyFileOrDir: copyFileOrDirMock,
  getFileChecksum: getFileChecksumMock,
  deleteFileOrDir: vi.fn(),
  checkFileSizeThreshold: vi.fn(async () => ({ warn: false, block: false, size: 10 })),
  formatFileSize: vi.fn((n: number) => `${n} B`),
  SIZE_BLOCK_THRESHOLD: 100 * 1024 * 1024,
}));

vi.mock('../../src/lib/tuckignore.js', () => ({
  addToTuckignore: vi.fn(),
  loadTuckignore: loadTuckignoreMock,
  isIgnoredInSet: vi.fn(() => false),
}));

vi.mock('../../src/lib/hooks.js', () => ({
  runPreSyncHook: vi.fn(),
  runPostSyncHook: vi.fn(),
}));

vi.mock('../../src/lib/detect.js', () => ({
  detectDotfiles: vi.fn(async () => []),
  DETECTION_CATEGORIES: {},
}));

vi.mock('../../src/lib/fileTracking.js', () => ({
  trackFilesWithProgress: vi.fn(async () => ({
    succeeded: 0,
    failed: 0,
    errors: [],
    sensitiveFiles: [],
  })),
}));

vi.mock('../../src/lib/trackPipeline.js', () => ({
  preparePathsForTracking: vi.fn(async () => []),
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  scanForSecrets: vi.fn(async () => ({ totalSecrets: 0, results: [] })),
  isSecretScanningEnabled: vi.fn(async () => false),
  shouldBlockOnSecrets: vi.fn(async () => true),
  processSecretsForRedaction: vi.fn(),
  redactFile: vi.fn(),
  getStoredValueMap: vi.fn(async () => new Map()),
  getRedactedChecksum: vi.fn(),
  addAllowlistEntryByFingerprint: vi.fn(),
  computeFingerprint: vi.fn(),
  getAllowlistPath: vi.fn(),
}));

vi.mock('../../src/commands/secrets.js', () => ({
  displayScanResults: vi.fn(),
}));

vi.mock('../../src/lib/audit.js', () => ({
  logForceSecretBypass: vi.fn(),
  logSecretAllowlisted: vi.fn(),
}));

vi.mock('../../src/lib/remoteChecks.js', () => ({
  checkLocalMode: checkLocalModeMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/providers/index.js', () => ({
  assertRemoteAvailable: assertRemoteAvailableMock,
}));

const trackedFile = (overrides: Record<string, unknown> = {}) => ({
  f1: {
    source: SOURCE,
    destination: DEST_REL,
    category: 'misc',
    strategy: 'copy',
    encrypted: false,
    template: false,
    checksum: 'stored-checksum',
    added: new Date().toISOString(),
    modified: new Date().toISOString(),
    bundle: 'default',
    ...overrides,
  },
});

const writeFiles = (base: string, live: string) => {
  vol.mkdirSync(join(TUCK_DIR, 'files', 'agent'), { recursive: true });
  vol.mkdirSync('/test-home/.claude', { recursive: true });
  // Repo copy = pre-pull base (captureMergeBases reads this before the pull).
  vol.writeFileSync(DEST_PATH, base);
  vol.writeFileSync(LIVE_PATH, live);
};

describe('non-interactive sync JSON reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadManifestMock.mockResolvedValue({ files: {} });
    loadTuckignoreMock.mockResolvedValue(new Set());
    getAllTrackedFilesMock.mockResolvedValue(trackedFile());
    resolveLiveTargetMock.mockResolvedValue(LIVE_PATH);
    checkLocalModeMock.mockResolvedValue(false);
    loadConfigMock.mockResolvedValue({ remote: { mode: 'github' } });
    assertRemoteAvailableMock.mockImplementation(() => {});
    createSnapshotMock.mockResolvedValue(undefined);
    abortRebaseMock.mockResolvedValue(undefined);
    commitMock.mockResolvedValue('abc123def456');
    hasRemoteMock.mockResolvedValue(true);
    fetchMock.mockResolvedValue(undefined);
    detectConflictsMock.mockResolvedValue([]);
    // The rebase pull "advances" the repo copy to the remote's version.
  });

  afterEach(async () => {
    await clearPendingMergeBases();
  });

  it('throws JsonMergeConflictsError (exit 3), persists bases, and never pushes on --json conflict', async () => {
    const base = JSON.stringify({ model: 'sonnet' }, null, 2) + '\n';
    const remote = JSON.stringify({ model: 'opus' }, null, 2) + '\n';
    const live = JSON.stringify({ model: 'haiku' }, null, 2) + '\n';
    writeFiles(base, live);

    getStatusMock.mockResolvedValue({ behind: 1, ahead: 0, hasChanges: true });
    // getFileChecksum ≠ stored ⇒ detectChanges flags the file modified.
    getFileChecksumMock.mockResolvedValue('live-checksum');
    // Pull advances the repo copy to the remote's version.
    pullMock.mockImplementation(async () => {
      vol.writeFileSync(DEST_PATH, remote);
    });

    const { runSyncCommand } = await import('../../src/commands/sync.js');

    let caught: unknown;
    try {
      await runSyncCommand(undefined, { json: true, scan: false, noHooks: true } as never);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(JsonMergeConflictsError);
    expect((caught as JsonMergeConflictsError).toJSON().exit_code).toBe(3);

    // Nothing was committed or pushed — the conflicted remote is untouched.
    expect(commitMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();

    // The base was persisted so the next sync can re-detect the conflict.
    const pending = await loadPendingMergeBases();
    expect(pending.get(SOURCE)).toBe(base);
  });

  it('throws on the -m message path too (forced non-interactive), persisting bases and not pushing', async () => {
    const base = JSON.stringify({ model: 'sonnet' }, null, 2) + '\n';
    const remote = JSON.stringify({ model: 'opus' }, null, 2) + '\n';
    const live = JSON.stringify({ model: 'haiku' }, null, 2) + '\n';
    writeFiles(base, live);

    getStatusMock.mockResolvedValue({ behind: 1, ahead: 0, hasChanges: true });
    getFileChecksumMock.mockResolvedValue('live-checksum');
    pullMock.mockImplementation(async () => {
      vol.writeFileSync(DEST_PATH, remote);
    });

    const { runSyncCommand } = await import('../../src/commands/sync.js');

    await expect(
      runSyncCommand('update', { message: 'update', scan: false, noHooks: true } as never)
    ).rejects.toBeInstanceOf(JsonMergeConflictsError);

    expect(commitMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    const pending = await loadPendingMergeBases();
    expect(pending.get(SOURCE)).toBe(base);
  });

  it('auto-applies a clean union to live+repo, pushes, and clears pending bases (--json)', async () => {
    const base = JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2) + '\n';
    const remote = JSON.stringify({ permissions: { allow: ['Read', 'WebFetch'] } }, null, 2) + '\n';
    const live = JSON.stringify({ permissions: { allow: ['Read', 'Bash(git:*)'] } }, null, 2) + '\n';
    writeFiles(base, live);

    getStatusMock.mockResolvedValue({ behind: 1, ahead: 0, hasChanges: true });
    getFileChecksumMock.mockResolvedValue('live-checksum');
    pullMock.mockImplementation(async () => {
      vol.writeFileSync(DEST_PATH, remote);
    });

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, scan: false, noHooks: true } as never);

    // The live file converged to the UNION of all three sides (no data loss).
    const mergedLive = JSON.parse(vol.readFileSync(LIVE_PATH, 'utf-8') as string) as {
      permissions: { allow: string[] };
    };
    expect(mergedLive.permissions.allow.sort()).toEqual(['Bash(git:*)', 'Read', 'WebFetch']);

    // A clean merge commits + pushes normally.
    expect(pushMock).toHaveBeenCalled();

    // The base was reconciled ⇒ pending bases cleared.
    const pending = await loadPendingMergeBases();
    expect(pending.size).toBe(0);
  });

  it('clears a stale persisted base when the file no longer diverges (--json)', async () => {
    // A base left over from a previous run; this run the file is unchanged.
    const oldBase = JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2) + '\n';
    await persistPendingMergeBases(new Map([[SOURCE, oldBase]]));

    writeFiles(oldBase, oldBase);
    // No pull (up to date) and no drift ⇒ file is not in changes.
    getStatusMock.mockResolvedValue({ behind: 0, ahead: 0, hasChanges: false });
    getFileChecksumMock.mockResolvedValue('stored-checksum'); // == stored ⇒ unchanged

    const { runSyncCommand } = await import('../../src/commands/sync.js');
    await runSyncCommand(undefined, { json: true, scan: false, noHooks: true } as never);

    // Stale base dropped so it can never resurface as a spurious conflict.
    const pending = await loadPendingMergeBases();
    expect(pending.size).toBe(0);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
