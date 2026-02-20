import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_BACKUPS_DIR, TEST_TUCK_DIR } from '../utils/testHelpers.js';
import {
  createBackup,
  createMultipleBackups,
  listBackups,
  getBackupsByDate,
  restoreBackup,
  deleteBackup,
  cleanOldBackups,
  getBackupSize,
} from '../../src/lib/backup.js';
import { clearConfigCache } from '../../src/lib/config.js';

describe('backup', () => {
  beforeEach(() => {
    vol.reset();
    clearConfigCache();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_BACKUPS_DIR, { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearConfigCache();
    vol.reset();
  });

  it('creates a backup for a file and returns metadata', async () => {
    const sourcePath = join(TEST_HOME, '.zshrc');
    vol.writeFileSync(sourcePath, 'export PATH=/usr/local/bin');

    const result = await createBackup(sourcePath);

    expect(result.originalPath).toBe(sourcePath);
    expect(result.backupPath.replace(/\\/g, '/')).toContain('/.tuck-backups/2026-02-11/');
    expect(vol.existsSync(result.backupPath)).toBe(true);
    expect(vol.readFileSync(result.backupPath, 'utf-8')).toBe('export PATH=/usr/local/bin');
  });

  it('throws when source path does not exist', async () => {
    await expect(createBackup(join(TEST_HOME, '.missing'))).rejects.toThrow(
      'Source path does not exist'
    );
  });

  it('uses configured files.backupDir when present', async () => {
    const sourcePath = join(TEST_HOME, '.zshrc');
    vol.writeFileSync(sourcePath, 'backup me');
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    vol.writeFileSync(
      join(TEST_TUCK_DIR, '.tuckrc.json'),
      JSON.stringify({
        files: {
          backupDir: '~/.custom-backups',
        },
      })
    );

    const result = await createBackup(sourcePath);

    expect(result.backupPath.replace(/\\/g, '/')).toContain('/.custom-backups/2026-02-11/');
    expect(vol.existsSync(result.backupPath)).toBe(true);
  });

  it('creates multiple backups in one call', async () => {
    const sourceA = join(TEST_HOME, '.zshrc');
    const sourceB = join(TEST_HOME, '.gitconfig');
    vol.writeFileSync(sourceA, 'zsh');
    vol.writeFileSync(sourceB, 'git');

    const results = await createMultipleBackups([sourceA, sourceB]);

    expect(results).toHaveLength(2);
    expect(vol.existsSync(results[0].backupPath)).toBe(true);
    expect(vol.existsSync(results[1].backupPath)).toBe(true);
  });

  it('lists backups sorted by newest date first', async () => {
    const oldDir = join(TEST_BACKUPS_DIR, '2026-02-09');
    const newDir = join(TEST_BACKUPS_DIR, '2026-02-11');
    vol.mkdirSync(oldDir, { recursive: true });
    vol.mkdirSync(newDir, { recursive: true });
    vol.writeFileSync(join(oldDir, 'old_backup'), 'old');
    vol.writeFileSync(join(newDir, 'new_backup'), 'new');

    const backups = await listBackups();

    expect(backups).toHaveLength(2);
    expect(backups[0].path).toContain('2026-02-11');
    expect(backups[1].path).toContain('2026-02-09');
  });

  it('gets backups by date', async () => {
    const dateDir = join(TEST_BACKUPS_DIR, '2026-02-11');
    vol.mkdirSync(dateDir, { recursive: true });
    vol.writeFileSync(join(dateDir, 'zsh_backup'), 'content');

    const backups = await getBackupsByDate(new Date('2026-02-11T00:00:00.000Z'));

    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain('zsh_backup');
  });

  it('restores from backup and creates a pre-restore snapshot', async () => {
    const targetPath = join(TEST_HOME, '.zshrc');
    const backupPath = join(TEST_BACKUPS_DIR, 'restore_source');
    vol.writeFileSync(targetPath, 'current value');
    vol.writeFileSync(backupPath, 'restored value');

    await restoreBackup(backupPath, targetPath);

    expect(vol.readFileSync(targetPath, 'utf-8')).toBe('restored value');

    const datedDir = join(TEST_BACKUPS_DIR, '2026-02-11');
    const snapshots = vol.existsSync(datedDir) ? vol.readdirSync(datedDir) : [];
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('deletes a backup path when requested', async () => {
    const backupPath = join(TEST_BACKUPS_DIR, 'to_delete');
    vol.writeFileSync(backupPath, 'temp');
    expect(vol.existsSync(backupPath)).toBe(true);

    await deleteBackup(backupPath);

    expect(vol.existsSync(backupPath)).toBe(false);
  });

  it('cleans old backups based on retention window', async () => {
    const oldDir = join(TEST_BACKUPS_DIR, '2026-01-01');
    const recentDir = join(TEST_BACKUPS_DIR, '2026-02-10');
    vol.mkdirSync(oldDir, { recursive: true });
    vol.mkdirSync(recentDir, { recursive: true });
    vol.writeFileSync(join(oldDir, 'old.txt'), 'old');
    vol.writeFileSync(join(recentDir, 'new.txt'), 'new');

    const deleted = await cleanOldBackups(7);

    expect(deleted).toBe(1);
    expect(vol.existsSync(oldDir)).toBe(false);
    expect(vol.existsSync(recentDir)).toBe(true);
  });

  it('calculates total backup size', async () => {
    const dateDir = join(TEST_BACKUPS_DIR, '2026-02-11');
    vol.mkdirSync(dateDir, { recursive: true });
    vol.writeFileSync(join(dateDir, 'a.txt'), 'a'.repeat(10));
    vol.writeFileSync(join(dateDir, 'b.txt'), 'b'.repeat(20));

    const size = await getBackupSize();

    expect(size).toBe(30);
  });
});
