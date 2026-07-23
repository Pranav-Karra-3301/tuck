import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME } from '../utils/testHelpers.js';
import { initTestTuck } from '../utils/testHelpers.js';
import { createBackup } from '../../src/lib/backup.js';

describe('Backup Cycle Integration', () => {
  beforeEach(() => {
    vol.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vol.reset();
  });

  it('captures the original content in a durable backup copy before edits', async () => {
    await initTestTuck();

    const sourcePath = join(TEST_HOME, '.zshrc');
    vol.writeFileSync(sourcePath, 'export PATH=$PATH:/original');

    const backup = await createBackup(sourcePath);

    // Mutate the live file after the backup was taken.
    vol.writeFileSync(sourcePath, 'export PATH=$PATH:/modified');

    // The backup copy must still hold the pre-edit content on disk.
    expect(vol.existsSync(backup.backupPath)).toBe(true);
    expect(vol.readFileSync(backup.backupPath, 'utf-8')).toBe('export PATH=$PATH:/original');
    expect(backup.backupPath.replace(/\\/g, '/')).toContain('/2026-02-11/');
  });
});
