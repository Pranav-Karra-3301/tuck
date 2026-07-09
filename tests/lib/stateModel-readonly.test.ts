/**
 * The read-only guarantee, end-to-end at the state-model layer.
 *
 * An encrypted tracked file holds ciphertext in the repo and plaintext live.
 * Read-only commands (status/diff/list) must classify its drift WITHOUT ever
 * unlocking the keystore. These tests prove:
 *   1. A read-only state computation never calls the keystore, even for an
 *      encrypted file (the keystore mock throws if touched).
 *   2. A full (non-read-only) run warms the keyed-HMAC drift cache, after which
 *      a read-only run accurately reports "ok" (unchanged) and "drift-local"
 *      (after the live file is edited) — again with zero keystore access.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';

// If a read-only path ever reaches the OS keystore, retrieve() throws and the
// test fails loudly — this is the regression tripwire for the guarantee.
vi.mock('../../src/lib/crypto/keystore/index.js', () => ({
  getKeystore: async () => ({
    retrieve: async () => {
      throw new Error('KEYSTORE ACCESSED — read-only guarantee violated');
    },
    store: async () => undefined,
    delete: async () => undefined,
    isAvailable: async () => true,
    getName: () => 'mock',
  }),
  getKeystoreName: async () => 'mock',
  clearKeystoreCache: () => undefined,
  TUCK_SERVICE: 'tuck-dotfiles',
  TUCK_ACCOUNT: 'backup-encryption',
}));

import { computeFileState } from '../../src/lib/stateModel.js';
import { encryptFileContent } from '../../src/lib/crypto/fileEncryption.js';
import { getFileChecksum } from '../../src/lib/files.js';
import { resetDriftKeyCache } from '../../src/lib/crypto/driftCache.js';
import { enterReadOnlyMode, resetReadOnlyMode } from '../../src/lib/readOnlyMode.js';
import {
  primeSessionKeyCache,
  clearSessionKeyCache,
} from '../../src/lib/crypto/sessionKeyCache.js';
import type { TrackedFileOutput } from '../../src/schemas/manifest.schema.js';

const HOME = '/test-home';
const TUCK = '/test-home/.tuck';
const PASS = 'test-pass';
const PLAINTEXT = 'secret file body\nline two\n';

const makeEncryptedFile = (checksum: string): TrackedFileOutput => ({
  source: '~/.secretrc',
  destination: 'files/secretrc',
  category: 'shell',
  strategy: 'copy',
  encrypted: true,
  template: false,
  added: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z',
  checksum,
  bundle: 'default',
});

/** Write repo ciphertext + live plaintext; return the file entry + repo checksum. */
const setupEncrypted = async (): Promise<{ file: TrackedFileOutput; repoChecksum: string }> => {
  const cipher = await encryptFileContent(Buffer.from(PLAINTEXT), PASS);
  vol.mkdirSync(`${TUCK}/files`, { recursive: true });
  vol.writeFileSync(`${TUCK}/files/secretrc`, cipher);
  vol.writeFileSync(`${HOME}/.secretrc`, PLAINTEXT);
  const repoChecksum = await getFileChecksum(`${TUCK}/files/secretrc`);
  return { file: makeEncryptedFile(repoChecksum), repoChecksum };
};

describe('stateModel read-only guarantee', () => {
  beforeEach(() => {
    resetDriftKeyCache();
    clearSessionKeyCache();
    resetReadOnlyMode();
  });
  afterEach(() => {
    resetReadOnlyMode();
    clearSessionKeyCache();
  });

  it('read-only classification of an encrypted file never touches the keystore', async () => {
    const { file } = await setupEncrypted();
    enterReadOnlyMode();
    // No drift cache warmed yet → cannot know → degrades to ok, but crucially
    // does NOT throw (the keystore mock would throw if accessed).
    const entry = await computeFileState(TUCK, 'f1', file);
    expect(entry.state).toBe('ok');
  });

  it('a full run warms the cache; a later read-only run stays accurate and prompt-free', async () => {
    const { file } = await setupEncrypted();

    // Full (non-read-only) run: decrypt with the primed session passphrase (so
    // the keystore is never fetched) and record the keyed-HMAC fingerprint.
    primeSessionKeyCache(PASS);
    const warm = await computeFileState(TUCK, 'f1', file);
    expect(warm.state).toBe('ok');

    // Now go read-only and drop the cached passphrase entirely.
    clearSessionKeyCache();
    enterReadOnlyMode();

    // Unchanged live file → cache says match → ok, with no keystore access.
    const unchanged = await computeFileState(TUCK, 'f1', file);
    expect(unchanged.state).toBe('ok');

    // Edit the live file → cache says mismatch → drift-local, still no keystore.
    vol.writeFileSync(`${HOME}/.secretrc`, 'the user edited this locally\n');
    const edited = await computeFileState(TUCK, 'f1', file);
    expect(edited.state).toBe('drift-local');
  });
});
