import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  copyFileOrDir,
  matchesExcludePattern,
  formatBytes,
  getFileSizeRecursive,
  getDirectoryTreeStats,
} from '../../src/lib/files.js';
import { TEST_HOME } from '../setup.js';

describe('files', () => {
  describe('matchesExcludePattern', () => {
    it('matches a bare directory name at any depth', () => {
      expect(matchesExcludePattern('logs', ['logs'])).toBe(true);
      expect(matchesExcludePattern('a/b/logs', ['logs'])).toBe(true);
      expect(matchesExcludePattern('logfile', ['logs'])).toBe(false);
    });

    it('matches a nested globstar file pattern but not the containing dir', () => {
      const pats = ['projects/**/*.jsonl'];
      expect(matchesExcludePattern('projects/foo/bar.jsonl', pats)).toBe(true);
      expect(matchesExcludePattern('projects/bar.jsonl', pats)).toBe(true);
      // The directory itself must NOT match, so its non-jsonl contents survive.
      expect(matchesExcludePattern('projects/foo', pats)).toBe(false);
      expect(matchesExcludePattern('projects/foo/keep.md', pats)).toBe(false);
    });

    it('matches a leading globstar across any depth', () => {
      expect(matchesExcludePattern('a/b/c.db', ['**/*.db'])).toBe(true);
      expect(matchesExcludePattern('c.db', ['**/*.db'])).toBe(true);
      expect(matchesExcludePattern('c.dbx', ['**/*.db'])).toBe(false);
    });

    it('never excludes the copy root (empty relative path)', () => {
      expect(matchesExcludePattern('', ['logs', '**/*'])).toBe(false);
    });
  });

  describe('copyFileOrDir with exclude', () => {
    beforeEach(() => {
      vol.reset();
      vol.mkdirSync(TEST_HOME, { recursive: true });
    });

    it('omits excluded subpaths when copying a directory into the repo', async () => {
      const src = join(TEST_HOME, '.claude');
      vol.mkdirSync(join(src, 'projects/foo'), { recursive: true });
      vol.mkdirSync(join(src, 'logs'), { recursive: true });
      vol.writeFileSync(join(src, 'settings.json'), '{}');
      vol.writeFileSync(join(src, 'projects/foo/transcript.jsonl'), 'secret');
      vol.writeFileSync(join(src, 'projects/foo/keep.md'), 'keep');
      vol.writeFileSync(join(src, 'logs/app.log'), 'noise');

      const dest = join(TEST_HOME, '.tuck/files/claude');
      await copyFileOrDir(src, dest, {
        overwrite: true,
        exclude: ['projects/**/*.jsonl', 'logs', 'cache'],
      });

      // Kept content:
      expect(vol.existsSync(join(dest, 'settings.json'))).toBe(true);
      expect(vol.existsSync(join(dest, 'projects/foo/keep.md'))).toBe(true);
      // Excluded content:
      expect(vol.existsSync(join(dest, 'projects/foo/transcript.jsonl'))).toBe(false);
      expect(vol.existsSync(join(dest, 'logs'))).toBe(false);
      expect(vol.existsSync(join(dest, 'logs/app.log'))).toBe(false);
    });

    it('skips the same names as the checksum walk (e.g. .gitignore, .npmrc) when copying a directory', async () => {
      // Regression: copyFileOrDir's skip list diverged from
      // DIRECTORY_SKIP_PATTERNS, so a nested .gitignore/.npmrc was copied into
      // the repo (silently excluding sibling tracked files from commits) while
      // the checksum walk ignored it (edits never registered as drift).
      const src = join(TEST_HOME, '.config/nvim');
      vol.mkdirSync(src, { recursive: true });
      vol.writeFileSync(join(src, 'init.lua'), 'vim.opt.number = true');
      vol.writeFileSync(join(src, '.gitignore'), 'plugin/\n*.local');
      vol.writeFileSync(join(src, '.npmrc'), 'registry=example');
      vol.writeFileSync(join(src, 'cache.swp'), 'junk');

      const dest = join(TEST_HOME, '.tuck/files/config/nvim');
      await copyFileOrDir(src, dest, { overwrite: true });

      expect(vol.existsSync(join(dest, 'init.lua'))).toBe(true);
      // These must NOT be copied so the repo tree matches the checksummed tree.
      expect(vol.existsSync(join(dest, '.gitignore'))).toBe(false);
      expect(vol.existsSync(join(dest, '.npmrc'))).toBe(false);
      expect(vol.existsSync(join(dest, 'cache.swp'))).toBe(false);
    });
  });

  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(2621440)).toBe('2.5 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1 GB');
    });

    it('clamps the unit to GB for terabyte-scale values instead of an undefined unit', () => {
      // Regression: the old ad-hoc copies indexed sizes[floor(log1024(bytes))]
      // with no clamp, so any value >= 1 TB rendered the out-of-bounds unit as
      // "1.1 undefined". formatBytes clamps the index to the sizes array.
      expect(formatBytes(1024 ** 4)).toBe('1024 GB');
      const petabyte = formatBytes(5 * 1024 ** 5);
      expect(petabyte).not.toContain('undefined');
      expect(petabyte).toMatch(/ GB$/);
    });

    it('normalizes negative and non-finite inputs to 0 B', () => {
      expect(formatBytes(-1)).toBe('0 B');
      expect(formatBytes(Number.NaN)).toBe('0 B');
      expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
    });

    it('honors the decimals parameter (default 1)', () => {
      // 1500 / 1024 = 1.4648...
      expect(formatBytes(1500)).toBe('1.5 KB');
      expect(formatBytes(1500, 2)).toBe('1.46 KB');
      expect(formatBytes(1500, 0)).toBe('1 KB');
    });
  });

  describe('getFileSizeRecursive', () => {
    beforeEach(() => {
      vol.reset();
      vol.mkdirSync(TEST_HOME, { recursive: true });
    });

    it('returns 0 for a path that does not exist', async () => {
      expect(await getFileSizeRecursive(join(TEST_HOME, 'nope'))).toBe(0);
    });

    it('returns the byte size of a single file', async () => {
      const f = join(TEST_HOME, '.zshrc');
      vol.writeFileSync(f, 'hello'); // 5 bytes
      expect(await getFileSizeRecursive(f)).toBe(5);
    });

    it('sums file sizes recursively and matches getDirectoryTreeStats (single walk)', async () => {
      const dir = join(TEST_HOME, '.config');
      vol.mkdirSync(join(dir, 'nested'), { recursive: true });
      vol.writeFileSync(join(dir, 'a.txt'), 'aaa'); // 3
      vol.writeFileSync(join(dir, 'nested', 'b.txt'), 'bbbb'); // 4

      const total = await getFileSizeRecursive(dir);
      expect(total).toBe(7);
      // The recursive size must equal the total the shared single-walk helper
      // reports — they must never drift.
      const { totalSize } = await getDirectoryTreeStats(dir);
      expect(total).toBe(totalSize);
    });

    it('excludes the same skipped names as the directory walk (node_modules, .git)', async () => {
      const dir = join(TEST_HOME, '.proj');
      vol.mkdirSync(join(dir, 'node_modules'), { recursive: true });
      vol.mkdirSync(join(dir, '.git'), { recursive: true });
      vol.writeFileSync(join(dir, 'real.txt'), 'xy'); // 2 bytes, counted
      vol.writeFileSync(join(dir, 'node_modules', 'big.js'), 'x'.repeat(1000));
      vol.writeFileSync(join(dir, '.git', 'index'), 'x'.repeat(1000));

      // Only the real tracked file counts; skipped trees are excluded.
      expect(await getFileSizeRecursive(dir)).toBe(2);
    });
  });
});
