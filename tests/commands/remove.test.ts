import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { runRemove } from '../../src/commands/remove.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { TEST_TUCK_DIR } from '../setup.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

describe('remove command manifest safety', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  it('rejects unsafe repository destinations before deletion', async () => {
    const manifest = createMockManifest();
    manifest.files['unsafe-destination'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/../../outside',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    await expect(runRemove(['~/.zshrc'], { delete: true })).rejects.toThrow(
      'Unsafe manifest destination'
    );
  });

  it('rejects unsafe source paths from manifest entries', async () => {
    const manifest = createMockManifest();
    manifest.files['unsafe-source'] = createMockTrackedFile({
      source: '/etc/passwd',
      destination: 'files/shell/zshrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    await expect(runRemove(['/etc/passwd'], { delete: true })).rejects.toThrow('Unsafe path');
  });
});
