/**
 * Git module error handling tests
 *
 * Tests for git operation error paths and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

// Create mock git object that throws errors
const createErrorMockGit = (errorMessage: string) => ({
  init: vi.fn().mockRejectedValue(new Error(errorMessage)),
  clone: vi.fn().mockRejectedValue(new Error(errorMessage)),
  add: vi.fn().mockRejectedValue(new Error(errorMessage)),
  addRemote: vi.fn().mockRejectedValue(new Error(errorMessage)),
  removeRemote: vi.fn().mockRejectedValue(new Error(errorMessage)),
  getRemotes: vi.fn().mockRejectedValue(new Error(errorMessage)),
  status: vi.fn().mockRejectedValue(new Error(errorMessage)),
  commit: vi.fn().mockRejectedValue(new Error(errorMessage)),
  push: vi.fn().mockRejectedValue(new Error(errorMessage)),
  pull: vi.fn().mockRejectedValue(new Error(errorMessage)),
  fetch: vi.fn().mockRejectedValue(new Error(errorMessage)),
  log: vi.fn().mockRejectedValue(new Error(errorMessage)),
  diff: vi.fn().mockRejectedValue(new Error(errorMessage)),
  revparse: vi.fn().mockRejectedValue(new Error(errorMessage)),
  branch: vi.fn().mockRejectedValue(new Error(errorMessage)),
  raw: vi.fn().mockRejectedValue(new Error(errorMessage)),
});

// Store mock git instance
let mockGitInstance = createErrorMockGit('Git operation failed');

// Mock simple-git
vi.mock('simple-git', () => {
  const simpleGit = vi.fn(() => mockGitInstance);
  return {
    default: simpleGit,
    simpleGit,
  };
});

// Import after mocking
import {
  initRepo,
  cloneRepo,
  addRemote,
  removeRemote,
  getRemotes,
  getStatus,
  stageFiles,
  stageAll,
  commit,
  push,
  pull,
  fetch,
  getLog,
  getDiff,
  getCurrentBranch,
  setDefaultBranch,
} from '../../src/lib/git.js';
import { GitError } from '../../src/errors.js';

describe('git-errors', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    mockGitInstance = createErrorMockGit('Git operation failed');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // initRepo Error Tests
  // ============================================================================

  describe('initRepo errors', () => {
    it('should throw GitError when init fails', async () => {
      mockGitInstance = createErrorMockGit('not a git repository');

      await expect(initRepo(TEST_TUCK_DIR)).rejects.toThrow('Failed to initialize');
    });

    it('should include original error message', async () => {
      mockGitInstance = createErrorMockGit('permission denied');

      try {
        await initRepo(TEST_TUCK_DIR);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
        expect((error as GitError).message).toContain('Failed to initialize');
      }
    });
  });

  // ============================================================================
  // cloneRepo Error Tests
  // ============================================================================

  describe('cloneRepo errors', () => {
    it('should throw GitError when clone fails', async () => {
      mockGitInstance = createErrorMockGit('repository not found');

      await expect(
        cloneRepo('https://github.com/nonexistent/repo.git', TEST_TUCK_DIR)
      ).rejects.toThrow('Failed to clone');
    });

    it('should include URL in error message', async () => {
      mockGitInstance = createErrorMockGit('access denied');

      try {
        await cloneRepo('https://github.com/private/repo.git', TEST_TUCK_DIR);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
        expect((error as GitError).message).toContain('https://github.com/private/repo.git');
      }
    });
  });

  // ============================================================================
  // Remote Operation Error Tests
  // ============================================================================

  describe('addRemote errors', () => {
    it('should throw GitError when adding remote fails', async () => {
      mockGitInstance = createErrorMockGit('remote already exists');

      await expect(
        addRemote(TEST_TUCK_DIR, 'origin', 'https://github.com/user/repo.git')
      ).rejects.toThrow('Failed to add remote');
    });
  });

  describe('removeRemote errors', () => {
    it('should throw GitError when removing remote fails', async () => {
      mockGitInstance = createErrorMockGit('remote not found');

      await expect(removeRemote(TEST_TUCK_DIR, 'nonexistent')).rejects.toThrow(
        'Failed to remove remote'
      );
    });
  });

  describe('getRemotes errors', () => {
    it('should throw GitError when getting remotes fails', async () => {
      mockGitInstance = createErrorMockGit('not a git repository');

      await expect(getRemotes(TEST_TUCK_DIR)).rejects.toThrow('Failed to get remotes');
    });
  });

  // ============================================================================
  // Status Error Tests
  // ============================================================================

  describe('getStatus errors', () => {
    it('should throw GitError when status fails', async () => {
      mockGitInstance = createErrorMockGit('not a git repository');

      await expect(getStatus(TEST_TUCK_DIR)).rejects.toThrow('Failed to get status');
    });
  });

  // ============================================================================
  // Staging Error Tests
  // ============================================================================

  describe('stageFiles errors', () => {
    it('should throw GitError when staging fails', async () => {
      mockGitInstance = createErrorMockGit('pathspec did not match');

      await expect(stageFiles(TEST_TUCK_DIR, ['nonexistent.txt'])).rejects.toThrow(
        'Failed to stage files'
      );
    });
  });

  describe('stageAll errors', () => {
    it('should throw GitError when staging all fails', async () => {
      mockGitInstance = createErrorMockGit('not a git repository');

      await expect(stageAll(TEST_TUCK_DIR)).rejects.toThrow('Failed to stage all files');
    });
  });

  // ============================================================================
  // Commit Error Tests
  // ============================================================================

  describe('commit errors', () => {
    it('should throw GitError when commit fails', async () => {
      mockGitInstance = createErrorMockGit('nothing to commit');

      await expect(commit(TEST_TUCK_DIR, 'test commit')).rejects.toThrow('Failed to commit');
    });

    it('should throw GitError for empty commit message', async () => {
      mockGitInstance = createErrorMockGit('Aborting commit due to empty commit message');

      await expect(commit(TEST_TUCK_DIR, '')).rejects.toThrow('Failed to commit');
    });
  });

  // ============================================================================
  // Push Error Tests
  // ============================================================================

  describe('push errors', () => {
    it('should throw GitError when push fails', async () => {
      mockGitInstance = createErrorMockGit('authentication failed');

      await expect(push(TEST_TUCK_DIR)).rejects.toThrow('Failed to push');
    });

    it('should throw GitError for non-fast-forward push', async () => {
      mockGitInstance = createErrorMockGit('non-fast-forward');

      await expect(push(TEST_TUCK_DIR)).rejects.toThrow('Failed to push');
    });
  });

  // ============================================================================
  // Pull Error Tests
  // ============================================================================

  describe('pull errors', () => {
    it('should throw GitError when pull fails', async () => {
      mockGitInstance = createErrorMockGit('merge conflict');

      await expect(pull(TEST_TUCK_DIR)).rejects.toThrow('Failed to pull');
    });

    it('should throw GitError for diverged branches', async () => {
      mockGitInstance = createErrorMockGit('refusing to merge unrelated histories');

      await expect(pull(TEST_TUCK_DIR, { rebase: true })).rejects.toThrow('Failed to pull');
    });
  });

  // ============================================================================
  // Fetch Error Tests
  // ============================================================================

  describe('fetch errors', () => {
    it('should throw GitError when fetch fails', async () => {
      mockGitInstance = createErrorMockGit('could not read from remote');

      await expect(fetch(TEST_TUCK_DIR)).rejects.toThrow('Failed to fetch');
    });

    it('should throw GitError for network errors', async () => {
      mockGitInstance = createErrorMockGit('unable to access');

      await expect(fetch(TEST_TUCK_DIR, 'origin')).rejects.toThrow('Failed to fetch');
    });
  });

  // ============================================================================
  // Log Error Tests
  // ============================================================================

  describe('getLog errors', () => {
    it('should throw GitError when getting log fails', async () => {
      mockGitInstance = createErrorMockGit('not a git repository');

      await expect(getLog(TEST_TUCK_DIR)).rejects.toThrow('Failed to get log');
    });

    it('should throw GitError for repos with no commits', async () => {
      mockGitInstance = createErrorMockGit("your current branch 'main' does not have any commits");

      await expect(getLog(TEST_TUCK_DIR, { maxCount: 5 })).rejects.toThrow('Failed to get log');
    });
  });

  // ============================================================================
  // Diff Error Tests
  // ============================================================================

  describe('getDiff errors', () => {
    it('should throw GitError when getting diff fails', async () => {
      mockGitInstance = createErrorMockGit('not a git repository');

      await expect(getDiff(TEST_TUCK_DIR)).rejects.toThrow('Failed to get diff');
    });
  });

  // ============================================================================
  // Branch Error Tests
  // ============================================================================

  describe('getCurrentBranch errors', () => {
    it('should fallback to main when branch detection fails', async () => {
      mockGitInstance = createErrorMockGit('fatal: not a git repository');

      const branch = await getCurrentBranch(TEST_TUCK_DIR);

      // Should fallback to 'main'
      expect(branch).toBe('main');
    });
  });

  describe('setDefaultBranch errors', () => {
    it('should throw GitError when setting branch fails', async () => {
      mockGitInstance = createErrorMockGit('invalid branch name');

      await expect(setDefaultBranch(TEST_TUCK_DIR, 'invalid branch')).rejects.toThrow(
        'Failed to set default branch'
      );
    });
  });
});
