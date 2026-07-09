/**
 * Hooks module unit tests
 *
 * Tests for pre/post hook execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { TEST_TUCK_DIR } from '../setup.js';

// Mock child_process so hook commands never spawn a real shell (and never fail
// because the memfs tuckDir has no real on-disk cwd). promisify(exec) wraps the
// callback-style mock: callback(null, value) resolves to `value`, and runHook
// destructures `{ stdout, stderr }` from it.
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('child_process', () => ({
  exec: execMock,
  execSync: vi.fn(),
}));

// Mock the config module
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock the UI modules
vi.mock('../../src/ui/logger.js', () => ({
  logger: {
    dim: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/ui/prompts.js', () => ({
  prompts: {
    confirm: vi.fn().mockResolvedValue(true),
  },
}));

// Import after mocking
import {
  runHook,
  runPreSyncHook,
  runPostSyncHook,
  runPreRestoreHook,
  runPostRestoreHook,
  hasHook,
} from '../../src/lib/hooks.js';
import { loadConfig } from '../../src/lib/config.js';
import { prompts } from '../../src/ui/prompts.js';
import { setNonInteractive } from '../../src/lib/agentMode.js';

describe('hooks', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    vi.clearAllMocks();
    // Default: hook command "succeeds" and returns sentinel stdout.
    execMock.mockImplementation((_cmd, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      callback?.(null, { stdout: 'hook-ran\n', stderr: '' });
    });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // runHook Tests
  // ============================================================================

  describe('runHook', () => {
    it('should skip hook if skipHooks option is true', async () => {
      const result = await runHook('preSync', TEST_TUCK_DIR, { skipHooks: true });

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it('should return success if no hook is configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await runHook('preSync', TEST_TUCK_DIR, { trustHooks: true });

      expect(result.success).toBe(true);
      expect(result.skipped).toBeUndefined();
    });

    it('should execute hook command with trustHooks option', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {
          preSync: 'echo "test"',
        },
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await runHook('preSync', TEST_TUCK_DIR, {
        trustHooks: true,
        silent: true,
      });

      // The trusted+configured hook must actually run: exec invoked with the
      // configured command, and the result carries success + the exec stdout,
      // not the skip path.
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock).toHaveBeenCalledWith(
        'echo "test"',
        expect.objectContaining({ env: expect.objectContaining({ TUCK_HOOK: 'preSync' }) }),
        expect.any(Function)
      );
      expect(result.success).toBe(true);
      expect(result.skipped).toBeUndefined();
      expect(result.output).toBe('hook-ran\n');
    });

    it('should skip an untrusted hook when stdin is not a TTY even if stdout is', async () => {
      // Regression: interactivity was decided from stdout only, so with a
      // non-TTY stdin (e.g. `tuck sync < /dev/null`) runHook tried to prompt
      // and ensureInteractive() aborted the whole command instead of skipping.
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: { preSync: 'echo "test"' },
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      } as never);

      const origStdout = process.stdout.isTTY;
      const origStdin = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = false;
      try {
        const result = await runHook('preSync', TEST_TUCK_DIR, { silent: true });
        expect(result.success).toBe(true);
        expect(result.skipped).toBe(true);
        // Must take the skip path, never attempt a prompt on a non-TTY stdin.
        expect(prompts.confirm).not.toHaveBeenCalled();
      } finally {
        process.stdout.isTTY = origStdout;
        process.stdin.isTTY = origStdin;
      }
    });

    it('skips an untrusted hook under --non-interactive even on a full TTY', async () => {
      // Regression (finding 7): the gate read isJsonMode()/TTY only and ignored
      // the explicit --non-interactive flag. On a PTY (both std streams TTY),
      // `tuck sync --non-interactive` with a configured hook then hit the prompt
      // and died OPERATION_CANCELLED instead of skipping with a warning.
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: { preSync: 'echo "test"' },
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      } as never);

      const origStdout = process.stdout.isTTY;
      const origStdin = process.stdin.isTTY;
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      setNonInteractive(true);
      try {
        const result = await runHook('preSync', TEST_TUCK_DIR, { silent: true });
        expect(result.success).toBe(true);
        expect(result.skipped).toBe(true);
        // The flag alone must force the skip path — never a prompt.
        expect(prompts.confirm).not.toHaveBeenCalled();
      } finally {
        setNonInteractive(false);
        process.stdout.isTTY = origStdout;
        process.stdin.isTTY = origStdin;
      }
    });
  });

  // ============================================================================
  // Hook Helper Functions Tests
  // ============================================================================

  // Each wrapper must forward its OWN hook type to runHook. We configure a
  // DISTINCT command per type, run trusted+silent so the mocked exec fires, and
  // assert the executed command + TUCK_HOOK env are the ones for that wrapper —
  // so a wrapper that forwarded the wrong type (e.g. runPreSyncHook →
  // 'postSync') would execute the wrong command and fail.
  const mockAllHooks = () => {
    vi.mocked(loadConfig).mockResolvedValue({
      repository: { path: TEST_TUCK_DIR },
      files: { backupDir: 'backups', symlink: false },
      hooks: {
        preSync: 'echo PRESYNC',
        postSync: 'echo POSTSYNC',
        preRestore: 'echo PRERESTORE',
        postRestore: 'echo POSTRESTORE',
      },
      templates: {},
      encryption: {},
      ui: { color: true, verbose: false },
    } as never);
  };

  const expectHookForwarded = (command: string, hookType: string) => {
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ env: expect.objectContaining({ TUCK_HOOK: hookType }) }),
      expect.any(Function)
    );
  };

  describe('runPreSyncHook', () => {
    it('should call runHook with preSync type', async () => {
      mockAllHooks();

      const result = await runPreSyncHook(TEST_TUCK_DIR, { trustHooks: true, silent: true });

      expect(result.success).toBe(true);
      expectHookForwarded('echo PRESYNC', 'preSync');
    });
  });

  describe('runPostSyncHook', () => {
    it('should call runHook with postSync type', async () => {
      mockAllHooks();

      const result = await runPostSyncHook(TEST_TUCK_DIR, { trustHooks: true, silent: true });

      expect(result.success).toBe(true);
      expectHookForwarded('echo POSTSYNC', 'postSync');
    });
  });

  describe('runPreRestoreHook', () => {
    it('should call runHook with preRestore type', async () => {
      mockAllHooks();

      const result = await runPreRestoreHook(TEST_TUCK_DIR, { trustHooks: true, silent: true });

      expect(result.success).toBe(true);
      expectHookForwarded('echo PRERESTORE', 'preRestore');
    });
  });

  describe('runPostRestoreHook', () => {
    it('should call runHook with postRestore type', async () => {
      mockAllHooks();

      const result = await runPostRestoreHook(TEST_TUCK_DIR, { trustHooks: true, silent: true });

      expect(result.success).toBe(true);
      expectHookForwarded('echo POSTRESTORE', 'postRestore');
    });
  });

  // ============================================================================
  // hasHook Tests
  // ============================================================================

  describe('hasHook', () => {
    it('should return true when hook is configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {
          preSync: 'echo "pre-sync"',
        },
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await hasHook('preSync', TEST_TUCK_DIR);

      expect(result).toBe(true);
    });

    it('should return false when hook is not configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await hasHook('preSync', TEST_TUCK_DIR);

      expect(result).toBe(false);
    });
  });

});
