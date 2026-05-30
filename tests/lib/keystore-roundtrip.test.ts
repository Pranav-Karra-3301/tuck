/**
 * Round-trip tests for the REAL (non-mocked) FallbackKeystore.
 *
 * These run under the project's global memfs mocks: fs / fs/promises / fs-extra
 * are backed by memfs and os.homedir() returns TEST_HOME (/test-home). The
 * keystore encrypts to a file under memfs and derives a machine key from a
 * per-install random secret written under ~/.tuck/keystore.key — all inside the
 * virtual FS, so nothing touches the real home, real disk, or real network.
 *
 * The guarantee being locked in: store -> retrieve returns the value
 * BYTE-FOR-BYTE. The encrypted file keystore must NOT trim, normalize, or
 * otherwise mangle the secret (notably leading/trailing whitespace), and must
 * preserve full Unicode. We exercise the real AES-256-GCM encrypt/decrypt path,
 * overwrite semantics, missing-key reads, and delete.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME } from '../utils/testHelpers.js';
import { FallbackKeystore } from '../../src/lib/crypto/keystore/fallback.js';

const SERVICE = 'tuck-dotfiles';
const ACCOUNT = 'backup-encryption';

// A custom on-disk (memfs) path keeps each test's keystore self-contained and
// inside TEST_HOME, away from any real path.
const keystorePath = (): string => join(TEST_HOME, '.tuck', 'state', 'keystore.enc');

describe('FallbackKeystore round-trip', () => {
  beforeEach(() => {
    // setup.ts already resets the vol and recreates TEST_HOME before each test,
    // but make the working dirs explicit so the keystore's writes have a parent.
    vol.mkdirSync(join(TEST_HOME, '.tuck', 'state'), { recursive: true });
  });

  it('stores and retrieves a plain secret unchanged', async () => {
    const ks = new FallbackKeystore(keystorePath());
    const secret = 'correct horse battery staple';

    await ks.store(SERVICE, ACCOUNT, secret);
    const retrieved = await ks.retrieve(SERVICE, ACCOUNT);

    expect(retrieved).toBe(secret);
  });

  it('preserves leading/trailing whitespace byte-for-byte (must NOT trim)', async () => {
    const ks = new FallbackKeystore(keystorePath());
    // Leading spaces, trailing spaces, a tab, and a trailing newline. A naive
    // .trim() anywhere in the keystore would silently corrupt this value.
    const secret = '   pad-left and pad-right \t\n';

    await ks.store(SERVICE, ACCOUNT, secret);
    const retrieved = await ks.retrieve(SERVICE, ACCOUNT);

    expect(retrieved).toBe(secret);
    // Be explicit that the surrounding whitespace survived intact.
    expect(retrieved).not.toBe(secret.trim());
    expect(retrieved?.startsWith('   ')).toBe(true);
    expect(retrieved?.endsWith(' \t\n')).toBe(true);
    expect(retrieved).toHaveLength(secret.length);
  });

  it('preserves Unicode / emoji secrets', async () => {
    const ks = new FallbackKeystore(keystorePath());
    const secret = 'pâsswörd-🔐-naïve-Ωμέγα-字句';

    await ks.store(SERVICE, ACCOUNT, secret);
    const retrieved = await ks.retrieve(SERVICE, ACCOUNT);

    expect(retrieved).toBe(secret);
  });

  it('overwrites an existing secret for the same service/account', async () => {
    const ks = new FallbackKeystore(keystorePath());

    await ks.store(SERVICE, ACCOUNT, 'first-value');
    await ks.store(SERVICE, ACCOUNT, 'second-value');

    const retrieved = await ks.retrieve(SERVICE, ACCOUNT);
    expect(retrieved).toBe('second-value');
  });

  it('returns null when retrieving a secret that was never stored', async () => {
    const ks = new FallbackKeystore(keystorePath());

    // Store something for a DIFFERENT account so the keystore file exists and is
    // decryptable, then read a missing account.
    await ks.store(SERVICE, 'some-other-account', 'x');

    const missing = await ks.retrieve(SERVICE, ACCOUNT);
    expect(missing).toBeNull();

    // A completely unknown service is null too.
    const missingService = await ks.retrieve('no-such-service', ACCOUNT);
    expect(missingService).toBeNull();
  });

  it('returns null after deleting a stored secret', async () => {
    const ks = new FallbackKeystore(keystorePath());

    await ks.store(SERVICE, ACCOUNT, 'to-be-deleted');
    expect(await ks.retrieve(SERVICE, ACCOUNT)).toBe('to-be-deleted');

    await ks.delete(SERVICE, ACCOUNT);
    expect(await ks.retrieve(SERVICE, ACCOUNT)).toBeNull();

    // Deleting again is a no-op and must not throw.
    await expect(ks.delete(SERVICE, ACCOUNT)).resolves.toBeUndefined();
    expect(await ks.retrieve(SERVICE, ACCOUNT)).toBeNull();
  });

  it('round-trips across a fresh keystore instance reading the same file', async () => {
    // The point of an ENCRYPTED FILE keystore is durability across processes.
    // A second instance pointed at the same path must decrypt and read back the
    // exact value the first instance wrote (machine key is deterministic here).
    const path = keystorePath();
    const writer = new FallbackKeystore(path);
    const secret = '  persisted across instances 🗝 ';

    await writer.store(SERVICE, ACCOUNT, secret);

    const reader = new FallbackKeystore(path);
    expect(await reader.retrieve(SERVICE, ACCOUNT)).toBe(secret);
  });
});
