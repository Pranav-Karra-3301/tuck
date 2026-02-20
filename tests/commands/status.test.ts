import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { detectFileChanges } from '../../src/commands/status.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { TEST_TUCK_DIR } from '../setup.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

describe('status command manifest safety', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  it('rejects unsafe source paths from manifest entries', async () => {
    const manifest = createMockManifest();
    manifest.files['unsafe-source'] = createMockTrackedFile({
      source: '~/../etc/passwd',
      destination: 'files/shell/zshrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    await expect(detectFileChanges(TEST_TUCK_DIR)).rejects.toThrow('path traversal');
  });

  it('rejects unsafe destination paths from manifest entries', async () => {
    const manifest = createMockManifest();
    manifest.files['unsafe-destination'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/../../outside',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    await expect(detectFileChanges(TEST_TUCK_DIR)).rejects.toThrow('Unsafe manifest destination');
  });
});
