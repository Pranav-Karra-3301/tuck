/**
 * Git module unit tests
 *
 * Note: These tests mock simple-git to avoid actual git operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

// Create mock git object that can be accessed across tests
const createMockGit = () => ({
  init: vi.fn().mockResolvedValue(undefined),
  clone: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  addRemote: vi.fn().mockResolvedValue(undefined),
  removeRemote: vi.fn().mockResolvedValue(undefined),
  getRemotes: vi.fn().mockResolvedValue([
    {
      name: 'origin',
      refs: {
        fetch: 'https://github.com/user/repo.git',
        push: 'https://github.com/user/repo.git',
      },
    },
  ]),
  status: vi.fn().mockResolvedValue({
    current: 'main',
    tracking: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    not_added: [],
    deleted: [],
    isClean: () => true,
  }),
  commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
  push: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  fetch: vi.fn().mockResolvedValue(undefined),
  log: vi.fn().mockResolvedValue({
    all: [{ hash: 'abc123', date: '2024-01-01', message: 'test commit', author_name: 'Test User' }],
  }),
  diff: vi.fn().mockResolvedValue(''),
  revparse: vi.fn().mockResolvedValue('main'),
  branch: vi.fn().mockResolvedValue(undefined),
  raw: vi.fn().mockResolvedValue('main'),
});

// Store the mock git instance
let mockGitInstance = createMockGit();

// Mock simple-git before importing the module
vi.mock('simple-git', () => {
  // The default export is a factory function that creates git instances
  const simpleGit = vi.fn(() => mockGitInstance);
  return {
    default: simpleGit,
    simpleGit,
  };
});

// Import after mocking
import {
  initRepo,
  isGitRepo,
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
  hasRemote,
  getRemoteUrl,
  getRemotes,
  addRemote,
  removeRemote,
  setDefaultBranch,
  cloneRepo,
} from '../../src/lib/git.js';

describe('git', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    // Reset the mock git instance before each test
    mockGitInstance = createMockGit();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // isGitRepo Tests
  // ============================================================================

  describe('isGitRepo', () => {
    it('should return true if .git directory exists', async () => {
      vol.mkdirSync(join(TEST_TUCK_DIR, '.git'), { recursive: true });

      const result = await isGitRepo(TEST_TUCK_DIR);
      expect(result).toBe(true);
    });

    it('should return false if .git directory does not exist', async () => {
      const result = await isGitRepo(TEST_TUCK_DIR);
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // initRepo Tests
  // ============================================================================

  describe('initRepo', () => {
    it('should initialize a git repository', async () => {
      await expect(initRepo(TEST_TUCK_DIR)).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // cloneRepo Tests
  // ============================================================================

  describe('cloneRepo', () => {
    it('should clone a repository', async () => {
      const destDir = join(TEST_HOME, 'cloned-repo');
      await expect(cloneRepo('https://github.com/user/repo.git', destDir)).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // Remote Operations
  // ============================================================================

  describe('addRemote', () => {
    it('should add a remote', async () => {
      await expect(
        addRemote(TEST_TUCK_DIR, 'origin', 'https://github.com/user/repo.git')
      ).resolves.not.toThrow();
    });
  });

  describe('removeRemote', () => {
    it('should remove a remote', async () => {
      await expect(removeRemote(TEST_TUCK_DIR, 'origin')).resolves.not.toThrow();
    });
  });

  describe('getRemotes', () => {
    it('should list remotes', async () => {
      const remotes = await getRemotes(TEST_TUCK_DIR);

      expect(remotes).toHaveLength(1);
      expect(remotes[0].name).toBe('origin');
    });
  });

  describe('hasRemote', () => {
    it('should return true if remote exists', async () => {
      const result = await hasRemote(TEST_TUCK_DIR, 'origin');
      expect(result).toBe(true);
    });

    it('should return false if remote does not exist', async () => {
      const result = await hasRemote(TEST_TUCK_DIR, 'nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getRemoteUrl', () => {
    it('should return remote URL', async () => {
      const url = await getRemoteUrl(TEST_TUCK_DIR, 'origin');
      expect(url).toBe('https://github.com/user/repo.git');
    });

    it('should return null for unknown remote', async () => {
      const url = await getRemoteUrl(TEST_TUCK_DIR, 'nonexistent');
      expect(url).toBeNull();
    });
  });

  // ============================================================================
  // Status and Branch Operations
  // ============================================================================

  describe('getStatus', () => {
    it('should return repository status', async () => {
      const status = await getStatus(TEST_TUCK_DIR);

      expect(status.isRepo).toBe(true);
      expect(status.branch).toBe('main');
      expect(status.hasChanges).toBe(false);
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch name', async () => {
      const branch = await getCurrentBranch(TEST_TUCK_DIR);
      expect(branch).toBe('main');
    });
  });

  describe('setDefaultBranch', () => {
    it('should set default branch', async () => {
      await expect(setDefaultBranch(TEST_TUCK_DIR, 'main')).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // Staging and Committing
  // ============================================================================

  describe('stageFiles', () => {
    it('should stage specified files', async () => {
      await expect(stageFiles(TEST_TUCK_DIR, ['file1.txt', 'file2.txt'])).resolves.not.toThrow();
    });
  });

  describe('stageAll', () => {
    it('should stage all changes', async () => {
      await expect(stageAll(TEST_TUCK_DIR)).resolves.not.toThrow();
    });
  });

  describe('commit', () => {
    it('should create a commit', async () => {
      const hash = await commit(TEST_TUCK_DIR, 'test commit');
      expect(hash).toBe('abc123');
    });
  });

  // ============================================================================
  // Push and Pull
  // ============================================================================

  describe('push', () => {
    it('should push to remote', async () => {
      await expect(push(TEST_TUCK_DIR)).resolves.not.toThrow();
    });

    it('should push with options', async () => {
      await expect(
        push(TEST_TUCK_DIR, { remote: 'origin', branch: 'main', setUpstream: true })
      ).resolves.not.toThrow();
    });
  });

  describe('pull', () => {
    it('should pull from remote', async () => {
      await expect(pull(TEST_TUCK_DIR)).resolves.not.toThrow();
    });

    it('should pull with rebase option', async () => {
      await expect(pull(TEST_TUCK_DIR, { rebase: true })).resolves.not.toThrow();
    });
  });

  describe('fetch', () => {
    it('should fetch from remote', async () => {
      await expect(fetch(TEST_TUCK_DIR)).resolves.not.toThrow();
    });

    it('should fetch from specific remote', async () => {
      await expect(fetch(TEST_TUCK_DIR, 'origin')).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // Log and Diff
  // ============================================================================

  describe('getLog', () => {
    it('should return commit log', async () => {
      const log = await getLog(TEST_TUCK_DIR);

      expect(log).toHaveLength(1);
      expect(log[0].hash).toBe('abc123');
      expect(log[0].message).toBe('test commit');
    });

    it('should respect maxCount option', async () => {
      const log = await getLog(TEST_TUCK_DIR, { maxCount: 5 });
      expect(log).toBeDefined();
    });
  });

  describe('getDiff', () => {
    it('should return diff output', async () => {
      const diff = await getDiff(TEST_TUCK_DIR);
      expect(typeof diff).toBe('string');
    });

    it('should support staged option', async () => {
      const diff = await getDiff(TEST_TUCK_DIR, { staged: true });
      expect(typeof diff).toBe('string');
    });

    it('should support stat option', async () => {
      const diff = await getDiff(TEST_TUCK_DIR, { stat: true });
      expect(typeof diff).toBe('string');
    });

    it('should support files option', async () => {
      const diff = await getDiff(TEST_TUCK_DIR, { files: ['file1.txt'] });
      expect(typeof diff).toBe('string');
    });
  });
});
