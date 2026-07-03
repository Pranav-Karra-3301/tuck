/**
 * State model unit tests.
 *
 * The state model is the shared substrate for `tuck verify` (Wave 2) and for
 * status/sync/restore/diff: it compares three independent checksums per tracked
 * file — the live file on the system, the copy in the repo, and the manifest's
 * recorded checksum — and classifies the drift. classifyFileState is the pure
 * core of that comparison.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { classifyFileState, computeStateModel } from '../../src/lib/stateModel.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { encryptFileContent } from '../../src/lib/crypto/fileEncryption.js';

const retrieveMock = vi.fn();
vi.mock('../../src/lib/crypto/keystore/index.js', () => ({
  getKeystore: vi.fn(async () => ({ retrieve: retrieveMock })),
  TUCK_SERVICE: 'tuck-dotfiles',
  TUCK_ACCOUNT: 'backup-encryption',
}));

describe('classifyFileState', () => {
  it('ok when live == repo == manifest', () => {
    expect(classifyFileState('h', 'h', 'h')).toBe('ok');
  });

  it('drift-local when the live file differs from the repo copy', () => {
    expect(classifyFileState('LIVE', 'repo', 'repo')).toBe('drift-local');
  });

  it('drift-repo when the repo copy differs from the manifest checksum', () => {
    expect(classifyFileState('same', 'same', 'OLD')).toBe('drift-repo');
  });

  it('missing-live when the tracked file is absent on the system', () => {
    expect(classifyFileState(null, 'repo', 'repo')).toBe('missing-live');
  });

  it('missing-repo when the repo copy is absent', () => {
    expect(classifyFileState('live', null, 'live')).toBe('missing-repo');
  });

  it('missing-both when neither live nor repo exists', () => {
    expect(classifyFileState(null, null, 'x')).toBe('missing-both');
  });
});

describe('computeStateModel', () => {
  const TUCK = '/test-home/.tuck';

  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    vol.mkdirSync('/test-home', { recursive: true });
    vol.mkdirSync(`${TUCK}/files/shell`, { recursive: true });
  });

  it('reports ok when live, repo, and manifest all agree', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'export A=1\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'export A=1\n');
    // manifest checksum must match the content
    const { getFileChecksum } = await import('../../src/lib/files.js');
    const checksum = await getFileChecksum('/test-home/.zshrc');
    vol.writeFileSync(
      `${TUCK}/.tuckmanifest.json`,
      JSON.stringify({
        version: '1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        files: {
          zshrc: {
            source: '~/.zshrc',
            destination: 'files/shell/zshrc',
            category: 'shell',
            strategy: 'copy',
            checksum,
            added: '2026-01-01T00:00:00.000Z',
            modified: '2026-01-01T00:00:00.000Z',
          },
        },
        bundles: {},
      })
    );

    const model = await computeStateModel(TUCK);
    expect(model).toHaveLength(1);
    expect(model[0].state).toBe('ok');
    expect(model[0].source).toBe('~/.zshrc');
  });

  const ts = '2026-01-01T00:00:00.000Z';
  const writeManifest = (entry: Record<string, unknown>): void => {
    vol.writeFileSync(
      `${TUCK}/.tuckmanifest.json`,
      JSON.stringify({ version: '1', created: ts, updated: ts, files: { f: entry }, bundles: {} })
    );
  };

  it('reports ok for a correctly-applied template file (no false drift)', async () => {
    vol.writeFileSync('/test-home/.zshrc', `os=${process.platform}`);
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'os={{os}}');
    const { getFileChecksum } = await import('../../src/lib/files.js');
    const repoChecksum = await getFileChecksum(`${TUCK}/files/shell/zshrc`);
    writeManifest({
      source: '~/.zshrc', destination: 'files/shell/zshrc', category: 'shell',
      strategy: 'copy', template: true, encrypted: false, checksum: repoChecksum, added: ts, modified: ts,
    });

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('ok');
  });

  it('reports drift-local for a hand-edited template live file (needs apply)', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'HAND EDITED');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'os={{os}}');
    const { getFileChecksum } = await import('../../src/lib/files.js');
    const repoChecksum = await getFileChecksum(`${TUCK}/files/shell/zshrc`);
    writeManifest({
      source: '~/.zshrc', destination: 'files/shell/zshrc', category: 'shell',
      strategy: 'copy', template: true, encrypted: false, checksum: repoChecksum, added: ts, modified: ts,
    });

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('drift-local');
  });

  it('degrades to ok for an encrypted file when the keystore is locked', async () => {
    retrieveMock.mockResolvedValue(null); // locked / no passphrase available
    const ciphertext = await encryptFileContent(Buffer.from('SECRET=1'), 'pw');
    vol.writeFileSync('/test-home/.netrc', 'SECRET=1');
    vol.writeFileSync(`${TUCK}/files/shell/netrc`, ciphertext);
    const { getFileChecksum } = await import('../../src/lib/files.js');
    const repoChecksum = await getFileChecksum(`${TUCK}/files/shell/netrc`);
    writeManifest({
      source: '~/.netrc', destination: 'files/shell/netrc', category: 'shell',
      strategy: 'copy', template: false, encrypted: true, checksum: repoChecksum, added: ts, modified: ts,
    });

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('ok');
  });

  it('reports drift for a template DIRECTORY (no false ok via the materialize catch)', async () => {
    vol.mkdirSync(`${TUCK}/files/x`, { recursive: true });
    vol.writeFileSync(`${TUCK}/files/x/a`, 'repo\n');
    vol.mkdirSync('/test-home/x', { recursive: true });
    vol.writeFileSync('/test-home/x/a', 'LIVE DIFFERENT\n'); // live dir differs from repo dir
    const { getFileChecksum } = await import('../../src/lib/files.js');
    const repoChecksum = await getFileChecksum(`${TUCK}/files/x`);
    writeManifest({
      source: '~/x', destination: 'files/x', category: 'misc',
      strategy: 'copy', template: true, encrypted: false, checksum: repoChecksum, added: ts, modified: ts,
    });

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('drift-local');
  });

  it('reports drift-local when the live file was edited', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'EDITED\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'original\n');
    const { getFileChecksum } = await import('../../src/lib/files.js');
    const repoChecksum = await getFileChecksum(`${TUCK}/files/shell/zshrc`);
    vol.writeFileSync(
      `${TUCK}/.tuckmanifest.json`,
      JSON.stringify({
        version: '1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        files: {
          zshrc: {
            source: '~/.zshrc',
            destination: 'files/shell/zshrc',
            category: 'shell',
            strategy: 'copy',
            checksum: repoChecksum,
            added: '2026-01-01T00:00:00.000Z',
            modified: '2026-01-01T00:00:00.000Z',
          },
        },
        bundles: {},
      })
    );

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('drift-local');
  });

  it('reports unknown-repo for a repo-scoped file whose repo is not bound here', async () => {
    vol.mkdirSync(`${TUCK}/files/repos/proj-xyz`, { recursive: true });
    vol.writeFileSync(`${TUCK}/files/repos/proj-xyz/a.txt`, 'x');
    vol.writeFileSync(
      `${TUCK}/.tuckmanifest.json`,
      JSON.stringify({
        version: '1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        files: {
          repofile: {
            source: 'proj-xyz:a.txt',
            destination: 'files/repos/proj-xyz/a.txt',
            category: 'misc',
            strategy: 'copy',
            checksum: 'abc',
            added: '2026-01-01T00:00:00.000Z',
            modified: '2026-01-01T00:00:00.000Z',
            scope: 'repo',
            repoKey: 'proj-xyz',
            repoRelative: 'a.txt',
          },
        },
        bundles: {},
      })
    );

    const model = await computeStateModel(TUCK);
    expect(model[0].state).toBe('unknown-repo');
  });
});
