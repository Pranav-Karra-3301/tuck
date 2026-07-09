import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../utils/testHelpers.js';
import { createBackup } from '../../src/lib/backup.js';
import { clearConfigCache } from '../../src/lib/config.js';

describe('backup', () => {
  beforeEach(() => {
    vol.reset();
    clearConfigCache();
    vol.mkdirSync(TEST_HOME, { recursive: true });
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

  it('rejects a customBackupDir outside the home directory', async () => {
    const sourcePath = join(TEST_HOME, '.zshrc');
    vol.writeFileSync(sourcePath, 'content');

    await expect(createBackup(sourcePath, '/etc/evil-backups')).rejects.toThrow(
      'Unsafe backup directory'
    );
  });

  it('rejects a configured backupDir outside the home directory', async () => {
    const sourcePath = join(TEST_HOME, '.zshrc');
    vol.writeFileSync(sourcePath, 'content');
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    vol.writeFileSync(
      join(TEST_TUCK_DIR, '.tuckrc.json'),
      JSON.stringify({
        files: {
          backupDir: '/tmp/evil-backups',
        },
      })
    );

    await expect(createBackup(sourcePath)).rejects.toThrow('Unsafe backup directory');
  });
});
