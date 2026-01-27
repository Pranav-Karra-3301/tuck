/**
 * Benchmark setup and utilities for tuck performance testing.
 *
 * IMPORTANT: Vitest bench has issues with variable sharing between beforeAll and bench().
 * All test fixtures must be created at module level (synchronously) or within each bench() call.
 * DO NOT rely on beforeAll to set up variables that bench() will use.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { afterAll } from 'vitest';

// ============================================================================
// Benchmark Environment - Created synchronously at module load
// ============================================================================

export const BENCH_TEMP_DIR = join(tmpdir(), 'tuck-bench');

// Initialize BENCH_RUN_DIR synchronously to ensure it's available immediately
if (!existsSync(BENCH_TEMP_DIR)) {
  mkdirSync(BENCH_TEMP_DIR, { recursive: true });
}
export const BENCH_RUN_DIR = mkdtempSync(join(BENCH_TEMP_DIR, 'run-'));

console.log(`[Benchmark] Temp directory created: ${BENCH_RUN_DIR}`);

// Performance tracking
export interface PerfMetrics {
  operation: string;
  duration: number;
  throughput?: number;
  memoryUsed?: number;
  iterations?: number;
}

const perfResults: PerfMetrics[] = [];
const dirsToCleanup: string[] = [BENCH_RUN_DIR];

// ============================================================================
// Cleanup - Only afterAll is reliable for cleanup
// ============================================================================

afterAll(() => {
  // Clean up all registered temp directories
  for (const dir of dirsToCleanup) {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  // Print performance summary if we have results
  if (perfResults.length > 0) {
    console.log('\n=== Performance Summary ===');
    for (const result of perfResults) {
      console.log(`${result.operation}: ${result.duration.toFixed(2)}ms`);
      if (result.throughput) {
        console.log(`  Throughput: ${result.throughput.toFixed(2)} ops/sec`);
      }
    }
  }
});

// ============================================================================
// File Generation Utilities (all synchronous)
// ============================================================================

/**
 * Generate a file with random content of specified size
 */
export const generateRandomFile = (path: string, sizeBytes: number): void => {
  const chunkSize = Math.min(sizeBytes, 65536); // 64KB chunks
  const chunks = Math.ceil(sizeBytes / chunkSize);

  // Create the file
  writeFileSync(path, '');

  // Write in chunks to handle large files
  const fs = require('fs');
  const fd = fs.openSync(path, 'a');
  for (let i = 0; i < chunks; i++) {
    const size = i === chunks - 1 ? sizeBytes % chunkSize || chunkSize : chunkSize;
    const buffer = randomBytes(size);
    fs.writeSync(fd, buffer);
  }
  fs.closeSync(fd);
};

/**
 * Generate a text file with realistic dotfile content
 */
export const generateDotfileContent = (lines: number): string => {
  const templates = [
    '# Configuration comment',
    'export PATH="$PATH:/usr/local/bin"',
    'alias ll="ls -la"',
    'HISTSIZE=10000',
    'setopt AUTO_CD',
    'bindkey -v',
    'source ~/.config/extras.sh',
    'eval "$(starship init zsh)"',
    'export EDITOR=nvim',
    'function mkcd() { mkdir -p "$1" && cd "$1"; }',
  ];

  const content: string[] = [];
  for (let i = 0; i < lines; i++) {
    content.push(templates[i % templates.length]);
  }
  return content.join('\n');
};

/**
 * Generate a file that might contain secrets (for scanner benchmarks)
 */
export const generateFileWithSecrets = (path: string, secretCount: number): void => {
  const lines: string[] = ['# Configuration file', ''];

  const secretTemplates = [
    () => `AWS_ACCESS_KEY_ID=AKIA${randomBytes(8).toString('hex').toUpperCase()}`,
    () =>
      `GITHUB_TOKEN=ghp_${randomBytes(18)
        .toString('base64')
        .replace(/[^A-Za-z0-9]/g, '')}`,
    () => `api_key = "${randomBytes(16).toString('hex')}"`,
    () => `password: "${randomBytes(12).toString('base64')}"`,
    () => `DATABASE_URL=postgres://user:${randomBytes(10).toString('hex')}@localhost/db`,
  ];

  // Add non-secret lines
  for (let i = 0; i < 50; i++) {
    lines.push(`# Line ${i}: Some configuration`);
    lines.push(`CONFIG_${i}=value${i}`);
  }

  // Intersperse secrets
  for (let i = 0; i < secretCount; i++) {
    const template = secretTemplates[i % secretTemplates.length];
    const position = Math.floor(Math.random() * lines.length);
    lines.splice(position, 0, template());
  }

  writeFileSync(path, lines.join('\n'));
};

/**
 * Generate a directory structure with many files
 */
export const generateDirectoryStructure = (
  basePath: string,
  options: {
    depth?: number;
    filesPerDir?: number;
    dirsPerLevel?: number;
    fileSize?: number;
  } = {}
): { totalFiles: number; totalDirs: number; totalBytes: number } => {
  const { depth = 3, filesPerDir = 5, dirsPerLevel = 3, fileSize = 1024 } = options;

  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;

  const createLevel = (path: string, currentDepth: number): void => {
    mkdirSync(path, { recursive: true });
    totalDirs++;

    // Create files at this level
    for (let f = 0; f < filesPerDir; f++) {
      const filePath = join(path, `file_${f}.txt`);
      const content = generateDotfileContent(Math.ceil(fileSize / 30));
      writeFileSync(filePath, content);
      totalFiles++;
      totalBytes += content.length;
    }

    // Create subdirectories
    if (currentDepth < depth) {
      for (let d = 0; d < dirsPerLevel; d++) {
        createLevel(join(path, `dir_${d}`), currentDepth + 1);
      }
    }
  };

  createLevel(basePath, 1);

  return { totalFiles, totalDirs, totalBytes };
};

/**
 * Generate a mock tuck manifest with many files
 * Must match the schema in src/schemas/manifest.schema.ts
 */
export const generateLargeManifest = (fileCount: number): object => {
  const files: Record<string, object> = {};
  const now = new Date().toISOString();

  for (let i = 0; i < fileCount; i++) {
    const id = `file_${i}`;
    files[id] = {
      source: `~/.config/app${i}/config`,
      destination: `files/misc/config_${i}`,
      checksum: randomBytes(32).toString('hex'),
      category: ['shell', 'git', 'editors', 'terminal', 'misc'][i % 5],
      strategy: 'copy', // Required by schema
      encrypted: false,
      template: false,
      added: now, // Schema uses 'added' not 'addedAt'
      modified: now, // Required by schema
    };
  }

  return {
    version: '1.0.0',
    machine: 'benchmark-machine',
    created: now,
    updated: now,
    files,
  };
};

// ============================================================================
// Timing Utilities
// ============================================================================

/**
 * Measure execution time of an async function
 */
export const measureAsync = async <T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { iterations?: number; warmup?: number }
): Promise<{ result: T; metrics: PerfMetrics }> => {
  const { iterations = 1, warmup = 0 } = options || {};

  // Warmup runs
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  // Force GC if available
  if (global.gc) {
    global.gc();
  }

  const memBefore = process.memoryUsage().heapUsed;
  const startTime = performance.now();

  let result: T;
  for (let i = 0; i < iterations; i++) {
    result = await fn();
  }

  const endTime = performance.now();
  const memAfter = process.memoryUsage().heapUsed;

  const duration = endTime - startTime;
  const metrics: PerfMetrics = {
    operation,
    duration,
    throughput: iterations > 1 ? (iterations / duration) * 1000 : undefined,
    memoryUsed: memAfter - memBefore,
    iterations,
  };

  perfResults.push(metrics);

  return { result: result!, metrics };
};

/**
 * Measure execution time of a sync function
 */
export const measureSync = <T>(
  operation: string,
  fn: () => T,
  options?: { iterations?: number; warmup?: number }
): { result: T; metrics: PerfMetrics } => {
  const { iterations = 1, warmup = 0 } = options || {};

  // Warmup runs
  for (let i = 0; i < warmup; i++) {
    fn();
  }

  const memBefore = process.memoryUsage().heapUsed;
  const startTime = performance.now();

  let result: T;
  for (let i = 0; i < iterations; i++) {
    result = fn();
  }

  const endTime = performance.now();
  const memAfter = process.memoryUsage().heapUsed;

  const duration = endTime - startTime;
  const metrics: PerfMetrics = {
    operation,
    duration,
    throughput: iterations > 1 ? (iterations / duration) * 1000 : undefined,
    memoryUsed: memAfter - memBefore,
    iterations,
  };

  perfResults.push(metrics);

  return { result: result!, metrics };
};

// ============================================================================
// Assertions for Performance
// ============================================================================

/**
 * Assert that an operation completes within a time limit
 */
export const assertPerformance = (
  metrics: PerfMetrics,
  maxDurationMs: number,
  message?: string
): void => {
  if (metrics.duration > maxDurationMs) {
    throw new Error(
      message ||
        `Performance assertion failed: ${metrics.operation} took ${metrics.duration.toFixed(2)}ms, ` +
          `expected < ${maxDurationMs}ms`
    );
  }
};

/**
 * Assert minimum throughput
 */
export const assertThroughput = (
  metrics: PerfMetrics,
  minOpsPerSec: number,
  message?: string
): void => {
  if (!metrics.throughput || metrics.throughput < minOpsPerSec) {
    throw new Error(
      message ||
        `Throughput assertion failed: ${metrics.operation} achieved ${metrics.throughput?.toFixed(2) || 0} ops/sec, ` +
          `expected >= ${minOpsPerSec} ops/sec`
    );
  }
};

// ============================================================================
// Cleanup Utilities
// ============================================================================

/**
 * Create a temporary directory that will be cleaned up after tests
 * IMPORTANT: Call this at module level, not in beforeAll
 */
export const createTempDir = (prefix: string = 'test-'): string => {
  const dir = mkdtempSync(join(BENCH_RUN_DIR, prefix));
  dirsToCleanup.push(dir);
  return dir;
};

/**
 * Clean up a directory immediately
 */
export const cleanupDir = (path: string): void => {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
};

// ============================================================================
// Fixture Creation Helpers
// ============================================================================

/**
 * Create a complete benchmark fixture synchronously
 * Call this at module level to set up test data
 */
export const createBenchmarkFixture = (name: string) => {
  const fixtureDir = createTempDir(`${name}-`);
  return {
    dir: fixtureDir,
    createFile: (filename: string, content: string) => {
      const filepath = join(fixtureDir, filename);
      writeFileSync(filepath, content);
      return filepath;
    },
    createDir: (dirname: string) => {
      const dirpath = join(fixtureDir, dirname);
      mkdirSync(dirpath, { recursive: true });
      return dirpath;
    },
  };
};

// ============================================================================
// Export for test files
// ============================================================================

export const benchUtils = {
  generateRandomFile,
  generateDotfileContent,
  generateFileWithSecrets,
  generateDirectoryStructure,
  generateLargeManifest,
  measureAsync,
  measureSync,
  assertPerformance,
  assertThroughput,
  createTempDir,
  cleanupDir,
  createBenchmarkFixture,
};
