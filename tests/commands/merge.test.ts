import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { writeFile, mkdir } from 'fs/promises';
import { TEST_TUCK_DIR } from '../setup.js';
import { loadManifest, clearManifestCache } from '../../src/lib/manifest.js';
import { setAction, unsetAction, listAction } from '../../src/commands/merge.js';

const manifestPath = `${TEST_TUCK_DIR}/.tuckmanifest.json`;

const writeManifest = async (): Promise<void> => {
  const manifest = {
    version: '1.0.0',
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    bundles: { default: { created: '2024-01-01T00:00:00.000Z' } },
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
        bundle: 'default',
      },
      settings: {
        source: '~/.claude/settings.json',
        destination: 'files/misc/settings.json',
        category: 'misc',
        strategy: 'copy',
        encrypted: false,
        template: false,
        added: '2024-01-01T00:00:00.000Z',
        modified: '2024-01-01T00:00:00.000Z',
        checksum: 'def456',
        bundle: 'default',
      },
    },
  };
  await mkdir(TEST_TUCK_DIR, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
};

beforeEach(async () => {
  vol.reset();
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  clearManifestCache();
  vi.restoreAllMocks();
  await writeManifest();
});

describe('tuck merge set', () => {
  it('sets an explicit policy on a tracked file, filling defaults', async () => {
    await setAction('~/.zshrc', {});
    clearManifestCache();
    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(manifest.files.zshrc.merge).toEqual({
      format: 'json',
      arrays: 'union',
      conflict: 'manual',
    });
  });

  it('applies --arrays and --conflict overrides', async () => {
    await setAction('~/.zshrc', { arrays: 'concat', conflict: 'theirs' });
    clearManifestCache();
    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(manifest.files.zshrc.merge).toEqual({
      format: 'json',
      arrays: 'concat',
      conflict: 'theirs',
    });
  });

  it('resolves a file by manifest id as well as source path', async () => {
    await setAction('settings', { conflict: 'ours' });
    clearManifestCache();
    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(manifest.files.settings.merge?.conflict).toBe('ours');
  });

  it('rejects an invalid --arrays value', async () => {
    await expect(setAction('~/.zshrc', { arrays: 'bogus' })).rejects.toThrow(/Invalid --arrays/);
  });

  it('rejects an unknown file', async () => {
    await expect(setAction('~/.does-not-exist', {})).rejects.toThrow(/No tracked file/);
  });
});

describe('tuck merge unset', () => {
  it('removes an explicit policy', async () => {
    await setAction('~/.zshrc', {});
    clearManifestCache();
    await unsetAction('~/.zshrc', {});
    clearManifestCache();
    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(manifest.files.zshrc.merge).toBeUndefined();
  });
});

describe('tuck merge list --json', () => {
  it('includes auto-detected agent configs even without an explicit policy', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await listAction({ json: true });
    const output = spy.mock.calls.map((c) => String(c[0])).join('');
    spy.mockRestore();

    const parsed = JSON.parse(output) as {
      ok: boolean;
      data: { count: number; files: Array<{ source: string; explicit: boolean }> };
    };
    expect(parsed.ok).toBe(true);
    const settings = parsed.data.files.find((f) => f.source === '~/.claude/settings.json');
    expect(settings).toBeDefined();
    expect(settings?.explicit).toBe(false);
    // ~/.zshrc has no policy and is not an agent config → excluded.
    expect(parsed.data.files.some((f) => f.source === '~/.zshrc')).toBe(false);
  });
});
