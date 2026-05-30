/**
 * Manifest-permissions round-trip integration test.
 *
 * The manifest records each tracked file's `permissions` (e.g. "755" for an
 * executable script, "600" for a secret), but restore historically only fixed
 * permissions for SSH/GPG files. A restored 0755 script must come back
 * executable, and a 0600 file must NOT become world-readable.
 *
 * This drives the real `runRestoreCommand` against a memfs sandbox root (as
 * `--root` does) so nothing touches the real home, and memfs preserves chmod
 * mode bits — giving a genuine permission round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { setWriteContext, resetWriteContext } from '../../src/lib/writeContext.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { clearConfigCache } from '../../src/lib/config.js';

const TUCK = '/test-home/.tuck';
const SANDBOX = '/test-home/sandbox';

const seedRepo = async (
  destination: string,
  source: string,
  permissions: string,
  repoContent: string,
  repoMode: number
) => {
  const repoFile = `${TUCK}/${destination}`;
  vol.mkdirSync(repoFile.slice(0, repoFile.lastIndexOf('/')), { recursive: true });
  vol.writeFileSync(repoFile, repoContent, { mode: repoMode });
  const { getFileChecksum } = await import('../../src/lib/files.js');
  const checksum = await getFileChecksum(repoFile);
  vol.writeFileSync(
    `${TUCK}/.tuckrc.json`,
    JSON.stringify({
      repository: { path: TUCK },
      files: { strategy: 'copy', backupOnRestore: false },
    })
  );
  vol.writeFileSync(
    `${TUCK}/.tuckmanifest.json`,
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: {
        entry: {
          source,
          destination,
          category: 'misc',
          strategy: 'copy',
          permissions,
          checksum,
          added: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      },
      bundles: {},
    })
  );
};

describe('restore honors manifest permissions for non-ssh/gpg files', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
    resetWriteContext();
    vol.mkdirSync('/test-home', { recursive: true });
  });
  afterEach(() => resetWriteContext());

  it.skipIf(process.platform === 'win32')(
    'restores a 0755 script as executable',
    async () => {
      // Repo copy is stored 0644 (the default for a committed text file); the
      // manifest says the live file should be 0755.
      await seedRepo('files/misc/deploy.sh', '~/deploy.sh', '755', '#!/bin/sh\n', 0o644);
      setWriteContext({ root: SANDBOX, isSandbox: true });

      const { runRestoreCommand } = await import('../../src/commands/restore.js');
      await runRestoreCommand(['~/deploy.sh'], {
        yes: true,
        noHooks: true,
        noSecrets: true,
      } as never);

      const target = `${SANDBOX}/deploy.sh`;
      expect(vol.existsSync(target)).toBe(true);
      const mode = vol.statSync(target).mode & 0o777;
      expect(mode.toString(8)).toBe('755');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'restores a 0600 file without making it world-readable',
    async () => {
      await seedRepo('files/misc/token.env', '~/token.env', '600', 'TOKEN=x\n', 0o644);
      setWriteContext({ root: SANDBOX, isSandbox: true });

      const { runRestoreCommand } = await import('../../src/commands/restore.js');
      await runRestoreCommand(['~/token.env'], {
        yes: true,
        noHooks: true,
        noSecrets: true,
      } as never);

      const target = `${SANDBOX}/token.env`;
      expect(vol.existsSync(target)).toBe(true);
      const mode = vol.statSync(target).mode & 0o777;
      expect(mode.toString(8)).toBe('600');
    }
  );
});
