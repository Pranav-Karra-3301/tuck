/**
 * Placeholder-aware change detection for `tuck sync` (issue #100).
 *
 * tuck redacts ONLY the repo copy: the live ~/.zshrc keeps its real secret, the
 * committed copy holds {{PLACEHOLDER}}, and the manifest checksum is of the
 * redacted content. Raw live-vs-manifest therefore ALWAYS differs, which would
 * make `tuck sync` report the file as modified forever. detectChanges must
 * checksum the live file AS IF its known secrets were redacted before deciding.
 *
 * These tests exercise the real detectChanges against memfs (no getFileChecksum
 * mocking) so the redacted-compare wiring is genuinely covered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { getFileChecksum } from '../../src/lib/files.js';
import { setSecret } from '../../src/lib/secrets/store.js';
import { detectChanges } from '../../src/commands/sync.js';
import { TEST_TUCK_DIR } from '../setup.js';

const SECRET = 'S3CRET-sync-777';
const ts = '2026-01-01T00:00:00.000Z';

const writeManifest = async (): Promise<void> => {
  const repoChecksum = await getFileChecksum(join(TEST_TUCK_DIR, 'files/shell/zshrc'));
  vol.writeFileSync(
    join(TEST_TUCK_DIR, '.tuckmanifest.json'),
    JSON.stringify({
      version: '1',
      created: ts,
      updated: ts,
      files: {
        zshrc: {
          source: '~/.zshrc',
          destination: 'files/shell/zshrc',
          category: 'shell',
          strategy: 'copy',
          checksum: repoChecksum,
          added: ts,
          modified: ts,
        },
      },
      bundles: {},
    })
  );
};

describe('detectChanges — placeholder awareness (issue #100)', () => {
  beforeEach(async () => {
    vol.reset();
    clearManifestCache();
    vol.mkdirSync('/test-home', { recursive: true });
    vol.mkdirSync(join(TEST_TUCK_DIR, 'files/shell'), { recursive: true });
    // Repo copy holds the placeholder.
    vol.writeFileSync(join(TEST_TUCK_DIR, 'files/shell/zshrc'), 'token={{TOK}}\n');
    await setSecret(TEST_TUCK_DIR, 'TOK', SECRET);
    await writeManifest();
  });

  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  it('does NOT report a redacted-in-sync file as modified when the live file is untouched', async () => {
    vol.writeFileSync('/test-home/.zshrc', `token=${SECRET}\n`);
    const changes = await detectChanges(TEST_TUCK_DIR);
    expect(changes).toHaveLength(0);
  });

  it('reports modified when the live file is edited on a non-secret line', async () => {
    vol.writeFileSync('/test-home/.zshrc', `token=${SECRET}\nexport EXTRA=1\n`);
    const changes = await detectChanges(TEST_TUCK_DIR);
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe('modified');
    expect(changes[0].source).toBe('~/.zshrc');
  });

  it('still reports deleted when a secret-bearing live file is removed', async () => {
    // Adversarial pin: the redacted compare only runs in the checksum-mismatch
    // branch — it must never short-circuit the missing-file branch above it.
    // (No live file written.)
    const changes = await detectChanges(TEST_TUCK_DIR);
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe('deleted');
    expect(changes[0].source).toBe('~/.zshrc');
  });

  it('reports modified when a brand-new (unstored) secret is added', async () => {
    // NEWKEY is not in the store, so redacting the live file leaves it in place
    // and the redacted checksum no longer matches the repo copy → real drift.
    vol.writeFileSync('/test-home/.zshrc', `token=${SECRET}\napi=NEWKEY-000\n`);
    const changes = await detectChanges(TEST_TUCK_DIR);
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe('modified');
  });
});
