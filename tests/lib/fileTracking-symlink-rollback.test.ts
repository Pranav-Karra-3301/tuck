import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { initTestTuck, createTestDotfile, TEST_TUCK_DIR } from '../utils/testHelpers.js';

// We need to control createSymlink so we can simulate it failing AFTER it has
// already handled (removed) the user's original source file. Everything else in
// files.js keeps its real, memfs-backed behavior.
vi.mock('../../src/lib/files.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/files.js')>('../../src/lib/files.js');
  return {
    ...actual,
    createSymlink: vi.fn(),
  };
});

import { createSymlink, deleteFileOrDir } from '../../src/lib/files.js';
import { trackFilesWithProgress } from '../../src/lib/fileTracking.js';
import { getTrackedFileBySource } from '../../src/lib/manifest.js';

describe('fileTracking symlink rollback safety', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('preserves the original file and surfaces the error when createSymlink fails after source handling', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.zshrc', 'export ORIGINAL_CONTENT=1');

    // Simulate the real createSymlink overwrite window: it removes the original
    // source as part of "source handling", then blows up before the link is in
    // place. A naive implementation would leave the user with NO file.
    vi.mocked(createSymlink).mockImplementation(async (_target, linkPath) => {
      // Source handling: remove the original (this is what overwrite:true does
      // inside the real createSymlink before symlink() is attempted).
      await deleteFileOrDir(linkPath);
      throw new Error('symlink failed: EPERM');
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress(
      [{ path: '~/.zshrc', category: 'shell' }],
      TEST_TUCK_DIR,
      {
        strategy: 'symlink',
        showCategory: false,
        delayBetween: 0,
      }
    );

    logSpy.mockRestore();

    // The operation must be reported as failed (loud error surfaced), never a
    // silent success.
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.errors).toHaveLength(1);
    // The underlying failure must be surfaced, not swallowed.
    expect(result.errors[0].error).toBeInstanceOf(Error);
    expect(result.errors[0].error.message.length).toBeGreaterThan(0);

    // CRITICAL: the user's original file must still exist with its original
    // content — restored from the durable repo copy.
    expect(vol.existsSync(sourcePath)).toBe(true);
    expect(vol.readFileSync(sourcePath, 'utf-8')).toBe('export ORIGINAL_CONTENT=1');

    // The file must NOT have been added to the manifest since tracking failed.
    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
    expect(tracked).toBeNull();
  });

  it('surfaces a combined error when both symlink AND restore fail (never silent data loss)', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.bashrc', 'export KEEP_ME=1');
    const repoCopyPath = join(TEST_TUCK_DIR, 'files', 'shell', '.bashrc');

    vi.mocked(createSymlink).mockImplementation(async (_target, linkPath) => {
      await deleteFileOrDir(linkPath);
      // Destroy the durable repo copy too, so restore-from-repo is impossible.
      await deleteFileOrDir(repoCopyPath);
      throw new Error('symlink failed: EPERM');
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress(
      [{ path: '~/.bashrc', category: 'shell' }],
      TEST_TUCK_DIR,
      {
        strategy: 'symlink',
        showCategory: false,
        delayBetween: 0,
      }
    );

    logSpy.mockRestore();

    // Must be reported as a failure with a real error message — never swallowed.
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);

    // The restore failure must be SURFACED in the error, not swallowed by a
    // `.catch(() => undefined)`. A user whose original is unrecoverable must be
    // told loudly that the restore also failed — otherwise they think the only
    // problem was a benign symlink hiccup while their file is actually gone.
    const msg = result.errors[0].error.message.toLowerCase();
    expect(msg).toMatch(/restor/);

    // We deliberately destroyed both copies in the test harness; the point is
    // that the failure is LOUD, not that the impossible-to-recover file is
    // magically restored.
    expect(vol.existsSync(sourcePath)).toBe(false);
  });
});
