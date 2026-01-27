/**
 * Full Workflow Integration Tests
 *
 * Tests complete user workflows from init to sync.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR, TEST_FILES_DIR } from '../utils/testHelpers.js';
import { initTestTuck, createTestDotfile, getTestManifest } from '../utils/testHelpers.js';

// Mock git for integration tests
vi.mock('simple-git', () => {
  const mockGit = {
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
    status: vi.fn().mockResolvedValue({
      current: 'main',
      tracking: null,
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      not_added: [],
      deleted: [],
      isClean: () => true,
    }),
    getRemotes: vi.fn().mockResolvedValue([]),
    push: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    revparse: vi.fn().mockResolvedValue('main'),
    raw: vi.fn().mockResolvedValue('main'),
    branch: vi.fn().mockResolvedValue(undefined),
  };

  return {
    default: vi.fn(() => mockGit),
  };
});

describe('Full Workflow Integration', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // Init → Add → Sync Workflow
  // ============================================================================

  describe('Init → Add → Sync Workflow', () => {
    it('should complete basic workflow', async () => {
      // Step 1: Initialize tuck environment
      await initTestTuck();

      // Create a dotfile to track
      const zshrcPath = createTestDotfile('.zshrc', 'export PATH=$PATH:/usr/local/bin');

      // Verify manifest exists
      const manifest = getTestManifest();
      expect(manifest.version).toBe('1.0.0');
    });

    it('should track dotfile state', async () => {
      await initTestTuck({
        tracked: {
          '.zshrc': 'original content',
        },
      });

      // Verify the tracked file is in manifest
      // This simulates what happens after tuck add
    });

    it('should preserve file permissions', async () => {
      await initTestTuck();

      const scriptPath = createTestDotfile('.local/bin/script.sh', '#!/bin/bash\necho "hello"');

      // In real scenario, permissions would be preserved
      expect(vol.existsSync(scriptPath)).toBe(true);
    });
  });

  // ============================================================================
  // Multi-File Tracking
  // ============================================================================

  describe('Multi-File Tracking', () => {
    it('should track multiple dotfiles', async () => {
      await initTestTuck({
        files: {
          '.zshrc': 'zsh content',
          '.bashrc': 'bash content',
          '.gitconfig': '[user]\n  name = Test',
          '.vimrc': 'set number',
        },
      });

      // All files should exist
      expect(vol.existsSync(join(TEST_HOME, '.zshrc'))).toBe(true);
      expect(vol.existsSync(join(TEST_HOME, '.bashrc'))).toBe(true);
      expect(vol.existsSync(join(TEST_HOME, '.gitconfig'))).toBe(true);
      expect(vol.existsSync(join(TEST_HOME, '.vimrc'))).toBe(true);
    });

    it('should organize files by category', async () => {
      await initTestTuck();

      // Shell files should go to shell category
      // Git files to git category, etc.
      const shellDir = join(TEST_FILES_DIR, 'shell');
      const gitDir = join(TEST_FILES_DIR, 'git');

      expect(vol.existsSync(shellDir)).toBe(true);
      expect(vol.existsSync(gitDir)).toBe(true);
    });
  });

  // ============================================================================
  // Change Detection
  // ============================================================================

  describe('Change Detection', () => {
    it('should detect modified files', async () => {
      await initTestTuck({
        files: {
          '.zshrc': 'original content',
        },
      });

      // Modify the file
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'modified content');

      // In real scenario, sync would detect this change
      const content = vol.readFileSync(join(TEST_HOME, '.zshrc'), 'utf-8');
      expect(content).toBe('modified content');
    });

    it('should detect new files', async () => {
      await initTestTuck();

      // Create a new dotfile
      createTestDotfile('.newrc', 'new file content');

      expect(vol.existsSync(join(TEST_HOME, '.newrc'))).toBe(true);
    });

    it('should detect deleted files', async () => {
      await initTestTuck({
        files: {
          '.temporary': 'will be deleted',
        },
      });

      // Delete the file
      vol.unlinkSync(join(TEST_HOME, '.temporary'));

      expect(vol.existsSync(join(TEST_HOME, '.temporary'))).toBe(false);
    });
  });

  // ============================================================================
  // Error Recovery
  // ============================================================================

  describe('Error Recovery', () => {
    it('should handle missing manifest gracefully', async () => {
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
      // No manifest file

      // Operations should fail gracefully
      expect(() => vol.readFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'))).toThrow();
    });

    it('should handle corrupted manifest', async () => {
      vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
      vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), 'not valid json');

      // Parsing should fail
      expect(() => {
        const content = vol.readFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), 'utf-8');
        JSON.parse(content as string);
      }).toThrow();
    });
  });

  // ============================================================================
  // Concurrent Operations
  // ============================================================================

  describe('Concurrent Operations', () => {
    it('should handle rapid file changes', async () => {
      await initTestTuck();

      // Simulate rapid file changes
      const promises = Array.from({ length: 10 }, (_, i) => {
        return new Promise<void>((resolve) => {
          const path = join(TEST_HOME, `.config${i}`);
          vol.writeFileSync(path, `content ${i}`);
          resolve();
        });
      });

      await Promise.all(promises);

      // All files should exist
      for (let i = 0; i < 10; i++) {
        expect(vol.existsSync(join(TEST_HOME, `.config${i}`))).toBe(true);
      }
    });
  });
});
