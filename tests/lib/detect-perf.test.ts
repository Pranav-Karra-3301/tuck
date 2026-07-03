/**
 * Regression tests for the W4-B scan/sync performance refactor of detect.ts.
 *
 * The probe per pattern was 3 serial filesystem calls (pathExists/access +
 * stat for isDirectory + stat for size). The refactor collapses these to ONE
 * stat per existing path (still following symlinks, so detection results are
 * byte-identical) and runs the per-pattern probes concurrently.
 *
 * These tests pin the OBSERVABLE behavior that must not change:
 *   - which patterns are detected,
 *   - the shape of each DetectedFile (path/name/category/description/
 *     isDirectory/size/sensitive/exclude),
 *   - symlink-following semantics (a symlink to a directory reports
 *     isDirectory: true, just like the old stat()-based code).
 * Plus the perf property: at most one stat per existing path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import * as fsp from 'fs/promises';
import { detectDotfiles } from '../../src/lib/detect.js';
import { resetPatternsCache } from '../../src/lib/patternsRegistry.js';
import { TEST_HOME } from '../setup.js';

describe('detect.ts perf refactor (W4-B)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    resetPatternsCache();
  });

  afterEach(() => {
    vol.reset();
    resetPatternsCache();
    vi.restoreAllMocks();
  });

  it('detects a plain file with the same DetectedFile shape', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'export FOO=1\n');

    const detected = await detectDotfiles();
    const zshrc = detected.find((f) => f.path === '~/.zshrc');

    expect(zshrc).toBeDefined();
    expect(zshrc!.name).toBe('.zshrc');
    expect(zshrc!.category).toBe('shell');
    expect(zshrc!.isDirectory).toBe(false);
    // size must be populated from a real stat, not undefined
    expect(typeof zshrc!.size).toBe('number');
    expect(zshrc!.size).toBe('export FOO=1\n'.length);
  });

  it('detects a directory pattern as isDirectory: true', async () => {
    vol.mkdirSync('/test-home/.config/nvim', { recursive: true });

    const detected = await detectDotfiles();
    const nvim = detected.find((f) => f.path === '~/.config/nvim');

    expect(nvim).toBeDefined();
    expect(nvim!.isDirectory).toBe(true);
  });

  it('follows symlinks like the old stat()-based probe (symlink to dir => isDirectory true)', async () => {
    // Real target directory, then a tracked dotfile path symlinked to it.
    vol.mkdirSync('/test-home/real-nvim', { recursive: true });
    vol.mkdirSync('/test-home/.config', { recursive: true });
    vol.symlinkSync('/test-home/real-nvim', '/test-home/.config/nvim');

    const detected = await detectDotfiles();
    const nvim = detected.find((f) => f.path === '~/.config/nvim');

    expect(nvim).toBeDefined();
    // stat() follows the link → directory. lstat() would wrongly report false.
    expect(nvim!.isDirectory).toBe(true);
  });

  it('does not stat an existing path more than once (no redundant syscalls)', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'x\n');
    vol.writeFileSync('/test-home/.gitconfig', '[user]\n');

    const statSpy = vi.spyOn(fsp, 'stat');

    await detectDotfiles();

    const perPath = new Map<string, number>();
    for (const call of statSpy.mock.calls) {
      const p = String(call[0]);
      perPath.set(p, (perPath.get(p) ?? 0) + 1);
    }

    // The old code stat()'d each existing path twice (isDirectory + getSize),
    // plus an access() existence check. After the refactor each path is
    // stat()'d at most once.
    for (const [p, count] of perPath) {
      expect(count, `stat called ${count}x for ${p}`).toBeLessThanOrEqual(1);
    }
  });
});
