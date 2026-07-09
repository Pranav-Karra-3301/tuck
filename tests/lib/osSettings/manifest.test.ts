/**
 * Unit tests for the OS-settings manifest loader's corrupt-file protection:
 * mutators do load->mutate->save, so a corrupt manifest must throw, never
 * silently degrade to empty (which would wipe all tracked settings).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_TUCK_DIR } from '../../setup.js';

beforeEach(() => {
  vol.reset();
});

describe('corrupt-manifest protection', () => {
  it('throws (not empty) when the file exists but is invalid JSON', async () => {
    const { loadOsSettingsManifest, osSettingsManifestPath } = await import(
      '../../../src/lib/osSettings/manifest.js'
    );
    const { vol } = await import('memfs');
    const { dirname } = await import('path');
    const p = osSettingsManifestPath(TEST_TUCK_DIR);
    vol.mkdirSync(dirname(p), { recursive: true });
    vol.writeFileSync(p, 'not-json{');
    await expect(loadOsSettingsManifest(TEST_TUCK_DIR)).rejects.toMatchObject({
      code: 'OS_SETTINGS_MANIFEST_ERROR',
    });
  });

  it('throws on an unknown/newer manifest version instead of wiping settings', async () => {
    const { loadOsSettingsManifest, osSettingsManifestPath } = await import(
      '../../../src/lib/osSettings/manifest.js'
    );
    const { vol } = await import('memfs');
    const { dirname } = await import('path');
    const p = osSettingsManifestPath(TEST_TUCK_DIR);
    vol.mkdirSync(dirname(p), { recursive: true });
    vol.writeFileSync(p, JSON.stringify({ version: '2', settings: { x: {} } }));
    await expect(loadOsSettingsManifest(TEST_TUCK_DIR)).rejects.toMatchObject({
      code: 'OS_SETTINGS_MANIFEST_ERROR',
    });
  });
});
