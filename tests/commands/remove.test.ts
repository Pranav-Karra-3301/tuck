import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { runRemove } from '../../src/commands/remove.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { setJsonMode, __resetJsonEmitState } from '../../src/lib/jsonOutput.js';
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

describe('remove command --json output', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    setJsonMode(false);
    __resetJsonEmitState();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    setJsonMode(false);
    __resetJsonEmitState();
  });

  it('emits a JSON envelope with the untracked source paths', async () => {
    const manifest = createMockManifest();
    manifest.files['zshrc'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await runRemove(['~/.zshrc'], { json: true });

    writeSpy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck remove');
    expect(env.data.removed).toEqual(['~/.zshrc']);
  });

  it('emits exactly one JSON envelope and no other stdout writes', async () => {
    const manifest = createMockManifest();
    manifest.files['zshrc'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
    });
    manifest.files['bashrc'] = createMockTrackedFile({
      source: '~/.bashrc',
      destination: 'files/shell/bashrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await runRemove(['~/.zshrc', '~/.bashrc'], { json: true });

    writeSpy.mockRestore();

    const lines = writes.join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const env = JSON.parse(lines[0]);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck remove');
    expect(env.data.removed).toEqual(['~/.zshrc', '~/.bashrc']);
  });
});
