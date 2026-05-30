import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join } from 'path';
import { createHash, createCipheriv, randomBytes } from 'crypto';
import { TEST_HOME } from '../setup.js';
import { FallbackKeystore } from '../../src/lib/crypto/keystore/fallback.js';

// The per-install random secret lives alongside the user's tuck dir.
const keystoreKeyPath = () => join(homedir(), '.tuck', 'keystore.key');

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

  it('persists a 32-byte random secret at ~/.tuck/keystore.key on first use', async () => {
    expect(existsSync(keystoreKeyPath())).toBe(false);

    const ks = new FallbackKeystore();
    await ks.store('svc', 'acct', 'topsecret');

    expect(existsSync(keystoreKeyPath())).toBe(true);
    const secret = readFileSync(keystoreKeyPath());
    expect(secret.length).toBe(32);
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
