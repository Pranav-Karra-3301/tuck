/**
 * tuck verify unit tests.
 *
 * verify is the read-only drift detector: it reports, per tracked file, whether
 * the live/repo/manifest states agree, returns a non-zero exit with --exit-code
 * when anything drifted, and emits the standard JSON envelope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { hasDrift, runVerify } from '../../src/commands/verify.js';
import { clearManifestCache } from '../../src/lib/manifest.js';

const TUCK = '/test-home/.tuck';

const writeManifest = async (sourceFile: string, repoChecksumFrom: string) => {
  const { getFileChecksum } = await import('../../src/lib/files.js');
  const checksum = await getFileChecksum(repoChecksumFrom);
  vol.writeFileSync(
    `${TUCK}/.tuckmanifest.json`,
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: {
        zshrc: {
          source: sourceFile,
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

describe('hasDrift', () => {
  it('is false when everything is ok', () => {
    expect(hasDrift({ total: 3, ok: 3, driftLocal: 0, driftRepo: 0, missingLive: 0, missingRepo: 0, missingBoth: 0 })).toBe(false);
  });
  it('is true when any file is not ok', () => {
    expect(hasDrift({ total: 3, ok: 2, driftLocal: 1, driftRepo: 0, missingLive: 0, missingRepo: 0, missingBoth: 0 })).toBe(true);
  });
});

describe('runVerify', () => {
  let writes: string[];
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    process.exitCode = 0;
    vol.mkdirSync('/test-home', { recursive: true });
    vol.mkdirSync(`${TUCK}/files/shell`, { recursive: true });
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      writes.push(String(c));
      return true;
    });
  });

  it('emits a clean JSON envelope and exit 0 when in sync', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'export A=1\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'export A=1\n');
    await writeManifest('~/.zshrc', '/test-home/.zshrc');

    await runVerify({ json: true, exitCode: true });

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck verify');
    expect(env.data.summary.ok).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it('sets a non-zero exit with --exit-code when a file drifted locally', async () => {
    vol.writeFileSync('/test-home/.zshrc', 'EDITED LOCALLY\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'original\n');
    await writeManifest('~/.zshrc', `${TUCK}/files/shell/zshrc`);

    await runVerify({ json: true, exitCode: true });

    const env = JSON.parse(writes.join('').trim());
    expect(env.data.summary.driftLocal).toBe(1);
    expect(env.data.files[0].state).toBe('drift-local');
    expect(process.exitCode).toBe(1);
  });
});
