/**
 * Regression test for JSON-key subtree secret handling on `tuck restore`.
 *
 * A jsonKey entry tracks only a SUBTREE of a JSON file; the rest of the live
 * file holds UNTRACKED keys tuck does not manage (tokens, machine state, notes).
 * Secret placeholder resolution must therefore run on the tracked subtree ONLY —
 * never over the whole merged file — so a tuck secret is never spliced into an
 * untracked key that happens to contain `{{NAME}}` text.
 *
 * Uses real modules + memfs (like the sandbox-restore integration test) so the
 * real secret store, jsonKey merge, and restoreContent path are exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { clearConfigCache } from '../../src/lib/config.js';
import { resetWriteContext } from '../../src/lib/writeContext.js';

const TUCK = '/test-home/.tuck';
const LIVE = '/test-home/.claude.json';

const seed = async (): Promise<void> => {
  vol.mkdirSync(`${TUCK}/files/misc`, { recursive: true });
  // The repo copy stores ONLY the tracked subtree, with a secret placeholder.
  const repoSubtree = JSON.stringify({ api: '{{NAME}}' });
  vol.writeFileSync(`${TUCK}/files/misc/claude.json`, repoSubtree);

  const { getFileChecksum } = await import('../../src/lib/files.js');
  const checksum = await getFileChecksum(`${TUCK}/files/misc/claude.json`);

  vol.writeFileSync(
    `${TUCK}/.tuckrc.json`,
    JSON.stringify({ repository: { path: TUCK }, files: { strategy: 'copy', backupOnRestore: false } })
  );

  vol.writeFileSync(
    `${TUCK}/.tuckmanifest.json`,
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: {
        claude: {
          source: '~/.claude.json',
          destination: 'files/misc/claude.json',
          category: 'misc',
          strategy: 'copy',
          checksum,
          jsonKey: 'mcpServers',
          added: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      },
      bundles: {},
    })
  );

  // A real local secret store the restore will resolve from.
  vol.writeFileSync(
    `${TUCK}/secrets.local.json`,
    JSON.stringify({
      version: '1.0.0',
      secrets: {
        NAME: { value: 'RESOLVED', placeholder: '{{NAME}}', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    })
  );

  // The live file: the tracked subtree PLUS an untracked "note" key that happens
  // to contain the SAME placeholder text.
  vol.writeFileSync(
    LIVE,
    JSON.stringify({ mcpServers: { old: 1 }, note: 'Hello {{NAME}}' })
  );
};

describe('tuck restore — jsonKey subtree secret scoping', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
    resetWriteContext();
    vol.mkdirSync('/test-home', { recursive: true });
  });
  afterEach(() => resetWriteContext());

  it('resolves secrets in the tracked subtree but never in the untracked remainder', async () => {
    await seed();

    const { runRestoreCommand } = await import('../../src/commands/restore.js');
    await runRestoreCommand(['~/.claude.json'], { yes: true, noHooks: true } as never);

    const written = JSON.parse(vol.readFileSync(LIVE, 'utf-8'));

    // The tracked subtree's placeholder WAS resolved from the secret store...
    expect(written.mcpServers).toEqual({ api: 'RESOLVED' });
    // ...but the UNTRACKED "note" key's identical placeholder text is untouched.
    expect(written.note).toBe('Hello {{NAME}}');
  });
});
