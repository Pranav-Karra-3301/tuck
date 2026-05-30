/**
 * Shared cloned/remote manifest loader.
 *
 * A cloned or remote manifest is UNTRUSTED input: it can be hand-crafted by a
 * hostile repo to smuggle unsafe entries. `loadManifestFile` is the single
 * choke point that JSON.parses AND zod-validates a manifest file before any
 * caller (init's analyzeRepository, apply's clone read) acts on it. A malformed
 * or schema-violating manifest must be rejected, not silently trusted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME } from '../setup.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

const MANIFEST = join(TEST_HOME, 'repo', '.tuckmanifest.json');

describe('loadManifestFile', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(join(TEST_HOME, 'repo'), { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  it('parses and validates a well-formed manifest', async () => {
    const manifest = createMockManifest({
      files: {
        zsh: createMockTrackedFile({ source: '~/.zshrc', destination: 'files/shell/zshrc' }),
      },
    });
    vol.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

    const { loadManifestFile } = await import('../../src/lib/manifestFile.js');
    const loaded = await loadManifestFile(MANIFEST);

    expect(loaded.version).toBe('1.0.0');
    expect(Object.keys(loaded.files)).toContain('zsh');
    // The schema default fills in the implicit bundle registry.
    expect(loaded.bundles).toBeTruthy();
  });

  it('rejects a manifest that is not valid JSON', async () => {
    vol.writeFileSync(MANIFEST, '{ this is : not json ');

    const { loadManifestFile } = await import('../../src/lib/manifestFile.js');
    await expect(loadManifestFile(MANIFEST)).rejects.toThrow();
  });

  it('rejects a manifest whose shape violates the schema', async () => {
    // Missing required top-level fields (version/created/updated) and a bogus
    // files map → zod must reject rather than hand back a half-typed object.
    vol.writeFileSync(
      MANIFEST,
      JSON.stringify({ files: { evil: { source: 123 } } })
    );

    const { loadManifestFile } = await import('../../src/lib/manifestFile.js');
    await expect(loadManifestFile(MANIFEST)).rejects.toThrow();
  });
});
