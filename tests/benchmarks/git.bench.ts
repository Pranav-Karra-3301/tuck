/**
 * Git operation benchmarks for tuck.
 *
 * Git operations are external processes - inherently slower than in-memory ops.
 * Performance concerns:
 * - Process spawn overhead
 * - Repository size impact
 * - Status command on repos with many files
 *
 * Note: These benchmarks require a real git installation.
 *
 * IMPORTANT: Fixtures are created at module level, not in beforeAll,
 * due to vitest bench variable sharing issues.
 */

import { describe, bench, beforeEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { createTempDir, generateDotfileContent } from './setup.js';

// Import git functions
import {
  initRepo,
  isGitRepo,
  getStatus,
  stageFiles,
  stageAll,
  getLog,
  getDiff,
  getCurrentBranch,
} from '../../src/lib/git.js';

// ============================================================================
// Create fixtures at module level (synchronously)
// ============================================================================

const tempDir = createTempDir('git-bench-');

const initializeGitRepo = (dir: string, fileCount: number) => {
  mkdirSync(dir, { recursive: true });

  // Initialize git repo
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "bench@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Benchmark"', { cwd: dir, stdio: 'pipe' });

  // Create initial files
  for (let i = 0; i < fileCount; i++) {
    const filePath = join(dir, `file_${i}.txt`);
    writeFileSync(filePath, generateDotfileContent(20));
  }

  // Initial commit
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: dir, stdio: 'pipe' });
};

// Create repos of different sizes
const repoSmall = join(tempDir, 'repo-small');
const repoMedium = join(tempDir, 'repo-medium');
const repoLarge = join(tempDir, 'repo-large');

initializeGitRepo(repoSmall, 10);
initializeGitRepo(repoMedium, 100);
initializeGitRepo(repoLarge, 500);

// ============================================================================
// Benchmarks
// ============================================================================

describe('Git Operation Benchmarks', () => {
  // ============================================================================
  // Repository Detection
  // ============================================================================

  describe('isGitRepo', () => {
    bench('check if directory is git repo (positive)', async () => {
      await isGitRepo(repoSmall);
    });

    bench('check if directory is git repo (negative)', async () => {
      await isGitRepo(tempDir);
    });
  });

  // ============================================================================
  // Status Benchmarks
  // ============================================================================

  describe('getStatus', () => {
    bench('get status - small repo (10 files)', async () => {
      await getStatus(repoSmall);
    });

    bench('get status - medium repo (100 files)', async () => {
      await getStatus(repoMedium);
    });

    bench('get status - large repo (500 files)', async () => {
      await getStatus(repoLarge);
    });

    bench('get status - with modifications', async () => {
      // Modify a file
      writeFileSync(join(repoMedium, 'file_0.txt'), 'modified content');
      await getStatus(repoMedium);
      // Restore
      writeFileSync(join(repoMedium, 'file_0.txt'), generateDotfileContent(20));
    });

    bench('get status - with untracked files', async () => {
      // Add untracked file
      writeFileSync(join(repoMedium, 'untracked.txt'), 'new file');
      await getStatus(repoMedium);
      // Cleanup
      try {
        unlinkSync(join(repoMedium, 'untracked.txt'));
      } catch {
        // Ignore if file doesn't exist
      }
    });
  });

  // ============================================================================
  // Staging Benchmarks
  // ============================================================================

  describe('stageFiles', () => {
    beforeEach(() => {
      // Create a modified file for staging tests
      writeFileSync(join(repoMedium, 'stage_test.txt'), `modified ${Date.now()}`);
    });

    bench('stage single file', async () => {
      await stageFiles(repoMedium, ['stage_test.txt']);
    });

    bench('stage multiple files', async () => {
      // Create multiple modified files
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(repoMedium, `stage_multi_${i}.txt`), `content ${i}`);
      }

      const files = Array.from({ length: 10 }, (_, i) => `stage_multi_${i}.txt`);
      await stageFiles(repoMedium, files);
    });
  });

  describe('stageAll', () => {
    bench('stage all changes', async () => {
      writeFileSync(join(repoSmall, 'stageall_test.txt'), `modified ${Date.now()}`);
      await stageAll(repoSmall);
    });
  });

  // ============================================================================
  // Log Benchmarks
  // ============================================================================

  describe('getLog', () => {
    bench('get log (10 commits)', async () => {
      await getLog(repoSmall, { maxCount: 10 });
    });

    bench('get log (100 commits)', async () => {
      await getLog(repoSmall, { maxCount: 100 });
    });
  });

  // ============================================================================
  // Diff Benchmarks
  // ============================================================================

  describe('getDiff', () => {
    bench('get diff - no changes', async () => {
      await getDiff(repoSmall);
    });

    bench('get diff - with changes', async () => {
      writeFileSync(join(repoSmall, 'file_0.txt'), 'modified for diff');
      await getDiff(repoSmall);
      writeFileSync(join(repoSmall, 'file_0.txt'), generateDotfileContent(20));
    });

    bench('get diff - staged changes', async () => {
      writeFileSync(join(repoSmall, 'file_0.txt'), 'staged diff');
      execSync('git add file_0.txt', { cwd: repoSmall, stdio: 'pipe' });
      await getDiff(repoSmall, { staged: true });
      execSync('git checkout file_0.txt', { cwd: repoSmall, stdio: 'pipe' });
    });

    bench('get diff with stat', async () => {
      await getDiff(repoSmall, { stat: true });
    });
  });

  // ============================================================================
  // Branch Operations
  // ============================================================================

  describe('getCurrentBranch', () => {
    bench('get current branch', async () => {
      await getCurrentBranch(repoSmall);
    });
  });

  // ============================================================================
  // Combined Operations
  // ============================================================================

  describe('Combined Operations', () => {
    bench('status + stage + diff cycle', async () => {
      writeFileSync(join(repoSmall, 'cycle_test.txt'), `cycle ${Date.now()}`);
      await getStatus(repoSmall);
      await stageFiles(repoSmall, ['cycle_test.txt']);
      await getDiff(repoSmall, { staged: true });
    });

    bench('typical sync check workflow', async () => {
      // This simulates what tuck sync does
      await getStatus(repoMedium);
      await getCurrentBranch(repoMedium);
      await getLog(repoMedium, { maxCount: 5 });
    });
  });

  // ============================================================================
  // Init Benchmark
  // ============================================================================

  describe('initRepo', () => {
    bench('initialize new repository', async () => {
      const newRepoDir = join(tempDir, `new-repo-${Date.now()}`);
      mkdirSync(newRepoDir, { recursive: true });
      await initRepo(newRepoDir);
    });
  });
});
