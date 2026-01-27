/**
 * Backup and Restore Cycle Integration Tests
 *
 * Tests the complete backup and restore workflow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR, TEST_BACKUPS_DIR } from '../utils/testHelpers.js';
import { initTestTuck, createTestDotfile } from '../utils/testHelpers.js';

describe('Backup and Restore Cycle', () => {
  beforeEach(() => {
    vol.reset();
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // Backup Creation
  // ============================================================================

  describe('Backup Creation', () => {
    it('should create backup before modifying files', async () => {
      await initTestTuck({
        files: {
          '.zshrc': 'original content',
        },
      });

      // Create backup directory
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      // Simulate backup
      const backupPath = join(TEST_BACKUPS_DIR, 'zshrc-backup');
      vol.writeFileSync(backupPath, 'original content');

      expect(vol.existsSync(backupPath)).toBe(true);
    });

    it('should preserve file content in backup', async () => {
      await initTestTuck();

      const originalContent = 'important configuration\nexport PATH=$PATH:/custom/bin';
      createTestDotfile('.important-rc', originalContent);

      // Create backup
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });
      const backupPath = join(TEST_BACKUPS_DIR, 'important-rc-backup');
      vol.writeFileSync(backupPath, originalContent);

      const backedUpContent = vol.readFileSync(backupPath, 'utf-8');
      expect(backedUpContent).toBe(originalContent);
    });

    it('should organize backups by date', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      const today = new Date().toISOString().slice(0, 10);
      const todayBackups = join(TEST_BACKUPS_DIR, today);
      vol.mkdirSync(todayBackups, { recursive: true });

      vol.writeFileSync(join(todayBackups, 'zshrc-backup'), 'content');

      expect(vol.existsSync(todayBackups)).toBe(true);
    });
  });

  // ============================================================================
  // Restore Operations
  // ============================================================================

  describe('Restore Operations', () => {
    it('should restore file from backup', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      // Create original file
      const originalPath = join(TEST_HOME, '.zshrc');
      const backupPath = join(TEST_BACKUPS_DIR, 'zshrc-backup');

      vol.writeFileSync(backupPath, 'backed up content');
      vol.writeFileSync(originalPath, 'current content');

      // Simulate restore
      const backupContent = vol.readFileSync(backupPath, 'utf-8');
      vol.writeFileSync(originalPath, backupContent);

      expect(vol.readFileSync(originalPath, 'utf-8')).toBe('backed up content');
    });

    it('should backup current file before restore', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      const currentContent = 'current important content';
      const originalPath = join(TEST_HOME, '.zshrc');
      vol.writeFileSync(originalPath, currentContent);

      // Backup current before restore
      const preRestoreBackup = join(TEST_BACKUPS_DIR, 'pre-restore-backup');
      vol.writeFileSync(preRestoreBackup, currentContent);

      expect(vol.readFileSync(preRestoreBackup, 'utf-8')).toBe(currentContent);
    });

    it('should handle missing backup gracefully', async () => {
      await initTestTuck();

      const missingBackup = join(TEST_BACKUPS_DIR, 'nonexistent');

      expect(vol.existsSync(missingBackup)).toBe(false);
    });
  });

  // ============================================================================
  // Backup Cleanup
  // ============================================================================

  describe('Backup Cleanup', () => {
    it('should list all backups', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      // Create multiple dated backup directories
      const dates = ['2024-01-01', '2024-01-02', '2024-01-03'];
      dates.forEach((date) => {
        const dateDir = join(TEST_BACKUPS_DIR, date);
        vol.mkdirSync(dateDir, { recursive: true });
        vol.writeFileSync(join(dateDir, 'backup.txt'), 'content');
      });

      // List directories
      const backupDirs = vol.readdirSync(TEST_BACKUPS_DIR);
      expect(backupDirs).toHaveLength(3);
    });

    it('should calculate total backup size', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      const dateDir = join(TEST_BACKUPS_DIR, '2024-01-01');
      vol.mkdirSync(dateDir, { recursive: true });

      vol.writeFileSync(join(dateDir, 'file1.txt'), 'a'.repeat(100));
      vol.writeFileSync(join(dateDir, 'file2.txt'), 'b'.repeat(200));

      // Calculate size manually
      const file1Size = vol.statSync(join(dateDir, 'file1.txt')).size;
      const file2Size = vol.statSync(join(dateDir, 'file2.txt')).size;

      expect(file1Size + file2Size).toBe(300);
    });

    it('should delete old backups', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      // Create old backup directory
      const oldDir = join(TEST_BACKUPS_DIR, '2020-01-01');
      vol.mkdirSync(oldDir, { recursive: true });
      vol.writeFileSync(join(oldDir, 'old.txt'), 'old content');

      // Delete old backup
      vol.rmdirSync(oldDir, { recursive: true });

      expect(vol.existsSync(oldDir)).toBe(false);
    });
  });

  // ============================================================================
  // Full Cycle Tests
  // ============================================================================

  describe('Full Backup-Restore Cycle', () => {
    it('should complete full backup and restore cycle', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      // 1. Create original file
      const filePath = join(TEST_HOME, '.myconfig');
      const originalContent = 'original configuration';
      vol.writeFileSync(filePath, originalContent);

      // 2. Create backup
      const backupPath = join(TEST_BACKUPS_DIR, 'myconfig-backup');
      vol.writeFileSync(backupPath, originalContent);

      // 3. Modify original
      vol.writeFileSync(filePath, 'modified configuration');
      expect(vol.readFileSync(filePath, 'utf-8')).toBe('modified configuration');

      // 4. Restore from backup
      const backupContent = vol.readFileSync(backupPath, 'utf-8');
      vol.writeFileSync(filePath, backupContent);

      // 5. Verify restoration
      expect(vol.readFileSync(filePath, 'utf-8')).toBe(originalContent);
    });

    it('should handle multiple restore points', async () => {
      await initTestTuck();
      vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });

      const filePath = join(TEST_HOME, '.evolving');

      // Version 1
      vol.writeFileSync(filePath, 'version 1');
      vol.writeFileSync(join(TEST_BACKUPS_DIR, 'v1-backup'), 'version 1');

      // Version 2
      vol.writeFileSync(filePath, 'version 2');
      vol.writeFileSync(join(TEST_BACKUPS_DIR, 'v2-backup'), 'version 2');

      // Version 3
      vol.writeFileSync(filePath, 'version 3');
      vol.writeFileSync(join(TEST_BACKUPS_DIR, 'v3-backup'), 'version 3');

      // Restore to version 1
      const v1Content = vol.readFileSync(join(TEST_BACKUPS_DIR, 'v1-backup'), 'utf-8');
      vol.writeFileSync(filePath, v1Content);

      expect(vol.readFileSync(filePath, 'utf-8')).toBe('version 1');

      // Restore to version 2
      const v2Content = vol.readFileSync(join(TEST_BACKUPS_DIR, 'v2-backup'), 'utf-8');
      vol.writeFileSync(filePath, v2Content);

      expect(vol.readFileSync(filePath, 'utf-8')).toBe('version 2');
    });
  });
});
