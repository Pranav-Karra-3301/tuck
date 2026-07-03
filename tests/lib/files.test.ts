import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { copyFileOrDir, matchesExcludePattern, formatBytes } from '../../src/lib/files.js';
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
  });
});
