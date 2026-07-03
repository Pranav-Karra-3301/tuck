import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { TEST_TUCK_DIR } from '../setup.js';
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

const manifestPath = `${TEST_TUCK_DIR}/.tuckmanifest.json`;

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
  await mkdir(TEST_TUCK_DIR, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(legacy, null, 2), 'utf-8');
};

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  clearManifestCache();
});

describe('bundle migration on load', () => {
  it('adds a default bundle to legacy manifests with no bundles registry', async () => {
    await writeLegacyManifest();

    const manifest = await loadManifest(TEST_TUCK_DIR);

    expect(manifest.bundles[DEFAULT_BUNDLE]).toBeDefined();
    expect(manifest.bundles[DEFAULT_BUNDLE].created).toBeTruthy();
  });

  it('defaults every legacy file bundle to "default"', async () => {
    await writeLegacyManifest();

    const manifest = await loadManifest(TEST_TUCK_DIR);

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
    await mkdir(TEST_TUCK_DIR, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(custom), 'utf-8');

    const manifest = await loadManifest(TEST_TUCK_DIR);

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
    await loadManifest(TEST_TUCK_DIR);
  });

  it('ensureBundle creates a new bundle', async () => {
    await ensureBundle(TEST_TUCK_DIR, 'work', 'Work machine setup');

    const bundles = await getBundles(TEST_TUCK_DIR);
    expect(bundles.work).toBeDefined();
    expect(bundles.work.description).toBe('Work machine setup');
  });

  it('ensureBundle is idempotent', async () => {
    await ensureBundle(TEST_TUCK_DIR, 'work');
    const before = (await getBundles(TEST_TUCK_DIR)).work.created;
    await ensureBundle(TEST_TUCK_DIR, 'work');
    const after = (await getBundles(TEST_TUCK_DIR)).work.created;

    expect(after).toBe(before);
  });

  it('assignFileToBundle moves a tracked file', async () => {
    await ensureBundle(TEST_TUCK_DIR, 'work');
    await assignFileToBundle(TEST_TUCK_DIR, 'zshrc', 'work');

    const filesInWork = await getFilesByBundle(TEST_TUCK_DIR, 'work');
    expect(Object.keys(filesInWork)).toEqual(['zshrc']);

    const filesInDefault = await getFilesByBundle(TEST_TUCK_DIR, DEFAULT_BUNDLE);
    expect(Object.keys(filesInDefault)).toEqual(['gitconfig']);
  });

  it('removeBundle reassigns files to default when non-empty', async () => {
    await ensureBundle(TEST_TUCK_DIR, 'work');
    await assignFileToBundle(TEST_TUCK_DIR, 'zshrc', 'work');

    const result = await removeBundle(TEST_TUCK_DIR, 'work');
    expect(result.reassigned).toBe(1);

    const bundles = await getBundles(TEST_TUCK_DIR);
    expect(bundles.work).toBeUndefined();

    const filesInDefault = await getFilesByBundle(TEST_TUCK_DIR, DEFAULT_BUNDLE);
    expect(Object.keys(filesInDefault).sort()).toEqual(['gitconfig', 'zshrc']);
  });

  it('removeBundle refuses to remove the default bundle', async () => {
    await expect(removeBundle(TEST_TUCK_DIR, DEFAULT_BUNDLE)).rejects.toThrow(/default bundle/iu);
  });

  it('roundtrips create -> assign -> remove and persists to disk', async () => {
    await ensureBundle(TEST_TUCK_DIR, 'work');
    await assignFileToBundle(TEST_TUCK_DIR, 'gitconfig', 'work');
    await removeBundle(TEST_TUCK_DIR, 'work');

    clearManifestCache();
    const raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(raw.bundles.default).toBeDefined();
    expect(raw.bundles.work).toBeUndefined();
    expect(raw.files.gitconfig.bundle).toBe(DEFAULT_BUNDLE);
  });
});
