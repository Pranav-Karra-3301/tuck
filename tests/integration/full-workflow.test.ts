import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../utils/testHelpers.js';
import { initTestTuck, createTestDotfile } from '../utils/testHelpers.js';
import { loadManifest, getTrackedFileBySource, clearManifestCache } from '../../src/lib/manifest.js';
import { getFileChecksum } from '../../src/lib/files.js';
import { addFilesFromPaths } from '../../src/commands/add.js';
import { runSyncCommand } from '../../src/commands/sync.js';

vi.mock('simple-git', () => {
  const mockGit = {
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
    status: vi.fn().mockResolvedValue({
      current: 'main',
      tracking: null,
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      not_added: [],
      deleted: [],
      isClean: () => true,
    }),
    getRemotes: vi.fn().mockResolvedValue([]),
    push: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    revparse: vi.fn().mockResolvedValue('main'),
    raw: vi.fn().mockResolvedValue('main'),
    branch: vi.fn().mockResolvedValue(undefined),
  };

  return {
    default: vi.fn(() => mockGit),
    simpleGit: vi.fn(() => mockGit),
  };
});

describe('Full Workflow Integration', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    clearManifestCache();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  it('tracks a file with add and persists it in manifest', async () => {
    await initTestTuck();
    createTestDotfile('.zshrc', 'export PATH=$PATH:/usr/local/bin');

    const added = await addFilesFromPaths(['~/.zshrc'], { force: true });
    const manifest = await loadManifest(TEST_TUCK_DIR);
    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');

    expect(added).toBe(1);
    expect(Object.keys(manifest.files)).toHaveLength(1);
    expect(tracked).not.toBeNull();
    expect(tracked?.file.destination).toContain('files/shell');
  });

  it('detects source changes and syncs updated content into repository copy', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.zshrc', 'export ORIGINAL=1');

    await addFilesFromPaths(['~/.zshrc'], { force: true });

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
    expect(tracked).not.toBeNull();

    const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
    const beforeChecksum = await getFileChecksum(repoPath);

    vol.writeFileSync(sourcePath, 'export ORIGINAL=2');

    await runSyncCommand('sync: update zshrc', {
      noCommit: true,
      noHooks: true,
      pull: false,
      push: false,
      force: true,
    });

    const afterChecksum = await getFileChecksum(repoPath);
    expect(afterChecksum).not.toBe(beforeChecksum);
    expect(vol.readFileSync(repoPath, 'utf-8')).toContain('ORIGINAL=2');
  });

  it('tracks with symlink strategy and syncs without same-file copy errors', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.zshrc', 'export SYMLINK_MODE=1');

    await addFilesFromPaths(['~/.zshrc'], { force: true, symlink: true });

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
    expect(tracked).not.toBeNull();

    const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
    expect(vol.lstatSync(sourcePath).isSymbolicLink()).toBe(true);

    vol.writeFileSync(sourcePath, 'export SYMLINK_MODE=2');

    await expect(
      runSyncCommand('sync: symlink update', {
        noCommit: true,
        noHooks: true,
        pull: false,
        push: false,
        force: true,
      })
    ).resolves.toBeUndefined();

    const updatedTracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
    expect(updatedTracked).not.toBeNull();
    expect(updatedTracked!.file.checksum).toBe(await getFileChecksum(repoPath));
    expect(vol.readFileSync(repoPath, 'utf-8')).toContain('SYMLINK_MODE=2');
  });

  it('removes deleted tracked files from manifest on sync', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.gitconfig', '[user]\n  name = Test User');

    await addFilesFromPaths(['~/.gitconfig'], { force: true });
    expect(await getTrackedFileBySource(TEST_TUCK_DIR, '~/.gitconfig')).not.toBeNull();

    vol.unlinkSync(sourcePath);

    await runSyncCommand('sync: remove deleted gitconfig', {
      noCommit: true,
      noHooks: true,
      pull: false,
      push: false,
      force: true,
    });

    expect(await getTrackedFileBySource(TEST_TUCK_DIR, '~/.gitconfig')).toBeNull();
  });
});
