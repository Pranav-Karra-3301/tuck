import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_BACKUPS_DIR } from '../utils/testHelpers.js';
import { initTestTuck } from '../utils/testHelpers.js';
import {
  createBackup,
  restoreBackup,
  listBackups,
  cleanOldBackups,
  getBackupSize,
} from '../../src/lib/backup.js';

describe('Backup and Restore Cycle Integration', () => {
  beforeEach(() => {
    vol.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vol.reset();
  });

  it('creates and restores a backup for an actively edited dotfile', async () => {
    await initTestTuck();

    const sourcePath = join(TEST_HOME, '.zshrc');
    vol.writeFileSync(sourcePath, 'export PATH=$PATH:/original');

    const backup = await createBackup(sourcePath);
    vol.writeFileSync(sourcePath, 'export PATH=$PATH:/modified');
    vi.setSystemTime(new Date('2026-02-11T09:00:10.000Z'));

    await restoreBackup(backup.backupPath, sourcePath);

    expect(vol.readFileSync(sourcePath, 'utf-8')).toBe('export PATH=$PATH:/original');
  });

  it('surfaces backups through listing and size calculations', async () => {
    await initTestTuck();

    const sourcePath = join(TEST_HOME, '.gitconfig');
    vol.writeFileSync(sourcePath, '[user]\n  name = Test');
    await createBackup(sourcePath);

    const backups = await listBackups();
    const size = await getBackupSize();

    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0].path).toContain('2026-02-11');
    expect(size).toBeGreaterThan(0);
  });

  it('removes backups outside retention policy', async () => {
    await initTestTuck();
    vol.mkdirSync(join(TEST_BACKUPS_DIR, '2026-01-01'), { recursive: true });
    vol.writeFileSync(join(TEST_BACKUPS_DIR, '2026-01-01', 'old.txt'), 'old');

    const deleted = await cleanOldBackups(7);

    expect(deleted).toBe(1);
    expect(vol.existsSync(join(TEST_BACKUPS_DIR, '2026-01-01'))).toBe(false);
  });
});
