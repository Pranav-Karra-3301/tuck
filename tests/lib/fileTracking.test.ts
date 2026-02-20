import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { trackFilesWithProgress } from '../../src/lib/fileTracking.js';
import { clearManifestCache, getTrackedFileBySource, loadManifest } from '../../src/lib/manifest.js';
import { initTestTuck, createTestDotfile, TEST_TUCK_DIR } from '../utils/testHelpers.js';

describe('fileTracking symlink strategy', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    vi.restoreAllMocks();
  });

  it('stores a real file in repo and replaces source with symlink to repo file', async () => {
    await initTestTuck();
    const sourcePath = createTestDotfile('.zshrc', 'export TRACKING_TEST=1');

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

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.zshrc');
    expect(tracked).not.toBeNull();

    const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
    expect(vol.lstatSync(repoPath).isSymbolicLink()).toBe(false);
    expect(vol.readFileSync(repoPath, 'utf-8')).toBe('export TRACKING_TEST=1');

    expect(vol.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(vol.readlinkSync(sourcePath)).toBe(repoPath);

    vol.writeFileSync(sourcePath, 'export TRACKING_TEST=2');
    expect(vol.readFileSync(repoPath, 'utf-8')).toBe('export TRACKING_TEST=2');

    logSpy.mockRestore();
  });

  it('avoids destination collisions for same basenames in different directories', async () => {
    await initTestTuck();
    createTestDotfile('.aws/config', 'region = us-east-1');
    createTestDotfile('.kube/config', 'apiVersion: v1');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress(
      [
        { path: '~/.aws/config', category: 'misc' },
        { path: '~/.kube/config', category: 'misc' },
      ],
      TEST_TUCK_DIR,
      {
        strategy: 'copy',
        showCategory: false,
        delayBetween: 0,
      }
    );

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    const aws = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.aws/config');
    const kube = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.kube/config');
    expect(aws).not.toBeNull();
    expect(kube).not.toBeNull();
    expect(aws!.file.destination).toBe('files/misc/.aws/config');
    expect(kube!.file.destination).toBe('files/misc/.kube/config');

    const manifest = await loadManifest(TEST_TUCK_DIR);
    const destinations = Object.values(manifest.files).map((file) => file.destination);
    expect(new Set(destinations).size).toBe(destinations.length);

    logSpy.mockRestore();
  });

  it('supports custom destination names while preserving source subdirectories', async () => {
    await initTestTuck();
    createTestDotfile('.aws/config', 'region = us-east-1');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await trackFilesWithProgress(
      [{ path: '~/.aws/config', category: 'misc', name: 'work-config' }],
      TEST_TUCK_DIR,
      {
        strategy: 'copy',
        showCategory: false,
        delayBetween: 0,
      }
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const aws = await getTrackedFileBySource(TEST_TUCK_DIR, '~/.aws/config');
    expect(aws).not.toBeNull();
    expect(aws!.file.destination).toBe('files/misc/.aws/work-config');

    logSpy.mockRestore();
  });
});
