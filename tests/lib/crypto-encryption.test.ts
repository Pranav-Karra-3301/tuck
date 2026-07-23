/**
 * Crypto encryption unit tests (real node crypto, small payloads).
 *
 * Covers logic touched this session:
 *  - deriveKey now passes maxmem so scryptSync actually runs (Node's 32 MiB
 *    default maxmem is below the 128 MiB the tuned params require, so without
 *    the fix every derive threw "memory limit exceeded").
 *  - encryptBuffer -> decryptBuffer round-trip (and wrong password fails).
 *  - generateVerificationHash / verifyPassword agree.
 *  - verifyStoredPassword falls back to the LEGACY committed config fields
 *    (_verificationSalt / _verificationHash) when no off-repo file exists.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  deriveKey,
  encryptBuffer,
  decryptBuffer,
  generateVerificationHash,
  verifyPassword,
  generateSalt,
} from '../../src/lib/crypto/encryption.js';
import { verifyStoredPassword, getEncryptionVerifyPath } from '../../src/lib/crypto/manager.js';
import { clearConfigCache } from '../../src/lib/config.js';

describe('crypto/encryption (real node crypto)', () => {
  describe('deriveKey', () => {
    it('derives a 32-byte key without throwing (maxmem fix)', () => {
      const salt = generateSalt();
      const key = deriveKey('hunter2', salt);
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    });

    it('is deterministic for the same password + salt', () => {
      const salt = generateSalt();
      const a = deriveKey('hunter2', salt);
      const b = deriveKey('hunter2', salt);
      expect(a.equals(b)).toBe(true);
    });

    it('produces different keys for different passwords with the same salt', () => {
      const salt = generateSalt();
      const a = deriveKey('hunter2', salt);
      const b = deriveKey('hunter3', salt);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('encryptBuffer / decryptBuffer round-trip', () => {
    it('decrypts back to the original plaintext', () => {
      const plaintext = Buffer.from('alias g=git\n', 'utf-8');
      const encrypted = encryptBuffer(plaintext, 'correct horse');
      const decrypted = decryptBuffer(encrypted, 'correct horse');
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('round-trips an empty buffer', () => {
      const plaintext = Buffer.alloc(0);
      const encrypted = encryptBuffer(plaintext, 'pw');
      const decrypted = decryptBuffer(encrypted, 'pw');
      expect(decrypted.length).toBe(0);
    });

    it('produces a different ciphertext each call (fresh salt + iv)', () => {
      const plaintext = Buffer.from('same input', 'utf-8');
      const a = encryptBuffer(plaintext, 'pw');
      const b = encryptBuffer(plaintext, 'pw');
      expect(a.equals(b)).toBe(false);
    });

    it('fails to decrypt with the wrong password', () => {
      const encrypted = encryptBuffer(Buffer.from('secret', 'utf-8'), 'right');
      expect(() => decryptBuffer(encrypted, 'wrong')).toThrow(
        /wrong password or corrupted data/i
      );
    });

    it('rejects data shorter than the header', () => {
      expect(() => decryptBuffer(Buffer.from('tiny'), 'pw')).toThrow(/too short/i);
    });

    it('rejects data with a bad magic header', () => {
      // Build a buffer of the right length but with garbage where the magic goes.
      const valid = encryptBuffer(Buffer.from('x'), 'pw');
      const corrupted = Buffer.from(valid);
      corrupted.write('NOTTUCKHDR0', 0); // overwrite the magic bytes
      expect(() => decryptBuffer(corrupted, 'pw')).toThrow(/bad magic header/i);
    });
  });

  describe('generateVerificationHash / verifyPassword', () => {
    it('verifyPassword accepts the password its hash was generated from', () => {
      const salt = generateSalt();
      const hash = generateVerificationHash('s3cret', salt);
      expect(verifyPassword('s3cret', salt, hash)).toBe(true);
    });

    it('verifyPassword rejects a different password', () => {
      const salt = generateSalt();
      const hash = generateVerificationHash('s3cret', salt);
      expect(verifyPassword('nope', salt, hash)).toBe(false);
    });

    it('verifyPassword rejects when the salt differs', () => {
      const hash = generateVerificationHash('s3cret', generateSalt());
      expect(verifyPassword('s3cret', generateSalt(), hash)).toBe(false);
    });

    it('verifyPassword returns false for a malformed (wrong-length) hash', () => {
      const salt = generateSalt();
      expect(verifyPassword('s3cret', salt, 'deadbeef')).toBe(false);
    });

    it('verifyPassword returns false (never throws) for a non-hex hash of full string length', () => {
      // 64 chars like a real sha256 hex digest, but not valid hex. The hex
      // decode yields a short/empty buffer, so the length guard must reject
      // before timingSafeEqual (which throws on unequal-length buffers).
      const salt = generateSalt();
      expect(() => verifyPassword('s3cret', salt, 'z'.repeat(64))).not.toThrow();
      expect(verifyPassword('s3cret', salt, 'z'.repeat(64))).toBe(false);
    });

    it('verifyPassword still rejects a hash off by a single byte (constant-time compare stays strict)', () => {
      const salt = generateSalt();
      const hash = generateVerificationHash('s3cret', salt);
      // Flip the last hex nibble → a valid-length, valid-hex, but wrong digest.
      const lastChar = hash[hash.length - 1];
      const flipped = hash.slice(0, -1) + (lastChar === '0' ? '1' : '0');
      expect(verifyPassword('s3cret', salt, flipped)).toBe(false);
    });
  });
});

describe('verifyStoredPassword legacy config fallback', () => {
  beforeEach(() => {
    clearConfigCache();
    vol.mkdirSync('/test-home/.tuck', { recursive: true });
  });

  it('uses _verificationSalt/_verificationHash from the committed config when no off-repo file exists', async () => {
    // Sanity: the off-repo verification file must be absent for this path.
    expect(vol.existsSync(getEncryptionVerifyPath())).toBe(false);

    // Write a legacy-style committed config carrying the verification fields.
    const salt = generateSalt();
    const hash = generateVerificationHash('legacy-pass', salt);
    vol.writeFileSync(
      '/test-home/.tuck/.tuckrc.json',
      JSON.stringify({
        encryption: {
          backupsEnabled: true,
          _verificationSalt: salt.toString('hex'),
          _verificationHash: hash,
        },
      })
    );

    expect(await verifyStoredPassword('legacy-pass')).toBe(true);
    expect(await verifyStoredPassword('wrong-pass')).toBe(false);
  });

  it('returns false when the config has no verification fields and no off-repo file exists', async () => {
    vol.writeFileSync(
      '/test-home/.tuck/.tuckrc.json',
      JSON.stringify({ encryption: { backupsEnabled: true } })
    );
    expect(await verifyStoredPassword('anything')).toBe(false);
  });
});
