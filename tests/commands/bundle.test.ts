import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getManifestPath } from '../../src/lib/paths.js';
import {
  loadManifest,
  ensureBundle,
  removeBundle,
  assignFileToBundle,
  getFilesByBundle,
  getBundles,
  clearManifestCache,
  DEFAULT_BUNDLE,
} from '../../src/lib/manifest.js';

let tuckDir: string;

const writeLegacyManifest = async (): Promise<void> => {
  // Legacy manifest mirrors what v1.x emitted: no `bundles` registry, no
  // per-file `bundle` field. The loader must migrate this transparently.
  const legacy = {
    version: '1.0.0',
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    files: {
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
        strategy: 'copy',
        encrypted: false,
        template: false,
        added: '2024-01-01T00:00:00.000Z',
        modified: '2024-01-01T00:00:00.000Z',
        checksum: 'abc123',
      },
      gitconfig: {
        source: '~/.gitconfig',
        destination: 'files/git/gitconfig',
        category: 'git',
        strategy: 'copy',
        encrypted: false,
        template: false,
        added: '2024-01-01T00:00:00.000Z',
        modified: '2024-01-01T00:00:00.000Z',
        checksum: 'def456',
      },
    },
  };
  await writeFile(getManifestPath(tuckDir), JSON.stringify(legacy, null, 2), 'utf-8');
};

beforeEach(async () => {
  tuckDir = await mkdtemp(join(tmpdir(), 'tuck-bundle-test-'));
  clearManifestCache();
});

afterEach(async () => {
  clearManifestCache();
  await rm(tuckDir, { recursive: true, force: true });
});

describe('bundle migration on load', () => {
  it('adds a default bundle to legacy manifests with no bundles registry', async () => {
    await writeLegacyManifest();

    const manifest = await loadManifest(tuckDir);

    expect(manifest.bundles[DEFAULT_BUNDLE]).toBeDefined();
    expect(manifest.bundles[DEFAULT_BUNDLE].created).toBeTruthy();
  });

  it('defaults every legacy file bundle to "default"', async () => {
    await writeLegacyManifest();

    const manifest = await loadManifest(tuckDir);

    for (const file of Object.values(manifest.files)) {
      expect(file.bundle).toBe(DEFAULT_BUNDLE);
    }
  });

  it('leaves existing bundle registries untouched', async () => {
    const custom = {
      version: '1.0.0',
      created: '2024-01-01T00:00:00.000Z',
      updated: '2024-01-01T00:00:00.000Z',
      files: {},
      bundles: {
        default: { created: '2024-01-01T00:00:00.000Z' },
        work: { created: '2024-02-01T00:00:00.000Z', description: 'work setup' },
      },
    };
    await writeFile(getManifestPath(tuckDir), JSON.stringify(custom), 'utf-8');

    const manifest = await loadManifest(tuckDir);

    expect(manifest.bundles.work).toEqual({
      created: '2024-02-01T00:00:00.000Z',
      description: 'work setup',
    });
  });
});

describe('bundle CRUD helpers', () => {
  beforeEach(async () => {
    await writeLegacyManifest();
    // Prime cache with migrated manifest.
    await loadManifest(tuckDir);
  });

  it('ensureBundle creates a new bundle', async () => {
    await ensureBundle(tuckDir, 'work', 'Work machine setup');

    const bundles = await getBundles(tuckDir);
    expect(bundles.work).toBeDefined();
    expect(bundles.work.description).toBe('Work machine setup');
  });

  it('ensureBundle is idempotent', async () => {
    await ensureBundle(tuckDir, 'work');
    const before = (await getBundles(tuckDir)).work.created;
    await ensureBundle(tuckDir, 'work');
    const after = (await getBundles(tuckDir)).work.created;

    expect(after).toBe(before);
  });

  it('assignFileToBundle moves a tracked file', async () => {
    await ensureBundle(tuckDir, 'work');
    await assignFileToBundle(tuckDir, 'zshrc', 'work');

    const filesInWork = await getFilesByBundle(tuckDir, 'work');
    expect(Object.keys(filesInWork)).toEqual(['zshrc']);

    const filesInDefault = await getFilesByBundle(tuckDir, DEFAULT_BUNDLE);
    expect(Object.keys(filesInDefault)).toEqual(['gitconfig']);
  });

  it('removeBundle reassigns files to default when non-empty', async () => {
    await ensureBundle(tuckDir, 'work');
    await assignFileToBundle(tuckDir, 'zshrc', 'work');

    const result = await removeBundle(tuckDir, 'work');
    expect(result.reassigned).toBe(1);

    const bundles = await getBundles(tuckDir);
    expect(bundles.work).toBeUndefined();

    const filesInDefault = await getFilesByBundle(tuckDir, DEFAULT_BUNDLE);
    expect(Object.keys(filesInDefault).sort()).toEqual(['gitconfig', 'zshrc']);
  });

  it('removeBundle refuses to remove the default bundle', async () => {
    await expect(removeBundle(tuckDir, DEFAULT_BUNDLE)).rejects.toThrow(/default bundle/iu);
  });

  it('roundtrips create → assign → remove and persists to disk', async () => {
    await ensureBundle(tuckDir, 'work');
    await assignFileToBundle(tuckDir, 'gitconfig', 'work');
    await removeBundle(tuckDir, 'work');

    clearManifestCache();
    const raw = JSON.parse(await readFile(getManifestPath(tuckDir), 'utf-8'));
    expect(raw.bundles.default).toBeDefined();
    expect(raw.bundles.work).toBeUndefined();
    expect(raw.files.gitconfig.bundle).toBe(DEFAULT_BUNDLE);
  });
});
