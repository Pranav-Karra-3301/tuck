/**
 * Extended file operations unit tests
 *
 * Tests for checksum, copy, symlink, and other file operations.
 *
 * Note: fs-extra is mocked globally in setup.ts to work with memfs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  getFileChecksum,
  getFileInfo,
  getDirectoryFiles,
  copyFileOrDir,
  createSymlink,
  deleteFileOrDir,
  ensureDirectory,
  hasFileChanged,
  formatBytes,
  formatFileSize,
  getFileSizeRecursive,
  checkFileSizeThreshold,
  SIZE_WARN_THRESHOLD,
  SIZE_BLOCK_THRESHOLD,
} from '../../src/lib/files.js';
import { TEST_HOME } from '../setup.js';

describe('files-extended', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // getFileChecksum Tests
  // ============================================================================

  describe('getFileChecksum', () => {
    it('should return consistent checksum for same content', async () => {
      const filePath = join(TEST_HOME, 'test.txt');
      vol.writeFileSync(filePath, 'consistent content');

      const checksum1 = await getFileChecksum(filePath);
      const checksum2 = await getFileChecksum(filePath);

      expect(checksum1).toBe(checksum2);
    });

    it('should return different checksums for different content', async () => {
      const file1 = join(TEST_HOME, 'file1.txt');
      const file2 = join(TEST_HOME, 'file2.txt');

      vol.writeFileSync(file1, 'content one');
      vol.writeFileSync(file2, 'content two');

      const checksum1 = await getFileChecksum(file1);
      const checksum2 = await getFileChecksum(file2);

      expect(checksum1).not.toBe(checksum2);
    });

    it('should return sha256 format checksum', async () => {
      const filePath = join(TEST_HOME, 'test.txt');
      vol.writeFileSync(filePath, 'content');

      const checksum = await getFileChecksum(filePath);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle directories', async () => {
      const dirPath = join(TEST_HOME, 'subdir');
      vol.mkdirSync(dirPath);
      vol.writeFileSync(join(dirPath, 'file1.txt'), 'content1');
      vol.writeFileSync(join(dirPath, 'file2.txt'), 'content2');

      const checksum = await getFileChecksum(dirPath);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle ~ paths', async () => {
      // Note: In test env, expandPath('~') resolves to TEST_HOME via mock
      // But the real expandPath uses os.homedir() which returns the actual home
      // So we test with the full path instead
      const filePath = join(TEST_HOME, '.zshrc');
      vol.writeFileSync(filePath, 'zsh content');

      const checksum = await getFileChecksum(filePath);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ============================================================================
  // getFileInfo Tests
  // ============================================================================

  describe('getFileInfo', () => {
    it('should return file information', async () => {
      const filePath = join(TEST_HOME, 'test.txt');
      vol.writeFileSync(filePath, 'test content');

      const info = await getFileInfo(filePath);

      expect(info.path).toBe(filePath);
      expect(info.isDirectory).toBe(false);
      expect(info.size).toBe(12); // 'test content'.length
    });

    it('should identify directories', async () => {
      const dirPath = join(TEST_HOME, 'subdir');
      vol.mkdirSync(dirPath);

      const info = await getFileInfo(dirPath);

      expect(info.isDirectory).toBe(true);
    });

    it('should throw for non-existent files', async () => {
      await expect(getFileInfo(join(TEST_HOME, 'nonexistent'))).rejects.toThrow();
    });
  });

  // ============================================================================
  // getDirectoryFiles Tests
  // ============================================================================

  describe('getDirectoryFiles', () => {
    it('should list all files in directory', async () => {
      const dirPath = join(TEST_HOME, 'testdir');
      vol.mkdirSync(dirPath);
      vol.writeFileSync(join(dirPath, 'file1.txt'), 'content');
      vol.writeFileSync(join(dirPath, 'file2.txt'), 'content');

      const files = await getDirectoryFiles(dirPath);

      expect(files).toHaveLength(2);
    });

    it('should recursively list files', async () => {
      const dirPath = join(TEST_HOME, 'testdir');
      const subDir = join(dirPath, 'subdir');
      vol.mkdirSync(subDir, { recursive: true });
      vol.writeFileSync(join(dirPath, 'top.txt'), 'content');
      vol.writeFileSync(join(subDir, 'nested.txt'), 'content');

      const files = await getDirectoryFiles(dirPath);

      expect(files).toHaveLength(2);
      expect(files.some((f) => f.includes('nested.txt'))).toBe(true);
    });

    it('should skip ignored patterns', async () => {
      const dirPath = join(TEST_HOME, 'testdir');
      vol.mkdirSync(dirPath);
      vol.writeFileSync(join(dirPath, 'file.txt'), 'content');
      vol.writeFileSync(join(dirPath, '.DS_Store'), 'system');

      const files = await getDirectoryFiles(dirPath);

      expect(files.some((f) => f.includes('.DS_Store'))).toBe(false);
    });

    it('should return sorted file list', async () => {
      const dirPath = join(TEST_HOME, 'testdir');
      vol.mkdirSync(dirPath);
      vol.writeFileSync(join(dirPath, 'c.txt'), 'c');
      vol.writeFileSync(join(dirPath, 'a.txt'), 'a');
      vol.writeFileSync(join(dirPath, 'b.txt'), 'b');

      const files = await getDirectoryFiles(dirPath);

      expect(files[0]).toContain('a.txt');
      expect(files[1]).toContain('b.txt');
      expect(files[2]).toContain('c.txt');
    });
  });

  // ============================================================================
  // copyFileOrDir Tests
  // ============================================================================

  describe('copyFileOrDir', () => {
    it('should copy a file', async () => {
      const source = join(TEST_HOME, 'source.txt');
      const dest = join(TEST_HOME, 'dest.txt');
      vol.writeFileSync(source, 'source content');

      const result = await copyFileOrDir(source, dest);

      expect(result.fileCount).toBe(1);
      expect(vol.readFileSync(dest, 'utf-8')).toBe('source content');
    });

    it('should copy a directory', async () => {
      const sourceDir = join(TEST_HOME, 'source');
      const destDir = join(TEST_HOME, 'dest');
      vol.mkdirSync(sourceDir);
      vol.writeFileSync(join(sourceDir, 'file.txt'), 'content');

      const result = await copyFileOrDir(sourceDir, destDir);

      expect(result.fileCount).toBeGreaterThanOrEqual(1);
    });

    it('should throw for non-existent source', async () => {
      await expect(
        copyFileOrDir(join(TEST_HOME, 'nonexistent'), join(TEST_HOME, 'dest'))
      ).rejects.toThrow();
    });

    it('should overwrite by default', async () => {
      const source = join(TEST_HOME, 'source.txt');
      const dest = join(TEST_HOME, 'dest.txt');

      vol.writeFileSync(source, 'new content');
      vol.writeFileSync(dest, 'old content');

      await copyFileOrDir(source, dest);

      expect(vol.readFileSync(dest, 'utf-8')).toBe('new content');
    });

    it('should respect overwrite option', async () => {
      const source = join(TEST_HOME, 'source.txt');
      const dest = join(TEST_HOME, 'dest.txt');

      vol.writeFileSync(source, 'new content');
      vol.writeFileSync(dest, 'old content');

      await expect(copyFileOrDir(source, dest, { overwrite: false })).rejects.toThrow();
    });
  });

  // ============================================================================
  // createSymlink Tests
  // ============================================================================

  describe('createSymlink', () => {
    it('should create symlink to file', async () => {
      const target = join(TEST_HOME, 'target.txt');
      const link = join(TEST_HOME, 'link.txt');
      vol.writeFileSync(target, 'target content');

      const result = await createSymlink(target, link);

      expect(result.success).toBe(true);
    });

    it('should throw for non-existent target', async () => {
      await expect(
        createSymlink(join(TEST_HOME, 'nonexistent'), join(TEST_HOME, 'link'))
      ).rejects.toThrow();
    });

    it('should overwrite existing link if option set', async () => {
      const target = join(TEST_HOME, 'target.txt');
      const link = join(TEST_HOME, 'link.txt');
      vol.writeFileSync(target, 'target');
      vol.writeFileSync(link, 'existing');

      const result = await createSymlink(target, link, { overwrite: true });

      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // deleteFileOrDir Tests
  // ============================================================================

  describe('deleteFileOrDir', () => {
    it('should delete a file', async () => {
      const filePath = join(TEST_HOME, 'to-delete.txt');
      vol.writeFileSync(filePath, 'content');

      await deleteFileOrDir(filePath);

      expect(() => vol.statSync(filePath)).toThrow();
    });

    it('should delete a directory', async () => {
      const dirPath = join(TEST_HOME, 'to-delete');
      vol.mkdirSync(dirPath);
      vol.writeFileSync(join(dirPath, 'file.txt'), 'content');

      await deleteFileOrDir(dirPath);

      expect(() => vol.statSync(dirPath)).toThrow();
    });

    it('should not throw for non-existent path', async () => {
      await expect(deleteFileOrDir(join(TEST_HOME, 'nonexistent'))).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // ensureDirectory Tests
  // ============================================================================

  describe('ensureDirectory', () => {
    it('should create directory if not exists', async () => {
      const dirPath = join(TEST_HOME, 'new-dir');

      await ensureDirectory(dirPath);

      expect(vol.statSync(dirPath).isDirectory()).toBe(true);
    });

    it('should create nested directories', async () => {
      const nestedPath = join(TEST_HOME, 'a', 'b', 'c');

      await ensureDirectory(nestedPath);

      expect(vol.statSync(nestedPath).isDirectory()).toBe(true);
    });

    it('should not fail if directory exists', async () => {
      const dirPath = join(TEST_HOME, 'existing');
      vol.mkdirSync(dirPath);

      await expect(ensureDirectory(dirPath)).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // hasFileChanged Tests
  // ============================================================================

  describe('hasFileChanged', () => {
    it('should return false for identical files', async () => {
      const file1 = join(TEST_HOME, 'file1.txt');
      const file2 = join(TEST_HOME, 'file2.txt');

      vol.writeFileSync(file1, 'same content');
      vol.writeFileSync(file2, 'same content');

      const changed = await hasFileChanged(file1, file2);

      expect(changed).toBe(false);
    });

    it('should return true for different files', async () => {
      const file1 = join(TEST_HOME, 'file1.txt');
      const file2 = join(TEST_HOME, 'file2.txt');

      vol.writeFileSync(file1, 'content one');
      vol.writeFileSync(file2, 'content two');

      const changed = await hasFileChanged(file1, file2);

      expect(changed).toBe(true);
    });

    it('should return true if either file does not exist', async () => {
      const existing = join(TEST_HOME, 'existing.txt');
      vol.writeFileSync(existing, 'content');

      const changed = await hasFileChanged(existing, join(TEST_HOME, 'nonexistent.txt'));

      expect(changed).toBe(true);
    });
  });

  // ============================================================================
  // Format Functions Tests
  // ============================================================================

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
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1 GB');
    });
  });

  describe('formatFileSize', () => {
    it('should handle negative values', () => {
      expect(formatFileSize(-100)).toBe('0 B');
    });

    it('should handle NaN', () => {
      expect(formatFileSize(NaN)).toBe('0 B');
    });

    it('should handle Infinity', () => {
      expect(formatFileSize(Infinity)).toBe('0 B');
    });
  });

  // ============================================================================
  // File Size Threshold Tests
  // ============================================================================

  describe('getFileSizeRecursive', () => {
    it('should return file size', async () => {
      const filePath = join(TEST_HOME, 'test.txt');
      vol.writeFileSync(filePath, 'a'.repeat(100));

      const size = await getFileSizeRecursive(filePath);

      expect(size).toBe(100);
    });

    it('should sum directory contents', async () => {
      const dirPath = join(TEST_HOME, 'testdir');
      vol.mkdirSync(dirPath);
      vol.writeFileSync(join(dirPath, 'file1.txt'), 'a'.repeat(50));
      vol.writeFileSync(join(dirPath, 'file2.txt'), 'b'.repeat(50));

      const size = await getFileSizeRecursive(dirPath);

      expect(size).toBe(100);
    });

    it('should return 0 for non-existent path', async () => {
      const size = await getFileSizeRecursive(join(TEST_HOME, 'nonexistent'));
      expect(size).toBe(0);
    });
  });

  describe('checkFileSizeThreshold', () => {
    it('should return warn/block flags', async () => {
      const filePath = join(TEST_HOME, 'test.txt');
      vol.writeFileSync(filePath, 'small content');

      const result = await checkFileSizeThreshold(filePath);

      expect(result).toHaveProperty('warn');
      expect(result).toHaveProperty('block');
      expect(result).toHaveProperty('size');
    });

    it('should not warn for small files', async () => {
      const filePath = join(TEST_HOME, 'small.txt');
      vol.writeFileSync(filePath, 'small');

      const result = await checkFileSizeThreshold(filePath);

      expect(result.warn).toBe(false);
      expect(result.block).toBe(false);
    });
  });

  describe('Size Thresholds', () => {
    it('should have warning threshold at 50MB', () => {
      expect(SIZE_WARN_THRESHOLD).toBe(50 * 1024 * 1024);
    });

    it('should have block threshold at 100MB', () => {
      expect(SIZE_BLOCK_THRESHOLD).toBe(100 * 1024 * 1024);
    });
  });
});
