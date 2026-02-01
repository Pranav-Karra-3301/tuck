/**
 * Config module unit tests
 *
 * Tests for configuration loading, saving, and caching.
 * Note: These tests use the actual file system mocking from setup.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

// Mock the config module dependencies
vi.mock('../../src/lib/paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/paths.js')>();
  return {
    ...original,
    getTuckDir: () => TEST_TUCK_DIR,
    getConfigPath: (dir: string) => join(dir, 'config.json'),
    pathExists: async (path: string) => {
      try {
        vol.statSync(path);
        return true;
      } catch {
        return false;
      }
    },
  };
});

// Mock cosmiconfig to avoid filesystem issues
vi.mock('cosmiconfig', () => ({
  cosmiconfig: () => ({
    search: async () => null,
  }),
}));

// Import after mocking
import { clearConfigCache } from '../../src/lib/config.js';
import { defaultConfig } from '../../src/schemas/config.schema.js';

describe('config', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    // Clear cache before each test
    clearConfigCache();
    vi.resetModules();
  });

  afterEach(() => {
    vol.reset();
    clearConfigCache();
  });

  // ============================================================================
  // Default Config Tests
  // ============================================================================

  describe('defaultConfig', () => {
    it('should have expected default values', () => {
      expect(defaultConfig.repository.defaultBranch).toBe('main');
      expect(defaultConfig.repository.autoCommit).toBe(true);
      expect(defaultConfig.repository.autoPush).toBe(false);
    });

    it('should have default files config', () => {
      expect(defaultConfig.files.strategy).toBe('copy');
      expect(defaultConfig.files.backupOnRestore).toBe(true);
    });

    it('should have empty hooks by default', () => {
      expect(defaultConfig.hooks).toBeDefined();
      expect(defaultConfig.hooks.preSync).toBeUndefined();
      expect(defaultConfig.hooks.postSync).toBeUndefined();
    });

    it('should have security defaults', () => {
      expect(defaultConfig.security.scanSecrets).toBe(true);
      expect(defaultConfig.security.blockOnSecrets).toBe(true);
    });

    it('should have templates disabled by default', () => {
      expect(defaultConfig.templates.enabled).toBe(false);
    });

    it('should have encryption disabled by default', () => {
      expect(defaultConfig.encryption.enabled).toBe(false);
    });
  });

  // ============================================================================
  // clearConfigCache Tests
  // ============================================================================

  describe('clearConfigCache', () => {
    it('should not throw when called', () => {
      expect(() => clearConfigCache()).not.toThrow();
    });

    it('should be idempotent', () => {
      clearConfigCache();
      clearConfigCache();
      clearConfigCache();
      // Should not throw on multiple calls
      expect(true).toBe(true);
    });
  });

  // ============================================================================
  // Config Schema Validation Tests
  // ============================================================================

  describe('config schema', () => {
    it('should have valid structure', () => {
      expect(defaultConfig).toHaveProperty('repository');
      expect(defaultConfig).toHaveProperty('files');
      expect(defaultConfig).toHaveProperty('hooks');
      expect(defaultConfig).toHaveProperty('templates');
      expect(defaultConfig).toHaveProperty('encryption');
      expect(defaultConfig).toHaveProperty('ui');
      expect(defaultConfig).toHaveProperty('security');
      expect(defaultConfig).toHaveProperty('remote');
    });

    it('should have correct remote defaults', () => {
      expect(defaultConfig.remote.mode).toBe('local');
    });

    it('should have correct UI defaults', () => {
      expect(defaultConfig.ui.colors).toBe(true);
      expect(defaultConfig.ui.emoji).toBe(true);
      expect(defaultConfig.ui.verbose).toBe(false);
    });
  });
});
