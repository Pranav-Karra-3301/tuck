/**
 * Regression tests for BATCH W4-E (files.ts polish):
 *
 *  1. directory-tree-stats — getDirectoryTreeStats walks the tree ONCE and
 *     returns both the (identical) file list and a correct totalSize, so callers
 *     that need size do not pay for a second walk. The file list and ordering
 *     must be byte-for-byte identical to getDirectoryFiles, and copyFileOrDir's
 *     reported fileCount/totalSize must be unchanged.
 *
 *  2. files-dir-copy-enospc — a no-overwrite copy onto an existing target dir
 *     must NOT silently merge, and a low-level error (ENOSPC) must surface its
 *     real error code instead of being masked by a generic PermissionError.
 *
 * fs/promises and fs-extra are mocked globally against memfs in setup.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  getDirectoryFiles,
  getDirectoryTreeStats,
  copyFileOrDir,
} from '../../src/lib/files.js';
import { TEST_HOME } from '../setup.js';

describe('files tree-stats + dir-copy (W4-E)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1) directory-tree-stats: single-walk helper, identical file list
  // ──────────────────────────────────────────────────────────────────────────
  describe('getDirectoryTreeStats', () => {
    it('returns a file list identical to getDirectoryFiles', async () => {
      const dir = join(TEST_HOME, 'tree');
      const sub = join(dir, 'sub');
      vol.mkdirSync(sub, { recursive: true });
      vol.writeFileSync(join(dir, 'c.txt'), 'ccc');
      vol.writeFileSync(join(dir, 'a.txt'), 'a');
      vol.writeFileSync(join(sub, 'nested.txt'), 'nested-content');

      const listOnly = await getDirectoryFiles(dir);
      const stats = await getDirectoryTreeStats(dir);

      // Exact same array (same entries, same sorted order).
      expect(stats.files).toEqual(listOnly);
    });

    it('skips the same ignored patterns as getDirectoryFiles', async () => {
      const dir = join(TEST_HOME, 'tree');
      vol.mkdirSync(dir, { recursive: true });
      vol.writeFileSync(join(dir, 'keep.txt'), 'keep');
      vol.writeFileSync(join(dir, '.DS_Store'), 'system');
      vol.mkdirSync(join(dir, 'node_modules'), { recursive: true });
      vol.writeFileSync(join(dir, 'node_modules', 'x.js'), 'dep');

      const stats = await getDirectoryTreeStats(dir);

      expect(stats.files).toEqual(await getDirectoryFiles(dir));
      expect(stats.files.some((f) => f.includes('.DS_Store'))).toBe(false);
      expect(stats.files.some((f) => f.includes('node_modules'))).toBe(false);
    });

    it('totalSize equals the sum of stat() sizes over the file list', async () => {
      const dir = join(TEST_HOME, 'tree');
      const sub = join(dir, 'sub');
      vol.mkdirSync(sub, { recursive: true });
      vol.writeFileSync(join(dir, 'a.txt'), 'aaaa'); // 4 bytes
      vol.writeFileSync(join(sub, 'b.txt'), 'bbbbbbb'); // 7 bytes

      const stats = await getDirectoryTreeStats(dir);

      // Independent reference: sum stat() sizes the old (double-walk) way.
      const { stat } = await import('fs/promises');
      const files = await getDirectoryFiles(dir);
      let reference = 0;
      for (const f of files) reference += (await stat(f)).size;

      expect(stats.totalSize).toBe(reference);
      expect(stats.totalSize).toBe(11);
    });

    it('returns empty list and zero size for an empty directory', async () => {
      const dir = join(TEST_HOME, 'empty');
      vol.mkdirSync(dir, { recursive: true });

      const stats = await getDirectoryTreeStats(dir);

      expect(stats.files).toEqual([]);
      expect(stats.totalSize).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1b) copyFileOrDir must report unchanged fileCount + totalSize for dirs
  // ──────────────────────────────────────────────────────────────────────────
  describe('copyFileOrDir directory stats are unchanged', () => {
    it('reports correct fileCount and totalSize after copying a dir', async () => {
      const src = join(TEST_HOME, 'src');
      const sub = join(src, 'nested');
      vol.mkdirSync(sub, { recursive: true });
      vol.writeFileSync(join(src, 'a.txt'), 'aaaa'); // 4
      vol.writeFileSync(join(sub, 'b.txt'), 'bbbbbbb'); // 7
      const dest = join(TEST_HOME, 'dest');

      const result = await copyFileOrDir(src, dest);

      expect(result.fileCount).toBe(2);
      expect(result.totalSize).toBe(11);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2) files-dir-copy-enospc
  // ──────────────────────────────────────────────────────────────────────────
  describe('no-overwrite directory copy onto an existing dir', () => {
    it('does NOT silently merge into an existing target dir', async () => {
      const src = join(TEST_HOME, 'src');
      vol.mkdirSync(src, { recursive: true });
      vol.writeFileSync(join(src, 'new.txt'), 'fresh');

      // Target dir already exists with a pre-existing, unrelated file.
      const dest = join(TEST_HOME, 'dest');
      vol.mkdirSync(dest, { recursive: true });
      vol.writeFileSync(join(dest, 'existing.txt'), 'original');

      // With overwrite:false this must fail clearly rather than merging src
      // into dest.
      await expect(copyFileOrDir(src, dest, { overwrite: false })).rejects.toThrow();

      // And it must NOT have planted src/new.txt into the existing dir.
      expect(vol.existsSync(join(dest, 'new.txt'))).toBe(false);
      // The pre-existing file must be untouched.
      expect(vol.readFileSync(join(dest, 'existing.txt'), 'utf-8')).toBe('original');
    });
  });

  describe('low-level copy errors surface their real code', () => {
    it('preserves an ENOSPC code instead of masking it as a generic error', async () => {
      const src = join(TEST_HOME, 'source.txt');
      const dest = join(TEST_HOME, 'dest.txt');
      vol.writeFileSync(src, 'data');

      const fsPromises = await import('fs/promises');
      const enospc = Object.assign(new Error('no space left on device'), {
        code: 'ENOSPC',
        errno: -28,
      });
      vi.spyOn(fsPromises, 'copyFile').mockRejectedValueOnce(enospc as never);

      await expect(copyFileOrDir(src, dest)).rejects.toMatchObject({ code: 'ENOSPC' });
    });
  });
});
