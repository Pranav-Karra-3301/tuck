/**
 * Time Machine (snapshot/backup) module unit tests
 *
 * Tests for snapshot creation, listing, and restoration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME } from '../setup.js';

// Mock fs-extra pathExists to use memfs
vi.mock('fs-extra', async () => {
  const { join, dirname } = await import('path');
  return {
    pathExists: async (path: string) => {
      const { vol } = await import('memfs');
      try {
        vol.statSync(path);
        return true;
      } catch {
        return false;
      }
    },
    ensureDir: async (dir: string) => {
      const { vol } = await import('memfs');
      vol.mkdirSync(dir, { recursive: true });
    },
    copy: async (
      src: string,
      dest: string,
      _options?: { overwrite?: boolean; preserveTimestamps?: boolean }
    ) => {
      const { vol } = await import('memfs');
      const copyRecursive = async (source: string, destination: string) => {
        const srcStats = vol.statSync(source);
        if (srcStats.isDirectory()) {
          vol.mkdirSync(destination, { recursive: true });
          const entries = vol.readdirSync(source);
          for (const entry of entries) {
            const srcPath = join(source, entry as string);
            const destPath = join(destination, entry as string);
            await copyRecursive(srcPath, destPath);
          }
        } else {
          vol.mkdirSync(dirname(destination), { recursive: true });
          vol.writeFileSync(destination, vol.readFileSync(source));
        }
      };
      await copyRecursive(src, dest);
    },
  };
});

// Import after mocking
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  getLatestSnapshot,
  restoreSnapshot,
  restoreFileFromSnapshot,
  deleteSnapshot,
  formatSnapshotSize,
  formatSnapshotDate,
} from '../../src/lib/timemachine.js';

describe('timemachine', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(join(TEST_HOME, '.tuck'), { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // createSnapshot Tests
  // ============================================================================

  describe('createSnapshot', () => {
    it('should create a snapshot with metadata', async () => {
      // Create a test file
      const testFile = join(TEST_HOME, '.zshrc');
      vol.writeFileSync(testFile, 'export PATH=$PATH:/usr/local/bin');

      const snapshot = await createSnapshot([testFile], 'Test backup');

      expect(snapshot.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);
      expect(snapshot.reason).toBe('Test backup');
      expect(snapshot.files.length).toBe(1);
    });

    it('should copy file contents to snapshot', async () => {
      const testFile = join(TEST_HOME, '.zshrc');
      const content = 'test content';
      vol.writeFileSync(testFile, content);

      const snapshot = await createSnapshot([testFile], 'Backup');

      // Verify the backup file exists and has correct content
      const backupPath = snapshot.files[0].backupPath;
      expect(vol.existsSync(backupPath)).toBe(true);
      expect(vol.readFileSync(backupPath, 'utf-8')).toBe(content);
    });

    it('should mark non-existent files as not existing', async () => {
      const nonExistentFile = join(TEST_HOME, '.nonexistent');

      const snapshot = await createSnapshot([nonExistentFile], 'Backup');

      expect(snapshot.files[0].existed).toBe(false);
    });

    it('should create snapshot with multiple files', async () => {
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'zsh content');
      vol.writeFileSync(join(TEST_HOME, '.bashrc'), 'bash content');

      const snapshot = await createSnapshot(
        [join(TEST_HOME, '.zshrc'), join(TEST_HOME, '.bashrc')],
        'Multi-file backup'
      );

      expect(snapshot.files.length).toBe(2);
    });

    it('should always keep backup paths inside snapshot files directory', async () => {
      const nestedPath = join(TEST_HOME, '.config', 'nvim', 'init.lua');
      vol.mkdirSync(join(TEST_HOME, '.config', 'nvim'), { recursive: true });
      vol.writeFileSync(nestedPath, 'set number');

      const snapshot = await createSnapshot([nestedPath], 'Path safety');

      const backupPath = snapshot.files[0].backupPath.replace(/\\/g, '/');
      const expectedPrefix = join(snapshot.path, 'files').replace(/\\/g, '/');

      expect(backupPath.startsWith(expectedPrefix + '/')).toBe(true);
      expect(backupPath).toContain('/.config/nvim/init.lua');
    });

    it('should snapshot paths outside home under a reserved _external subtree when Y is out of home', async () => {
      // Repo-scoped files live in a checkout that can legitimately be outside
      // $HOME. Snapshotting them must NOT throw (that would brick a whole apply);
      // they are stored under _external/<hash>/ keyed by the absolute path, with
      // the live restore target preserved as originalPath.
      const outsidePath = process.platform === 'win32' ? 'C:\\work\\api\\.env' : '/opt/work/api/.env';
      vol.mkdirSync(process.platform === 'win32' ? 'C:\\work\\api' : '/opt/work/api', {
        recursive: true,
      });
      vol.writeFileSync(outsidePath, 'API_KEY=1');

      const snapshot = await createSnapshot([outsidePath], 'Out-of-home backup');

      expect(snapshot.files.length).toBe(1);
      expect(snapshot.files[0].existed).toBe(true);
      expect(snapshot.files[0].originalPath.replace(/\\/g, '/')).toContain('/work/api/.env');
      const backupPath = snapshot.files[0].backupPath.replace(/\\/g, '/');
      expect(backupPath).toContain('/files/_external/');
      expect(vol.readFileSync(snapshot.files[0].backupPath, 'utf-8')).toBe('API_KEY=1');
    });
  });

  // ============================================================================
  // listSnapshots Tests
  // ============================================================================

  describe('listSnapshots', () => {
    it('should return empty array when no snapshots exist', async () => {
      const snapshots = await listSnapshots();
      expect(snapshots).toEqual([]);
    });

    it('should list all snapshots', async () => {
      // Create some test files
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');

      // Create a snapshot
      await createSnapshot([join(TEST_HOME, '.zshrc')], 'First');

      const snapshots = await listSnapshots();

      expect(snapshots.length).toBeGreaterThanOrEqual(1);
    });

    it('should return snapshots with valid structure', async () => {
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');

      await createSnapshot([join(TEST_HOME, '.zshrc')], 'TestSnapshot');

      const snapshots = await listSnapshots();

      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0]).toHaveProperty('id');
      expect(snapshots[0]).toHaveProperty('reason');
      expect(snapshots[0]).toHaveProperty('timestamp');
    });
  });

  // ============================================================================
  // getSnapshot Tests
  // ============================================================================

  describe('getSnapshot', () => {
    it('should return null for non-existent snapshot', async () => {
      const snapshot = await getSnapshot('1999-01-01-000000');
      expect(snapshot).toBeNull();
    });

    it('should return snapshot by ID', async () => {
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');
      const created = await createSnapshot([join(TEST_HOME, '.zshrc')], 'Test');

      const retrieved = await getSnapshot(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.reason).toBe('Test');
    });
  });

  // ============================================================================
  // getLatestSnapshot Tests
  // ============================================================================

  describe('getLatestSnapshot', () => {
    it('should return null when no snapshots exist', async () => {
      const latest = await getLatestSnapshot();
      expect(latest).toBeNull();
    });

    it('should return the most recent snapshot', async () => {
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');

      await createSnapshot([join(TEST_HOME, '.zshrc')], 'First');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await createSnapshot([join(TEST_HOME, '.zshrc')], 'Second');

      const latest = await getLatestSnapshot();

      expect(latest?.reason).toBe('Second');
    });
  });

  // ============================================================================
  // restoreSnapshot Tests
  // ============================================================================

  describe('restoreSnapshot', () => {
    it('should throw for non-existent snapshot', async () => {
      await expect(restoreSnapshot('nonexistent-id')).rejects.toThrow(
        'Snapshot not found'
      );
    });

    it('should suggest the real `tuck undo --list` command (not the non-existent restore flag)', async () => {
      // The snapshot-not-found suggestion previously pointed at `tuck restore
      // --list`, a flag the restore command does not define.
      await expect(restoreSnapshot('nonexistent-id')).rejects.toMatchObject({
        suggestions: expect.arrayContaining([expect.stringContaining('tuck undo --list')]),
      });
    });

    it('should restore files from snapshot', async () => {
      const testFile = join(TEST_HOME, '.zshrc');
      vol.writeFileSync(testFile, 'original content');

      const snapshot = await createSnapshot([testFile], 'Before changes');

      // Modify the file
      vol.writeFileSync(testFile, 'modified content');

      // Restore
      const restored = await restoreSnapshot(snapshot.id);

      expect(restored.length).toBe(1);
      expect(vol.readFileSync(testFile, 'utf-8')).toBe('original content');
    });

    it('should delete files that did not exist before', async () => {
      const newFile = join(TEST_HOME, '.new-file');

      // Create snapshot when file doesn't exist
      const snapshot = await createSnapshot([newFile], 'Before file created');

      // Create the file
      vol.writeFileSync(newFile, 'new content');

      // Restore should delete the file
      await restoreSnapshot(snapshot.id);

      expect(vol.existsSync(newFile)).toBe(false);
    });

    it('takes a recoverable pre-undo snapshot before deleting valuable files', async () => {
      const file = join(TEST_HOME, '.later-created');

      // Snapshot taken when the file did NOT exist.
      const snapA = await createSnapshot([file], 'Before file existed');

      // User later creates valuable content at that path.
      vol.writeFileSync(file, 'valuable-user-data');

      // Undo (restore snapA) deletes the file...
      await restoreSnapshot(snapA.id);
      expect(vol.existsSync(file)).toBe(false);

      // ...but a pre-undo snapshot must have captured the valuable content,
      // and it must have a DISTINCT id from the snapshot being restored.
      const snaps = await listSnapshots();
      const preUndo = snaps.find((s) => s.reason.toLowerCase().includes('undo'));
      expect(preUndo).toBeTruthy();
      expect(preUndo!.id).not.toBe(snapA.id);

      // Restoring the pre-undo snapshot recovers the data (undo-of-undo).
      await restoreSnapshot(preUndo!.id);
      expect(vol.existsSync(file)).toBe(true);
      expect(vol.readFileSync(file, 'utf-8')).toBe('valuable-user-data');
    });
  });

  // ============================================================================
  // restoreFileFromSnapshot Tests
  // ============================================================================

  describe('restoreFileFromSnapshot', () => {
    it('should throw for non-existent snapshot', async () => {
      await expect(
        restoreFileFromSnapshot('nonexistent-id', '~/.zshrc')
      ).rejects.toThrow('Snapshot not found');
    });

    it('should throw for file not in snapshot', async () => {
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');
      const snapshot = await createSnapshot([join(TEST_HOME, '.zshrc')], 'Test');

      await expect(
        restoreFileFromSnapshot(snapshot.id, join(TEST_HOME, '.bashrc'))
      ).rejects.toThrow('File not found in snapshot');
    });

    it('should restore single file from snapshot', async () => {
      const testFile = join(TEST_HOME, '.zshrc');
      vol.writeFileSync(testFile, 'original');
      vol.writeFileSync(join(TEST_HOME, '.bashrc'), 'bash');

      const snapshot = await createSnapshot(
        [testFile, join(TEST_HOME, '.bashrc')],
        'Test'
      );

      // Modify both files
      vol.writeFileSync(testFile, 'modified zsh');
      vol.writeFileSync(join(TEST_HOME, '.bashrc'), 'modified bash');

      // Restore only zshrc
      await restoreFileFromSnapshot(snapshot.id, testFile);

      expect(vol.readFileSync(testFile, 'utf-8')).toBe('original');
      // bashrc should still be modified
      expect(vol.readFileSync(join(TEST_HOME, '.bashrc'), 'utf-8')).toBe('modified bash');
    });

    it('should capture a pre-undo backup of the current file before overwriting it', async () => {
      const testFile = join(TEST_HOME, '.zshrc');
      vol.writeFileSync(testFile, 'original');
      const snapshot = await createSnapshot([testFile], 'Test');

      vol.writeFileSync(testFile, 'live-edit-worth-keeping');

      await restoreFileFromSnapshot(snapshot.id, testFile);

      expect(vol.readFileSync(testFile, 'utf-8')).toBe('original');
      // The current-state pre-undo backup makes this undo itself reversible.
      const snapshots = await listSnapshots();
      const preUndo = snapshots.find((s) => s.reason.startsWith('Pre-undo backup before restoring'));
      expect(preUndo).toBeDefined();
      const captured = preUndo!.files.find((f) => f.originalPath === testFile);
      expect(captured?.existed).toBe(true);
      expect(vol.readFileSync(captured!.backupPath, 'utf-8')).toBe('live-edit-worth-keeping');
    });

    it('should back up a file recorded as non-existent before deleting it on undo', async () => {
      const nvimDir = join(TEST_HOME, '.config', 'nvim');
      const target = join(nvimDir, 'init.lua');

      // Snapshot the path while it does NOT exist → recorded existed:false.
      const snapshot = await createSnapshot([target], 'Pre-apply');
      expect(snapshot.files[0].existed).toBe(false);

      // The user then creates the file; undoing must not destroy it unrecoverably.
      vol.mkdirSync(nvimDir, { recursive: true });
      vol.writeFileSync(target, 'set number');

      await restoreFileFromSnapshot(snapshot.id, target);

      // The file is removed (returning to the pre-apply state)...
      expect(vol.existsSync(target)).toBe(false);
      // ...but a pre-undo backup preserved its contents for recovery.
      const snapshots = await listSnapshots();
      const preUndo = snapshots.find((s) => s.reason.startsWith('Pre-undo backup before restoring'));
      expect(preUndo).toBeDefined();
      const captured = preUndo!.files.find((f) => f.originalPath === target);
      expect(captured?.existed).toBe(true);
      expect(vol.readFileSync(captured!.backupPath, 'utf-8')).toBe('set number');
    });
  });

  // ============================================================================
  // deleteSnapshot Tests
  // ============================================================================

  describe('deleteSnapshot', () => {
    it('should delete a snapshot', async () => {
      vol.writeFileSync(join(TEST_HOME, '.zshrc'), 'content');
      const snapshot = await createSnapshot([join(TEST_HOME, '.zshrc')], 'Test');

      await deleteSnapshot(snapshot.id);

      const retrieved = await getSnapshot(snapshot.id);
      expect(retrieved).toBeNull();
    });

    it('should not throw for non-existent snapshot', async () => {
      await expect(deleteSnapshot('nonexistent')).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // formatSnapshotSize Tests
  // ============================================================================

  describe('formatSnapshotSize', () => {
    it('should format 0 bytes', () => {
      expect(formatSnapshotSize(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatSnapshotSize(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatSnapshotSize(1024)).toBe('1 KB');
    });

    it('should format megabytes', () => {
      expect(formatSnapshotSize(1048576)).toBe('1 MB');
    });

    it('should format gigabytes', () => {
      expect(formatSnapshotSize(1073741824)).toBe('1 GB');
    });
  });

  // ============================================================================
  // formatSnapshotDate Tests
  // ============================================================================

  describe('formatSnapshotDate', () => {
    it('should format valid snapshot ID to date string', () => {
      const result = formatSnapshotDate('2024-06-15-143022');
      // Result should be a locale string, just verify it's transformed
      expect(result).not.toBe('2024-06-15-143022');
    });

    it('should return original string for invalid format', () => {
      const result = formatSnapshotDate('invalid-id');
      expect(result).toBe('invalid-id');
    });
  });
});
