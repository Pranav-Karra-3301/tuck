/**
 * File operation benchmarks for tuck.
 *
 * Tests performance of core file operations that are critical to tuck's speed:
 * - File copying
 * - Directory traversal
 * - File reading/writing
 * - Symlink creation
 *
 * IMPORTANT: Fixtures are created at module level, not in beforeAll,
 * due to vitest bench variable sharing issues.
 */

import { describe, bench } from 'vitest';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import {
  createTempDir,
  generateRandomFile,
  generateDirectoryStructure,
  generateDotfileContent,
} from './setup.js';

// Import the actual tuck functions to benchmark
import {
  copyFileOrDir,
  getDirectoryFiles,
  deleteFileOrDir,
  getFileInfo,
  createSymlink,
  getFileSizeRecursive,
} from '../../src/lib/files.js';

// ============================================================================
// Create fixtures at module level (synchronously)
// ============================================================================

const tempDir = createTempDir('files-bench-');

// Create test files of various sizes
const smallFile = join(tempDir, 'small.txt');
const mediumFile = join(tempDir, 'medium.txt');
const largeFile = join(tempDir, 'large.bin');

// 1KB file
writeFileSync(smallFile, generateDotfileContent(30));

// 100KB file
writeFileSync(mediumFile, generateDotfileContent(3000));

// 10MB file
generateRandomFile(largeFile, 10 * 1024 * 1024);

// Create directory structures
const deepDir = join(tempDir, 'deep');
generateDirectoryStructure(deepDir, { depth: 5, filesPerDir: 3, dirsPerLevel: 2 });

const wideDir = join(tempDir, 'wide');
generateDirectoryStructure(wideDir, { depth: 2, filesPerDir: 50, dirsPerLevel: 10 });

// ============================================================================
// Benchmarks
// ============================================================================

describe('File Operations Benchmarks', () => {
  // ============================================================================
  // File Copy Benchmarks
  // ============================================================================

  describe('copyFileOrDir', () => {
    bench('copy small file (1KB)', async () => {
      const dest = join(tempDir, `copy_small_${Date.now()}.txt`);
      await copyFileOrDir(smallFile, dest);
    });

    bench('copy medium file (100KB)', async () => {
      const dest = join(tempDir, `copy_medium_${Date.now()}.txt`);
      await copyFileOrDir(mediumFile, dest);
    });

    bench('copy large file (10MB)', async () => {
      const dest = join(tempDir, `copy_large_${Date.now()}.bin`);
      await copyFileOrDir(largeFile, dest);
    });

    bench('copy deep directory structure', async () => {
      const dest = join(tempDir, `copy_deep_${Date.now()}`);
      await copyFileOrDir(deepDir, dest);
    });

    bench('copy wide directory structure', async () => {
      const dest = join(tempDir, `copy_wide_${Date.now()}`);
      await copyFileOrDir(wideDir, dest);
    });
  });

  // ============================================================================
  // Directory Traversal Benchmarks
  // ============================================================================

  describe('getDirectoryFiles', () => {
    bench('traverse deep directory (5 levels)', async () => {
      await getDirectoryFiles(deepDir);
    });

    bench('traverse wide directory (500+ files)', async () => {
      await getDirectoryFiles(wideDir);
    });
  });

  // ============================================================================
  // File Info Benchmarks
  // ============================================================================

  describe('getFileInfo', () => {
    bench('get info for small file', async () => {
      await getFileInfo(smallFile);
    });

    bench('get info for large file', async () => {
      await getFileInfo(largeFile);
    });

    bench('get info for directory', async () => {
      await getFileInfo(deepDir);
    });
  });

  // ============================================================================
  // Size Calculation Benchmarks
  // ============================================================================

  describe('getFileSizeRecursive', () => {
    bench('calculate size of single file', async () => {
      await getFileSizeRecursive(largeFile);
    });

    bench('calculate size of deep directory', async () => {
      await getFileSizeRecursive(deepDir);
    });

    bench('calculate size of wide directory', async () => {
      await getFileSizeRecursive(wideDir);
    });
  });

  // ============================================================================
  // Symlink Benchmarks
  // ============================================================================

  describe('createSymlink', () => {
    bench('create symlink to file', async () => {
      const linkPath = join(tempDir, `link_${Date.now()}`);
      await createSymlink(smallFile, linkPath);
    });

    bench('create symlink to directory', async () => {
      const linkPath = join(tempDir, `link_dir_${Date.now()}`);
      await createSymlink(deepDir, linkPath);
    });
  });

  // ============================================================================
  // Delete Benchmarks
  // ============================================================================

  describe('deleteFileOrDir', () => {
    bench('delete single file', async () => {
      const filePath = join(tempDir, `delete_${Date.now()}.txt`);
      writeFileSync(filePath, 'test');
      await deleteFileOrDir(filePath);
    });

    bench('delete directory with files', async () => {
      const dirPath = join(tempDir, `delete_dir_${Date.now()}`);
      generateDirectoryStructure(dirPath, { depth: 2, filesPerDir: 5, dirsPerLevel: 2 });
      await deleteFileOrDir(dirPath);
    });
  });
});
