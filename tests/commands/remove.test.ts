import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { runRemove } from '../../src/commands/remove.js';
import { clearManifestCache, getAllTrackedFiles } from '../../src/lib/manifest.js';
import { setJsonMode, __resetJsonEmitState } from '../../src/lib/jsonOutput.js';
import { bindRepo } from '../../src/lib/repoScope.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
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

describe('remove command symlink strategy restore', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  const seedSymlinkedFile = (): { livePath: string; repoCopy: string } => {
    const repoCopy = join(TEST_TUCK_DIR, 'files/shell/zshrc');
    vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
    vol.writeFileSync(repoCopy, 'export FROM_REPO=1');
    const livePath = join(TEST_HOME, '.zshrc');
    vol.symlinkSync(repoCopy, livePath);

    const manifest = createMockManifest();
    manifest.files['zshrc'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
      strategy: 'symlink',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    return { livePath, repoCopy };
  };

  it('restores the original as a real file before deleting the repo copy when --delete is passed', async () => {
    const { livePath, repoCopy } = seedSymlinkedFile();

    await runRemove(['~/.zshrc'], { delete: true });

    // The live path must be a real file (never a dangling symlink) holding the
    // content, and the repo copy is removed only after the content is preserved.
    expect(vol.lstatSync(livePath).isSymbolicLink()).toBe(false);
    expect(vol.readFileSync(livePath, 'utf-8')).toBe('export FROM_REPO=1');
    expect(vol.existsSync(repoCopy)).toBe(false);
  });

  it('leaves the symlink in place when --keep-original is passed', async () => {
    const { livePath, repoCopy } = seedSymlinkedFile();

    await runRemove(['~/.zshrc'], { keepOriginal: true });

    expect(vol.lstatSync(livePath).isSymbolicLink()).toBe(true);
    expect(vol.readlinkSync(livePath)).toBe(repoCopy);
  });
});

describe('remove command repo-scoped entries', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    setJsonMode(false);
    __resetJsonEmitState();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    setJsonMode(false);
    __resetJsonEmitState();
  });

  it('untracks a repo-scoped file non-interactively by its live path (repo root outside $HOME)', async () => {
    const repoRoot = '/work/proj';
    const repoKey = 'proj-abc12345';
    vol.mkdirSync(repoRoot, { recursive: true });
    vol.writeFileSync(join(repoRoot, '.env'), 'SECRET=1');
    await bindRepo(repoKey, repoRoot);

    const manifest = createMockManifest();
    manifest.files['repo-env'] = createMockTrackedFile({
      source: `${repoKey}:.env`,
      destination: 'files/repo/proj/.env',
      category: 'misc',
      scope: 'repo',
      repoKey,
      repoRelative: '.env',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await runRemove([join(repoRoot, '.env')], { json: true });

    writeSpy.mockRestore();

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.data.removed).toEqual([`${repoKey}:.env`]);

    const remaining = await getAllTrackedFiles(TEST_TUCK_DIR);
    expect(remaining['repo-env']).toBeUndefined();
  });
});

describe('remove command pre-delete snapshot (IDEAS 6.5)', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    setJsonMode(false);
    __resetJsonEmitState();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
    setJsonMode(false);
    __resetJsonEmitState();
  });

  it('snapshots the repo copy before deleting it so `tuck undo` can recover it', async () => {
    const { listSnapshots } = await import('../../src/lib/timemachine.js');

    const manifest = createMockManifest();
    manifest.files['zshrc'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));

    // The committed repo copy must exist for the delete (and thus the snapshot).
    vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
    vol.writeFileSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'), 'export FROM_REPO=1');

    await runRemove(['~/.zshrc'], { delete: true });

    const snapshots = await listSnapshots();
    const preRemove = snapshots.find((s) => s.reason.startsWith('Pre-remove delete backup'));
    expect(preRemove).toBeDefined();

    // The repo copy is gone from the tuck repo but preserved inside the snapshot.
    expect(vol.existsSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'))).toBe(false);
    const remaining = await getAllTrackedFiles(TEST_TUCK_DIR);
    expect(remaining['zshrc']).toBeUndefined();
  });

  it('does not snapshot when untracking without --delete', async () => {
    const { listSnapshots } = await import('../../src/lib/timemachine.js');

    const manifest = createMockManifest();
    manifest.files['zshrc'] = createMockTrackedFile({
      source: '~/.zshrc',
      destination: 'files/shell/zshrc',
    });
    vol.writeFileSync(join(TEST_TUCK_DIR, '.tuckmanifest.json'), JSON.stringify(manifest));
    vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
    vol.writeFileSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'), 'export FROM_REPO=1');

    await runRemove(['~/.zshrc'], {});

    const snapshots = await listSnapshots();
    expect(snapshots.find((s) => s.reason.startsWith('Pre-remove delete backup'))).toBeUndefined();
    // Untrack-only leaves the repo copy in place (recover via git / re-add).
    expect(vol.existsSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'))).toBe(true);
  });
});
