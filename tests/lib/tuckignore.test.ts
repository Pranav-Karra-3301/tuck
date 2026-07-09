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
  addToTuckignore,
  isIgnored,
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
      // Use forward slashes consistently for memfs and cross-platform compatibility
      const secretPath = `${TEST_HOME}/.secret`;
      vol.writeFileSync(secretPath, 'content');

      await addToTuckignore(TEST_TUCK_DIR, secretPath);

      const ignored = await loadTuckignore(TEST_TUCK_DIR);
      expect(ignored.has('~/.secret')).toBe(true);
    });

    it('should keep entries on separate lines when the existing file lacks a trailing newline', async () => {
      const ignorePath = join(TEST_TUCK_DIR, '.tuckignore');
      // A hand-edited file whose last line has no trailing newline.
      vol.writeFileSync(ignorePath, '~/bin/large-binary');

      await addToTuckignore(TEST_TUCK_DIR, '~/.docker/config.json');

      const content = vol.readFileSync(ignorePath, 'utf-8') as string;
      // The two paths must NOT be concatenated onto one line.
      expect(content).not.toContain('~/bin/large-binary~/.docker/config.json');
      expect(content.split('\n')).toContain('~/bin/large-binary');
      expect(content.split('\n')).toContain('~/.docker/config.json');

      // Both entries must be loadable (the whole point — they stay ignored).
      const ignored = await loadTuckignore(TEST_TUCK_DIR);
      expect(ignored.has('~/bin/large-binary')).toBe(true);
      expect(ignored.has('~/.docker/config.json')).toBe(true);
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

});
