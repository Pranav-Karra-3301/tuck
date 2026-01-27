/**
 * Checksum calculation benchmarks for tuck.
 *
 * The checksum function is one of the most critical performance bottlenecks:
 * - Called for every file during sync to detect changes
 * - Called for every file during add to track initial state
 * - Performance directly impacts user experience
 *
 * Target performance:
 * - 1MB file: < 10ms
 * - 10MB file: < 100ms
 * - 100MB file: < 500ms
 *
 * IMPORTANT: Fixtures are created at module level, not in beforeAll,
 * due to vitest bench variable sharing issues.
 */

import { describe, bench, expect } from 'vitest';
import { join } from 'path';
import { writeFileSync } from 'fs';
import {
  createTempDir,
  generateRandomFile,
  generateDotfileContent,
  generateDirectoryStructure,
} from './setup.js';

// Import the actual tuck function
import { getFileChecksum, hasFileChanged } from '../../src/lib/files.js';

// ============================================================================
// Create fixtures at module level (synchronously)
// ============================================================================

const tempDir = createTempDir('checksum-bench-');

// Create files of various sizes
const file1KB = join(tempDir, '1kb.txt');
const file10KB = join(tempDir, '10kb.txt');
const file100KB = join(tempDir, '100kb.txt');
const file1MB = join(tempDir, '1mb.bin');
const file10MB = join(tempDir, '10mb.bin');
const file100MB = join(tempDir, '100mb.bin');

// Generate text files
writeFileSync(file1KB, generateDotfileContent(30));
writeFileSync(file10KB, generateDotfileContent(300));
writeFileSync(file100KB, generateDotfileContent(3000));

// Generate binary files
generateRandomFile(file1MB, 1 * 1024 * 1024);
generateRandomFile(file10MB, 10 * 1024 * 1024);
generateRandomFile(file100MB, 100 * 1024 * 1024);

// Create directory with many files
const dirManyFiles = join(tempDir, 'many-files');
generateDirectoryStructure(dirManyFiles, {
  depth: 3,
  filesPerDir: 20,
  dirsPerLevel: 5,
  fileSize: 1024,
});

// Create files for comparison
const fileA = join(tempDir, 'compare_a.txt');
const fileB = join(tempDir, 'compare_b.txt');
const fileC = join(tempDir, 'compare_c.txt');

const compareContent = generateDotfileContent(100);
writeFileSync(fileA, compareContent);
writeFileSync(fileB, compareContent); // Same as A
writeFileSync(fileC, compareContent + '\n# Different'); // Different from A

// Create throughput test files
for (let j = 0; j < 100; j++) {
  const p = join(tempDir, `throughput_${j}.txt`);
  writeFileSync(p, generateDotfileContent(30));
}
const throughputFiles = Array.from({ length: 100 }, (_, i) => join(tempDir, `throughput_${i}.txt`));

// ============================================================================
// Benchmarks
// ============================================================================

describe('Checksum Benchmarks', () => {
  // ============================================================================
  // Single File Checksum Benchmarks
  // ============================================================================

  describe('getFileChecksum - Single Files', () => {
    bench('checksum 1KB file', async () => {
      await getFileChecksum(file1KB);
    });

    bench('checksum 10KB file', async () => {
      await getFileChecksum(file10KB);
    });

    bench('checksum 100KB file', async () => {
      await getFileChecksum(file100KB);
    });

    bench('checksum 1MB file', async () => {
      await getFileChecksum(file1MB);
    });

    bench('checksum 10MB file', async () => {
      await getFileChecksum(file10MB);
    });

    bench('checksum 100MB file', async () => {
      await getFileChecksum(file100MB);
    });
  });

  // ============================================================================
  // Directory Checksum Benchmarks
  // ============================================================================

  describe('getFileChecksum - Directories', () => {
    bench('checksum directory with many files', async () => {
      await getFileChecksum(dirManyFiles);
    });
  });

  // ============================================================================
  // File Comparison Benchmarks
  // ============================================================================

  describe('hasFileChanged', () => {
    bench('compare identical files', async () => {
      await hasFileChanged(fileA, fileB);
    });

    bench('compare different files', async () => {
      await hasFileChanged(fileA, fileC);
    });

    bench('compare with non-existent file', async () => {
      await hasFileChanged(fileA, join(tempDir, 'nonexistent.txt'));
    });
  });

  // ============================================================================
  // Throughput Tests
  // ============================================================================

  describe('Checksum Throughput', () => {
    bench('checksum 100 small files sequentially', async () => {
      for (const file of throughputFiles) {
        await getFileChecksum(file);
      }
    });

    bench('checksum 100 small files in parallel', async () => {
      await Promise.all(throughputFiles.map((file) => getFileChecksum(file)));
    });
  });

  // ============================================================================
  // Performance Validation (with assertions)
  // ============================================================================

  describe('Performance Requirements', () => {
    bench('1MB checksum under 50ms', async () => {
      const start = performance.now();
      await getFileChecksum(file1MB);
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(50);
    });

    bench('10MB checksum under 200ms', async () => {
      const start = performance.now();
      await getFileChecksum(file10MB);
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(200);
    });
  });
});
