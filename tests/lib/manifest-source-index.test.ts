/**
 * Regression tests for buildSourceIndex (W4-B).
 *
 * `getTrackedFileBySource` is O(N) per call; callers that looked up many
 * sources against the manifest (new-file detection in scan/sync) were O(N×M).
 * `buildSourceIndex` builds the source→{id,file} map ONCE so callers can do
 * O(1) lookups. This must return EXACTLY the same answer as the old per-call
 * `getTrackedFileBySource` path for every source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  buildSourceIndex,
  getTrackedFileBySource,
  clearManifestCache,
} from '../../src/lib/manifest.js';
import { TEST_TUCK_DIR } from '../setup.js';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';

describe('buildSourceIndex (W4-B)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    clearManifestCache();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  const writeManifestWith = (entries: Array<{ id: string; source: string }>): void => {
    const manifest = createMockManifest();
    for (const e of entries) {
      manifest.files[e.id] = createMockTrackedFile({ source: e.source });
    }
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
  };

  it('maps each tracked source to its {id, file}', async () => {
    writeManifestWith([
      { id: 'zshrc', source: '~/.zshrc' },
      { id: 'gitconfig', source: '~/.gitconfig' },
    ]);

    const index = await buildSourceIndex(TEST_TUCK_DIR);

    expect(index.size).toBe(2);
    expect(index.get('~/.zshrc')?.id).toBe('zshrc');
    expect(index.get('~/.gitconfig')?.id).toBe('gitconfig');
    expect(index.get('~/.zshrc')?.file.source).toBe('~/.zshrc');
  });

  it('returns the SAME answers as the old per-call getTrackedFileBySource path', async () => {
    const sources = ['~/.zshrc', '~/.gitconfig', '~/.vimrc', '~/.tmux.conf'];
    writeManifestWith(sources.map((s, i) => ({ id: `id${i}`, source: s })));

    const index = await buildSourceIndex(TEST_TUCK_DIR);

    // Tracked sources resolve identically.
    for (const source of sources) {
      const viaIndex = index.get(source) ?? null;
      const viaQuery = await getTrackedFileBySource(TEST_TUCK_DIR, source);
      expect(viaIndex?.id).toBe(viaQuery?.id);
      expect(viaIndex?.file).toEqual(viaQuery?.file);
    }

    // Untracked sources resolve to "not found" in both paths.
    for (const missing of ['~/.unknown', '~/.config/nvim']) {
      const viaIndex = index.get(missing) ?? null;
      const viaQuery = await getTrackedFileBySource(TEST_TUCK_DIR, missing);
      expect(viaIndex).toBeNull();
      expect(viaQuery).toBeNull();
    }
  });

  it('returns an empty map for a manifest with no files', async () => {
    vol.writeFileSync(
      join(TEST_TUCK_DIR, '.tuckmanifest.json'),
      JSON.stringify(createMockManifest())
    );

    const index = await buildSourceIndex(TEST_TUCK_DIR);
    expect(index.size).toBe(0);
  });
});
