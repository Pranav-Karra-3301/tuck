/**
 * Sandbox confinement integration test.
 *
 * With a write context pointed at a sandbox root (as --root does), `tuck restore`
 * must write the restored file UNDER the sandbox root and must NOT touch the
 * real home path — proving an agent can restore into a throwaway home without
 * any possibility of mutating the operator's real config.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { setWriteContext, resetWriteContext } from '../../src/lib/writeContext.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { clearConfigCache } from '../../src/lib/config.js';

const TUCK = '/test-home/.tuck';
const SANDBOX = '/test-home/sandbox';

const seedRepo = async (repoContent: string) => {
  vol.mkdirSync(`${TUCK}/files/shell`, { recursive: true });
  vol.writeFileSync(`${TUCK}/files/shell/zshrc`, repoContent);
  const { getFileChecksum } = await import('../../src/lib/files.js');
  const checksum = await getFileChecksum(`${TUCK}/files/shell/zshrc`);
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
};

describe('tuck restore under a sandbox root', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
    resetWriteContext();
    vol.mkdirSync('/test-home', { recursive: true });
  });
  afterEach(() => resetWriteContext());

  it('writes restored files under --root and never to the real home', async () => {
    await seedRepo('export SANDBOX_OK=1\n');
    setWriteContext({ root: SANDBOX, isSandbox: true });

    const { runRestoreCommand } = await import('../../src/commands/restore.js');
    await runRestoreCommand(['~/.zshrc'], {
      yes: true,
      noHooks: true,
      noSecrets: true,
    } as never);

    // Written into the sandbox...
    expect(vol.existsSync(`${SANDBOX}/.zshrc`)).toBe(true);
    expect(vol.readFileSync(`${SANDBOX}/.zshrc`, 'utf-8')).toBe('export SANDBOX_OK=1\n');
    // ...and the real home was never touched.
    expect(vol.existsSync('/test-home/.zshrc')).toBe(false);
  });
});
