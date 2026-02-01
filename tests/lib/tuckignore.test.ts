/**
 * Tuckignore module unit tests
 *
 * Tests for .tuckignore file handling functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  getTuckignorePath,
  loadTuckignore,
  saveTuckignore,
  addToTuckignore,
  isIgnored,
  removeFromTuckignore,
  getIgnoredPaths,
} from '../../src/lib/tuckignore.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

describe('tuckignore', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // getTuckignorePath Tests
  // ============================================================================

  describe('getTuckignorePath', () => {
    it('should return path to .tuckignore in tuck directory', () => {
      const path = getTuckignorePath(TEST_TUCK_DIR);
      expect(path).toBe(join(TEST_TUCK_DIR, '.tuckignore'));
    });
  });

  // ============================================================================
  // loadTuckignore Tests
  // ============================================================================

  describe('loadTuckignore', () => {
    it('should return empty set when .tuckignore does not exist', async () => {
      const ignored = await loadTuckignore(TEST_TUCK_DIR);
      expect(ignored.size).toBe(0);
    });

    it('should parse paths from .tuckignore file', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.secret-file\n~/.docker/config.json\n');

      const ignored = await loadTuckignore(TEST_TUCK_DIR);

      expect(ignored.size).toBe(2);
      expect(ignored.has('~/.secret-file')).toBe(true);
      expect(ignored.has('~/.docker/config.json')).toBe(true);
    });

    it('should skip comment lines', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '# This is a comment\n~/.secret-file\n# Another comment\n');

      const ignored = await loadTuckignore(TEST_TUCK_DIR);

      expect(ignored.size).toBe(1);
      expect(ignored.has('~/.secret-file')).toBe(true);
    });

    it('should skip empty lines', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '\n~/.secret-file\n\n~/.docker\n\n');

      const ignored = await loadTuckignore(TEST_TUCK_DIR);

      expect(ignored.size).toBe(2);
    });

    it('should trim whitespace from paths', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '  ~/.secret-file  \n');

      const ignored = await loadTuckignore(TEST_TUCK_DIR);

      expect(ignored.has('~/.secret-file')).toBe(true);
    });
  });

  // ============================================================================
  // saveTuckignore Tests
  // ============================================================================

  describe('saveTuckignore', () => {
    it('should save paths to .tuckignore file', async () => {
      await saveTuckignore(TEST_TUCK_DIR, ['~/.secret-file', '~/.docker/config.json']);

      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      const content = vol.readFileSync(ignorePath, 'utf-8') as string;

      expect(content).toContain('~/.docker/config.json');
      expect(content).toContain('~/.secret-file');
    });

    it('should sort paths alphabetically', async () => {
      await saveTuckignore(TEST_TUCK_DIR, ['~/.zshrc', '~/.bashrc', '~/.config']);

      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      const content = vol.readFileSync(ignorePath, 'utf-8') as string;
      const lines = content.split('\n').filter((l) => l && !l.startsWith('#'));

      expect(lines[0]).toBe('~/.bashrc');
      expect(lines[1]).toBe('~/.config');
      expect(lines[2]).toBe('~/.zshrc');
    });

    it('should include header comments', async () => {
      await saveTuckignore(TEST_TUCK_DIR, ['~/.secret']);

      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      const content = vol.readFileSync(ignorePath, 'utf-8') as string;

      expect(content).toContain('# .tuckignore');
    });
  });

  // ============================================================================
  // addToTuckignore Tests
  // ============================================================================

  describe('addToTuckignore', () => {
    it('should create .tuckignore if it does not exist', async () => {
      await addToTuckignore(TEST_TUCK_DIR, '~/.secret');

      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      expect(vol.existsSync(ignorePath)).toBe(true);
    });

    it('should append path to existing .tuckignore', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.existing\n');

      await addToTuckignore(TEST_TUCK_DIR, '~/.new-file');

      const content = vol.readFileSync(ignorePath, 'utf-8') as string;
      expect(content).toContain('~/.new-file');
      expect(content).toContain('~/.existing');
    });

    it('should not add duplicate paths', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.already-ignored\n');

      await addToTuckignore(TEST_TUCK_DIR, '~/.already-ignored');

      const content = vol.readFileSync(ignorePath, 'utf-8') as string;
      const matches = content.match(/~\/\.already-ignored/g) || [];
      expect(matches.length).toBe(1);
    });

    it('should normalize paths with ~/', async () => {
      // Create the file to ensure path expansion works
      vol.writeFileSync(join(TEST_HOME, '.secret'), 'content');

      await addToTuckignore(TEST_TUCK_DIR, join(TEST_HOME, '.secret'));

      const ignored = await loadTuckignore(TEST_TUCK_DIR);
      expect(ignored.has('~/.secret')).toBe(true);
    });
  });

  // ============================================================================
  // isIgnored Tests
  // ============================================================================

  describe('isIgnored', () => {
    it('should return true for ignored paths', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.secret\n');

      const result = await isIgnored(TEST_TUCK_DIR, '~/.secret');
      expect(result).toBe(true);
    });

    it('should return false for non-ignored paths', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.secret\n');

      const result = await isIgnored(TEST_TUCK_DIR, '~/.zshrc');
      expect(result).toBe(false);
    });

    it('should return false when no .tuckignore exists', async () => {
      const result = await isIgnored(TEST_TUCK_DIR, '~/.anything');
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // removeFromTuckignore Tests
  // ============================================================================

  describe('removeFromTuckignore', () => {
    it('should remove path from .tuckignore', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.to-remove\n~/.to-keep\n');

      await removeFromTuckignore(TEST_TUCK_DIR, '~/.to-remove');

      const ignored = await loadTuckignore(TEST_TUCK_DIR);
      expect(ignored.has('~/.to-remove')).toBe(false);
      expect(ignored.has('~/.to-keep')).toBe(true);
    });

    it('should do nothing when path is not in file', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.existing\n');

      await removeFromTuckignore(TEST_TUCK_DIR, '~/.not-in-file');

      const ignored = await loadTuckignore(TEST_TUCK_DIR);
      expect(ignored.size).toBe(1);
    });

    it('should do nothing when .tuckignore does not exist', async () => {
      await expect(
        removeFromTuckignore(TEST_TUCK_DIR, '~/.anything')
      ).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // getIgnoredPaths Tests
  // ============================================================================

  describe('getIgnoredPaths', () => {
    it('should return sorted array of ignored paths', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      vol.writeFileSync(ignorePath, '~/.zshrc\n~/.bashrc\n~/.config\n');

      const paths = await getIgnoredPaths(TEST_TUCK_DIR);

      expect(paths).toEqual(['~/.bashrc', '~/.config', '~/.zshrc']);
    });

    it('should return empty array when no .tuckignore exists', async () => {
      const paths = await getIgnoredPaths(TEST_TUCK_DIR);
      expect(paths).toEqual([]);
    });
  });
});
