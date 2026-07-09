import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
import {
  setFilePermissions,
  getFileInfo,
  copyFileOrDir,
  createSymlink,
} from '../../src/lib/files.js';

describe('Permissions Security', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  it('returns structured file metadata for valid files', async () => {
    const filePath = join(TEST_HOME, 'info.txt');
    vol.writeFileSync(filePath, 'abc');

    const info = await getFileInfo(filePath);

    expect(info.path).toBe(filePath);
    expect(info.isDirectory).toBe(false);
    expect(info.isSymlink).toBe(false);
    expect(info.size).toBe(3);
    expect(info.permissions).toMatch(/^[0-7]{3}$/);
  });

  it('throws file errors for invalid metadata targets', async () => {
    await expect(getFileInfo(join(TEST_HOME, 'does-not-exist'))).rejects.toThrow();
  });

  it('copies files inside home safely', async () => {
    const source = join(TEST_HOME, 'source.txt');
    const destination = join(TEST_HOME, '.tuck', 'files', 'shell', 'source.txt');
    vol.writeFileSync(source, 'copy me');

    const result = await copyFileOrDir(source, destination);

    expect(result.fileCount).toBe(1);
    expect(vol.existsSync(destination)).toBe(true);
    expect(vol.readFileSync(destination, 'utf-8')).toBe('copy me');
  });

  it('rejects copy destinations outside safe roots', async () => {
    const source = join(TEST_HOME, 'source.txt');
    vol.writeFileSync(source, 'x');

    if (process.platform !== 'win32') {
      await expect(copyFileOrDir(source, '/etc/malicious')).rejects.toThrow('Unsafe destination');
    }
  });

  it('rejects symlink destinations outside safe roots', async () => {
    const source = join(TEST_HOME, 'target.txt');
    vol.writeFileSync(source, 'target');

    if (process.platform !== 'win32') {
      await expect(createSymlink(source, '/etc/link-target')).rejects.toThrow('Unsafe destination');
    }
  });

  it('exposes and applies permission helpers without crashing', async () => {
    const filePath = join(TEST_HOME, 'permissions.txt');
    vol.writeFileSync(filePath, 'secret');

    // Seed a known, non-644 mode so the change made below is actually
    // observable. If setFilePermissions were a no-op the final assertion would
    // still see 600 and fail, instead of passing vacuously.
    await setFilePermissions(filePath, '600');
    const before = (await getFileInfo(filePath)).permissions;
    expect(before).toBe('600');

    await expect(setFilePermissions(filePath, '644')).resolves.not.toThrow();
    const after = (await getFileInfo(filePath)).permissions;
    expect(after).toBe('644');
  });
});
