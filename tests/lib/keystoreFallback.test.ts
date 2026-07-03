import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join } from 'path';
import { createHash, createCipheriv, randomBytes } from 'crypto';
import { TEST_HOME } from '../setup.js';
import { getStateDir } from '../../src/lib/state.js';
import { FallbackKeystore } from '../../src/lib/crypto/keystore/fallback.js';

// The per-install random secret lives in the out-of-repo state dir (alongside
// the keystore file) so `tuck sync` can never commit/push it.
const keystoreKeyPath = () => join(getStateDir(), 'keystore', 'keystore.key');
// Older tuck versions wrote it INSIDE the repo (~/.tuck/keystore.key).
const legacyKeystoreKeyPath = () => join(homedir(), '.tuck', 'keystore.key');

// Replicate the PRE-install-secret (legacy) key derivation + encrypt format so
// we can forge a keystore file exactly as an older tuck version wrote it.
const legacyMachineKey = (): Buffer =>
  createHash('sha256')
    .update([hostname(), userInfo().username, homedir(), process.platform, 'tuck-keystore-v1'].join(':'))
    .digest();

const legacyEncrypt = (plaintext: Buffer): Buffer => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', legacyMachineKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
};

describe('FallbackKeystore per-install random secret', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('persists a 32-byte random secret in the out-of-repo state dir on first use', async () => {
    expect(existsSync(keystoreKeyPath())).toBe(false);

    const ks = new FallbackKeystore();
    await ks.store('svc', 'acct', 'topsecret');

    expect(existsSync(keystoreKeyPath())).toBe(true);
    const secret = readFileSync(keystoreKeyPath());
    expect(secret.length).toBe(32);
  });

  it('never writes the install secret inside the repo (~/.tuck)', async () => {
    const ks = new FallbackKeystore();
    await ks.store('svc', 'acct', 'topsecret');

    // The in-repo location must stay empty — a committed secret would make the
    // machine key derivable again from guessable factors.
    expect(existsSync(legacyKeystoreKeyPath())).toBe(false);
  });

  it('reuses the stored secret across calls (stable key)', async () => {
    const ks = new FallbackKeystore();
    await ks.store('svc', 'acct', 'topsecret');

    const firstSecret = readFileSync(keystoreKeyPath());

    // A subsequent operation must not regenerate the secret.
    const retrieved = await ks.retrieve('svc', 'acct');
    expect(retrieved).toBe('topsecret');

    const secondSecret = readFileSync(keystoreKeyPath());
    expect(Buffer.compare(firstSecret, secondSecret)).toBe(0);
  });

  it('two different secrets yield different derived keys (swap breaks decrypt)', async () => {
    const customPath = join(TEST_HOME, 'ks-store.enc');

    // First install: random secret A is created, data encrypted under key(A).
    const ks1 = new FallbackKeystore(customPath);
    await ks1.store('svc', 'acct', 'topsecret');

    // Swap the per-install secret to a different random value (secret B).
    const altSecret = Buffer.alloc(32, 7);
    writeFileSync(keystoreKeyPath(), altSecret);

    // Reading the same encrypted store with key(B) must NOT recover the
    // plaintext (different derived key => GCM auth fails => fresh empty store).
    const ks2 = new FallbackKeystore(customPath);
    const retrieved = await ks2.retrieve('svc', 'acct');
    expect(retrieved).toBeNull();
  });
});

describe('FallbackKeystore install-secret migration out of the repo', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('migrates a legacy in-repo secret to the state dir and deletes the in-repo copy', async () => {
    // Simulate an install created by an older tuck: the 32-byte secret sits in
    // the repo at ~/.tuck/keystore.key.
    const legacySecret = Buffer.alloc(32, 3);
    mkdirSync(join(homedir(), '.tuck'), { recursive: true });
    writeFileSync(legacyKeystoreKeyPath(), legacySecret);
    expect(existsSync(keystoreKeyPath())).toBe(false);

    const ks = new FallbackKeystore();
    await ks.store('svc', 'acct', 'topsecret');

    // The secret is now in the out-of-repo state dir, byte-for-byte preserved
    // (so any data encrypted with it stays decryptable) ...
    expect(existsSync(keystoreKeyPath())).toBe(true);
    expect(Buffer.compare(readFileSync(keystoreKeyPath()), legacySecret)).toBe(0);
    // ... and the in-repo copy is gone so a later sync cannot push it.
    expect(existsSync(legacyKeystoreKeyPath())).toBe(false);
  });
});

describe('FallbackKeystore undecryptable-file handling', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('moves an undecryptable keystore aside as .corrupt instead of silently discarding it', async () => {
    const customPath = join(TEST_HOME, 'garbage-ks.enc');

    // A file that decrypts with NO known key (random bytes / truncated write).
    // The old behavior silently treated this as an empty store, so the next
    // write would overwrite it — destroying the only copy of the stored secret.
    writeFileSync(customPath, randomBytes(64));

    const ks = new FallbackKeystore(customPath);
    expect(await ks.retrieve('svc', 'acct')).toBeNull();

    // The unreadable bytes are preserved for manual recovery, not overwritten.
    expect(existsSync(`${customPath}.corrupt`)).toBe(true);
    expect(existsSync(customPath)).toBe(false);
  });
});

describe('FallbackKeystore legacy-key backward compatibility', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('reads a pre-install-secret keystore (no data loss on upgrade), then migrates it', async () => {
    const customPath = join(TEST_HOME, 'legacy-ks.enc');

    // Forge an OLD keystore file: encrypted with the deterministic-only key,
    // exactly as a tuck version before the per-install secret would have written.
    const payload = { entries: { svc: { acct: 'legacy-secret' } }, version: 1 };
    writeFileSync(customPath, legacyEncrypt(Buffer.from(JSON.stringify(payload), 'utf-8')));
    // The upgrade introduces the install secret only on first use.
    expect(existsSync(keystoreKeyPath())).toBe(false);

    // The stored secret MUST still be recoverable (via the legacy-key fallback),
    // not silently lost behind the new key.
    const ks = new FallbackKeystore(customPath);
    expect(await ks.retrieve('svc', 'acct')).toBe('legacy-secret');

    // Any write re-encrypts the whole file with the current (install-secret) key.
    await ks.store('svc2', 'acct2', 'new-secret');
    expect(existsSync(keystoreKeyPath())).toBe(true);

    const ks2 = new FallbackKeystore(customPath);
    expect(await ks2.retrieve('svc', 'acct')).toBe('legacy-secret'); // preserved
    expect(await ks2.retrieve('svc2', 'acct2')).toBe('new-secret');

    // Prove the file was genuinely migrated OFF the legacy key: swap the install
    // secret and the file no longer decrypts with either candidate key. (If it
    // were still legacy-encrypted, the legacy-key fallback would recover it.)
    writeFileSync(keystoreKeyPath(), Buffer.alloc(32, 9));
    const ks3 = new FallbackKeystore(customPath);
    expect(await ks3.retrieve('svc', 'acct')).toBeNull();
  });
});
