/**
 * Git module unit tests
 *
 * Note: These tests mock simple-git to avoid actual git operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
import { GitError } from '../../src/errors.js';

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

// cloneRepo shells out to `git clone` via child_process.execFile (simple-git
// does not honor maxBuffer), so mock execFile to emulate a successful run and
// guarantee no real git process is ever spawned.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));

// Import after mocking
import {
  initRepo,
  getStatus,
  stageAll,
  commit,
  push,
  pull,
  fetch,
  getLog,
  getDiff,
  getCurrentBranch,
  countCommitsBehindRemote,
  hasRemote,
  getRemoteUrl,
  getRemotes,
  addRemote,
  removeRemote,
  setRemoteUrl,
  upsertRemote,
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
    // promisify(execFile) calls execFile(cmd, args, opts, callback); resolve it.
    execFileMock.mockImplementation((_cmd, _args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      callback?.(null, { stdout: '', stderr: '' });
    });
  });

  afterEach(() => {
    vol.reset();
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
    it('should clone a repository via execFile', async () => {
      const destDir = join(TEST_HOME, 'cloned-repo');
      await expect(cloneRepo('https://github.com/user/repo.git', destDir)).resolves.not.toThrow();

      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/user/repo.git', destDir],
        expect.objectContaining({ maxBuffer: expect.any(Number) }),
        expect.any(Function)
      );
    });

    it('performs a full clone (no --depth) when no depth is given', async () => {
      const destDir = join(TEST_HOME, 'full-clone');
      await cloneRepo('https://github.com/user/repo.git', destDir);

      const args = execFileMock.mock.calls[0][1] as string[];
      expect(args).not.toContain('--depth');
    });

    it('passes --depth <n> in order before the url when a positive depth is given', async () => {
      const destDir = join(TEST_HOME, 'shallow-clone');
      await cloneRepo('https://github.com/user/repo.git', destDir, { depth: 1 });

      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['clone', '--depth', '1', 'https://github.com/user/repo.git', destDir],
        expect.objectContaining({ maxBuffer: expect.any(Number) }),
        expect.any(Function)
      );
    });

    it('ignores a non-positive / non-integer depth and falls back to a full clone', async () => {
      const destDir = join(TEST_HOME, 'bad-depth-clone');
      await cloneRepo('https://github.com/user/repo.git', destDir, { depth: 0 });
      await cloneRepo('https://github.com/user/repo.git', destDir, { depth: -5 });
      await cloneRepo('https://github.com/user/repo.git', destDir, {
        depth: 1.5,
      });

      for (const call of execFileMock.mock.calls) {
        expect(call[1]).not.toContain('--depth');
      }
    });

    it('applies the clone timeout and maxBuffer bounds', async () => {
      const destDir = join(TEST_HOME, 'bounded-clone');
      await cloneRepo('https://github.com/user/repo.git', destDir, { depth: 1 });

      const opts = execFileMock.mock.calls[0][2] as {
        timeout: number;
        maxBuffer: number;
      };
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.maxBuffer).toBeGreaterThan(0);
    });

    it('scrubs credentials from the error when the clone fails', async () => {
      execFileMock.mockImplementation((_cmd, _args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        callback?.(new Error('fatal: could not read from https://user:secret@github.com/x.git'));
      });
      const destDir = join(TEST_HOME, 'failed-clone');
      const err = await cloneRepo('https://user:secret@github.com/x.git', destDir).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(GitError);
      // The raw token must not survive into the thrown error message/output.
      expect(JSON.stringify(err)).not.toContain('secret');
      expect((err as Error).message).not.toContain('secret');
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

  describe('setRemoteUrl', () => {
    it('should run git remote set-url', async () => {
      mockGitInstance.remote = vi.fn().mockResolvedValue(undefined);
      await expect(
        setRemoteUrl(TEST_TUCK_DIR, 'origin', 'https://github.com/user/new.git')
      ).resolves.not.toThrow();
      expect(mockGitInstance.remote).toHaveBeenCalledWith([
        'set-url',
        'origin',
        'https://github.com/user/new.git',
      ]);
    });
  });

  describe('upsertRemote', () => {
    it('updates an existing origin in place (set-url, never add)', async () => {
      // Default mock getRemotes returns an existing origin → hasRemote === true.
      mockGitInstance.remote = vi.fn().mockResolvedValue(undefined);
      await upsertRemote(TEST_TUCK_DIR, 'origin', 'https://github.com/user/new.git');

      expect(mockGitInstance.remote).toHaveBeenCalledWith([
        'set-url',
        'origin',
        'https://github.com/user/new.git',
      ]);
      expect(mockGitInstance.addRemote).not.toHaveBeenCalled();
    });

    it('adds origin when none exists (no remove+add race)', async () => {
      // No remotes → hasRemote === false → addRemote path.
      mockGitInstance.getRemotes = vi.fn().mockResolvedValue([]);
      mockGitInstance.remote = vi.fn().mockResolvedValue(undefined);

      await upsertRemote(TEST_TUCK_DIR, 'origin', 'https://github.com/user/new.git');

      expect(mockGitInstance.addRemote).toHaveBeenCalledWith(
        'origin',
        'https://github.com/user/new.git'
      );
      expect(mockGitInstance.remote).not.toHaveBeenCalled();
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

  describe('stageAll', () => {
    it('should stage all changes', async () => {
      vol.writeFileSync(join(TEST_TUCK_DIR, 'README.md'), '# test');
      await expect(stageAll(TEST_TUCK_DIR)).resolves.not.toThrow();
      expect(mockGitInstance.raw).toHaveBeenCalledWith(['add', '--all', '--', 'README.md']);
    });

    it('skips internal runtime artifacts when staging everything', async () => {
      vol.writeFileSync(join(TEST_TUCK_DIR, 'README.md'), '# test');
      vol.writeFileSync(join(TEST_TUCK_DIR, 'audit.log'), 'legacy');
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuck-keystore.enc'), 'legacy');
      vol.writeFileSync(join(TEST_TUCK_DIR, 'secrets.local.json'), '{}');
      vol.mkdirSync(join(TEST_TUCK_DIR, 'backups'), { recursive: true });

      await stageAll(TEST_TUCK_DIR);

      expect(mockGitInstance.raw).toHaveBeenCalledWith(['add', '--all', '--', 'README.md']);
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
    }, 30000); // Longer timeout for Windows CI

    it('should push with options', async () => {
      await expect(
        push(TEST_TUCK_DIR, { remote: 'origin', branch: 'main', setUpstream: true })
      ).resolves.not.toThrow();
    }, 30000); // Longer timeout for Windows CI

    it('does not run gh auth setup-git when the remote is a non-github (gitlab) remote', async () => {
      mockGitInstance.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'https://gitlab.com/user/repo.git', push: '' } },
      ]);

      await push(TEST_TUCK_DIR);

      // gh must never be invoked for a GitLab remote — running `gh auth
      // setup-git` would rewrite the user's GLOBAL github.com credential routing.
      const ghCalls = execFileMock.mock.calls.filter((call) => call[0] === 'gh');
      expect(ghCalls).toHaveLength(0);
    });

    it('does not run gh auth setup-git for an SSH github remote', async () => {
      mockGitInstance.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'git@github.com:user/repo.git', push: '' } },
      ]);

      await push(TEST_TUCK_DIR);

      const ghCalls = execFileMock.mock.calls.filter((call) => call[0] === 'gh');
      expect(ghCalls).toHaveLength(0);
    });

    it('runs gh auth setup-git only for an HTTPS github.com remote when gh is logged in', async () => {
      mockGitInstance.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'https://github.com/user/repo.git', push: '' } },
      ]);
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'auth' && args[1] === 'status') {
          callback?.(null, { stdout: '', stderr: 'Logged in to github.com as user' });
          return;
        }
        callback?.(null, { stdout: '', stderr: '' });
      });

      await push(TEST_TUCK_DIR);

      const setupGitCalls = execFileMock.mock.calls.filter(
        (call) => call[0] === 'gh' && Array.isArray(call[1]) && call[1][1] === 'setup-git'
      );
      expect(setupGitCalls).toHaveLength(1);
    });
  });

  describe('stageAll conflict guard', () => {
    it('refuses to stage while merge conflicts are unresolved', async () => {
      mockGitInstance.status.mockResolvedValue({
        current: 'main',
        conflicted: ['.zshrc'],
        staged: [],
        modified: [],
        not_added: [],
        deleted: [],
        isClean: () => false,
      });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.zshrc'), '<<<<<<< HEAD');

      await expect(stageAll(TEST_TUCK_DIR)).rejects.toMatchObject({ code: 'GIT_ERROR' });
      // Must never `git add --all` over the marker-corrupted file.
      expect(mockGitInstance.raw).not.toHaveBeenCalledWith(
        expect.arrayContaining(['add', '--all'])
      );
    });
  });

  describe('countCommitsBehindRemote', () => {
    it('returns the rev-list count of commits behind the remote branch', async () => {
      mockGitInstance.raw.mockResolvedValue('3\n');

      const behind = await countCommitsBehindRemote(TEST_TUCK_DIR, 'main');

      expect(behind).toBe(3);
      expect(mockGitInstance.raw).toHaveBeenCalledWith([
        'rev-list',
        '--count',
        'HEAD..origin/main',
      ]);
    });

    it('returns null when the remote branch does not exist', async () => {
      mockGitInstance.raw.mockRejectedValue(new Error('unknown revision'));

      const behind = await countCommitsBehindRemote(TEST_TUCK_DIR, 'main');

      expect(behind).toBeNull();
    });
  });

  describe('pull', () => {
    it('should pull from remote', async () => {
      await expect(pull(TEST_TUCK_DIR)).resolves.not.toThrow();
    }, 30000); // Longer timeout for Windows CI

    it('should pull with rebase option', async () => {
      await expect(pull(TEST_TUCK_DIR, { rebase: true })).resolves.not.toThrow();
    }, 30000); // Longer timeout for Windows CI
  });

  describe('fetch', () => {
    it('should fetch from remote', async () => {
      await expect(fetch(TEST_TUCK_DIR)).resolves.not.toThrow();
    }, 30000); // Longer timeout for Windows CI

    it('should fetch from specific remote', async () => {
      await expect(fetch(TEST_TUCK_DIR, 'origin')).resolves.not.toThrow();
    }, 30000); // Longer timeout for Windows CI
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
      await getLog(TEST_TUCK_DIR, { maxCount: 5 });
      // The maxCount must be forwarded to git.log, not silently dropped.
      expect(mockGitInstance.log).toHaveBeenCalledWith(
        expect.objectContaining({ maxCount: 5 })
      );
    });

    it('should pass --since to git log when requested', async () => {
      await getLog(TEST_TUCK_DIR, { since: '2024-01-01' });

      expect(mockGitInstance.log).toHaveBeenCalledWith({
        maxCount: 10,
        '--since': '2024-01-01',
      });
    });
  });

  describe('getDiff', () => {
    it('should return diff output', async () => {
      const diff = await getDiff(TEST_TUCK_DIR);
      expect(typeof diff).toBe('string');
    });

    it('should support staged option', async () => {
      await getDiff(TEST_TUCK_DIR, { staged: true });
      // --staged must reach git.diff, otherwise a staged diff silently becomes
      // a working-tree diff.
      expect(mockGitInstance.diff).toHaveBeenCalledWith(
        expect.arrayContaining(['--staged'])
      );
    });

    it('should support stat option', async () => {
      await getDiff(TEST_TUCK_DIR, { stat: true });
      expect(mockGitInstance.diff).toHaveBeenCalledWith(
        expect.arrayContaining(['--stat'])
      );
    });

    it('should support files option', async () => {
      await getDiff(TEST_TUCK_DIR, { files: ['file1.txt'] });
      // Files must be forwarded after the `--` separator so git scopes the diff.
      expect(mockGitInstance.diff).toHaveBeenCalledWith(
        expect.arrayContaining(['--', 'file1.txt'])
      );
    });
  });
});
