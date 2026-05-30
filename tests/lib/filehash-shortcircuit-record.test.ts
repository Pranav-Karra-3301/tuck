/**
 * Record-side tests for the file-hash short-circuit.
 *
 * The short-circuit can only fire if tracking a single file ALSO records the
 * live source's (mtimeMs, size) next to its checksum. These tests verify that
 * `trackFilesWithProgress` writes `sourceMtimeMs`/`sourceSize` for a single
 * regular file (matching the live stat) and leaves them UNDEFINED for a
 * directory (where a stat short-circuit would be unsound).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { statSync } from 'fs';
import { trackFilesWithProgress } from '../../src/lib/fileTracking.js';
import { clearManifestCache, getTrackedFileBySource } from '../../src/lib/manifest.js';
import { initTestTuck, createTestDotfile, TEST_TUCK_DIR } from '../utils/testHelpers.js';

describe('file-hash short-circuit record side (tracking)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    vi.restoreAllMocks();
  });

  it('records sourceMtimeMs and sourceSize matching the live single file', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.zshrc', 'export A=1\n');
    const live = statSync(sourcePath);

    const result = await trackFilesWithProgress(
      [{ path: '~/.zshrc', category: 'shell' }],
      TEST_TUCK_DIR,
      { showCategory: false, delayBetween: 0 }
    );
    expect(result.succeeded).toBe(1);

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
    expect(tracked).not.toBeNull();
    expect(tracked!.file.sourceSize).toBe(live.size);
    expect(tracked!.file.sourceMtimeMs).toBe(live.mtimeMs);
  });

  it('does NOT record mtime/size for a tracked directory', async () => {
    await initTestTuck();
    createTestDotfile('a.conf', 'one\n', { subdir: '.config/app' });
    createTestDotfile('b.conf', 'two\n', { subdir: '.config/app' });

    const result = await trackFilesWithProgress(
      [{ path: '~/.config/app', category: 'config' }],
      TEST_TUCK_DIR,
      { showCategory: false, delayBetween: 0 }
    );
    expect(result.succeeded).toBe(1);

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.config/app');
    expect(tracked).not.toBeNull();
    expect(tracked!.file.sourceMtimeMs).toBeUndefined();
    expect(tracked!.file.sourceSize).toBeUndefined();
  });
});
