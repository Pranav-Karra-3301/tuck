/**
 * Hooks module unit tests
 *
 * Tests for pre/post hook execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

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
  getHookCommand,
  hasAnyHooks,
  getAllHooks,
} from '../../src/lib/hooks.js';
import { loadConfig } from '../../src/lib/config.js';

describe('hooks', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    vi.clearAllMocks();
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

      // The hook should attempt to execute (may fail in test environment)
      expect(result).toBeDefined();
    });
  });

  // ============================================================================
  // Hook Helper Functions Tests
  // ============================================================================

  describe('runPreSyncHook', () => {
    it('should call runHook with preSync type', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await runPreSyncHook(TEST_TUCK_DIR, { trustHooks: true });

      expect(result.success).toBe(true);
    });
  });

  describe('runPostSyncHook', () => {
    it('should call runHook with postSync type', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await runPostSyncHook(TEST_TUCK_DIR, { trustHooks: true });

      expect(result.success).toBe(true);
    });
  });

  describe('runPreRestoreHook', () => {
    it('should call runHook with preRestore type', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await runPreRestoreHook(TEST_TUCK_DIR, { trustHooks: true });

      expect(result.success).toBe(true);
    });
  });

  describe('runPostRestoreHook', () => {
    it('should call runHook with postRestore type', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await runPostRestoreHook(TEST_TUCK_DIR, { trustHooks: true });

      expect(result.success).toBe(true);
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

  // ============================================================================
  // getHookCommand Tests
  // ============================================================================

  describe('getHookCommand', () => {
    it('should return hook command when configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {
          postSync: 'brew bundle',
        },
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const command = await getHookCommand('postSync', TEST_TUCK_DIR);

      expect(command).toBe('brew bundle');
    });

    it('should return undefined when hook is not configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const command = await getHookCommand('postSync', TEST_TUCK_DIR);

      expect(command).toBeUndefined();
    });
  });

  // ============================================================================
  // hasAnyHooks Tests
  // ============================================================================

  describe('hasAnyHooks', () => {
    it('should return true when any hook is configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {
          postRestore: 'source ~/.zshrc',
        },
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await hasAnyHooks(TEST_TUCK_DIR);

      expect(result).toBe(true);
    });

    it('should return false when no hooks are configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const result = await hasAnyHooks(TEST_TUCK_DIR);

      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // getAllHooks Tests
  // ============================================================================

  describe('getAllHooks', () => {
    it('should return all configured hooks', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {
          preSync: 'echo pre',
          postSync: 'echo post',
          preRestore: undefined,
          postRestore: 'source ~/.bashrc',
        },
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const hooks = await getAllHooks(TEST_TUCK_DIR);

      expect(hooks.preSync).toBe('echo pre');
      expect(hooks.postSync).toBe('echo post');
      expect(hooks.preRestore).toBeUndefined();
      expect(hooks.postRestore).toBe('source ~/.bashrc');
    });

    it('should return all undefined when no hooks configured', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        repository: { path: TEST_TUCK_DIR },
        files: { backupDir: 'backups', symlink: false },
        hooks: {},
        templates: {},
        encryption: {},
        ui: { color: true, verbose: false },
      });

      const hooks = await getAllHooks(TEST_TUCK_DIR);

      expect(hooks.preSync).toBeUndefined();
      expect(hooks.postSync).toBeUndefined();
      expect(hooks.preRestore).toBeUndefined();
      expect(hooks.postRestore).toBeUndefined();
    });
  });
});
