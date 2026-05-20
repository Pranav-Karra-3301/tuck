/**
 * Tests for file-level encryption (TCKE1 format).
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  encryptFileContent,
  decryptFileContent,
  isEncryptedFile,
} from './fileEncryption.js';
import { DecryptionError, EncryptionError } from '../../errors.js';

describe('fileEncryption', () => {
  const passphrase = 'correct horse battery staple';

  describe('round-trip', () => {
    it('encrypts then decrypts back to the original plaintext', async () => {
      const plaintext = Buffer.from('export PATH="$HOME/bin:$PATH"\nalias g=git\n', 'utf-8');
      const encrypted = await encryptFileContent(plaintext, passphrase);
      const decrypted = await decryptFileContent(encrypted, passphrase);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('produces a different ciphertext on each call (fresh salt/iv)', async () => {
      const plaintext = Buffer.from('same input', 'utf-8');
      const a = await encryptFileContent(plaintext, passphrase);
      const b = await encryptFileContent(plaintext, passphrase);

      expect(a.equals(b)).toBe(false);

      // Both should decrypt to the same plaintext.
      const da = await decryptFileContent(a, passphrase);
      const db = await decryptFileContent(b, passphrase);
      expect(da.equals(plaintext)).toBe(true);
      expect(db.equals(plaintext)).toBe(true);
    });

    it('round-trips an empty buffer', async () => {
      const empty = Buffer.alloc(0);
      const encrypted = await encryptFileContent(empty, passphrase);

      // Encrypted form is non-empty (carries header + auth tag).
      expect(encrypted.length).toBeGreaterThan(0);
      expect(isEncryptedFile(encrypted)).toBe(true);

      const decrypted = await decryptFileContent(encrypted, passphrase);
      expect(decrypted.length).toBe(0);
      expect(decrypted.equals(empty)).toBe(true);
    });

    it('round-trips a large (>=1MB) random buffer', async () => {
      const size = 1024 * 1024 + 17; // just over 1 MiB to exercise block boundaries
      const plaintext = randomBytes(size);

      const encrypted = await encryptFileContent(plaintext, passphrase);
      const decrypted = await decryptFileContent(encrypted, passphrase);

      expect(decrypted.length).toBe(plaintext.length);
      expect(decrypted.equals(plaintext)).toBe(true);
    });
  });

  describe('wrong passphrase', () => {
    it('throws DecryptionError when the passphrase is incorrect', async () => {
      const plaintext = Buffer.from('top secret');
      const encrypted = await encryptFileContent(plaintext, passphrase);

      await expect(decryptFileContent(encrypted, 'wrong passphrase')).rejects.toBeInstanceOf(
        DecryptionError
      );
    });

    it('throws DecryptionError when the ciphertext is tampered with', async () => {
      const plaintext = Buffer.from('payload');
      const encrypted = await encryptFileContent(plaintext, passphrase);

      // Flip a single byte at the end (in the ciphertext region).
      const tampered = Buffer.from(encrypted);
      tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;

      await expect(decryptFileContent(tampered, passphrase)).rejects.toBeInstanceOf(
        DecryptionError
      );
    });
  });

  describe('isEncryptedFile', () => {
    it('returns true for buffers with the TCKE1 magic header', async () => {
      const encrypted = await encryptFileContent(Buffer.from('hello'), passphrase);
      expect(isEncryptedFile(encrypted)).toBe(true);
    });

    it('returns false for plaintext that does not start with the magic', () => {
      expect(isEncryptedFile(Buffer.from('export PATH=...'))).toBe(false);
      expect(isEncryptedFile(Buffer.from('plain text contents'))).toBe(false);
    });

    it('returns false for buffers shorter than the magic header', () => {
      expect(isEncryptedFile(Buffer.alloc(0))).toBe(false);
      expect(isEncryptedFile(Buffer.from('TCK'))).toBe(false);
    });

    it('returns false for buffers that look similar but differ', () => {
      // 5-byte prefix that is not exactly "TCKE1".
      expect(isEncryptedFile(Buffer.from('TCKE0extra'))).toBe(false);
      expect(isEncryptedFile(Buffer.from('tcke1extra'))).toBe(false);
    });
  });

  describe('input validation', () => {
    it('throws EncryptionError when the passphrase is empty', async () => {
      await expect(encryptFileContent(Buffer.from('x'), '')).rejects.toBeInstanceOf(
        EncryptionError
      );
    });

    it('throws DecryptionError when the passphrase is empty', async () => {
      const encrypted = await encryptFileContent(Buffer.from('x'), passphrase);
      await expect(decryptFileContent(encrypted, '')).rejects.toBeInstanceOf(DecryptionError);
    });

    it('throws DecryptionError when the buffer lacks the magic header', async () => {
      const bogus = Buffer.alloc(128, 0);
      await expect(decryptFileContent(bogus, passphrase)).rejects.toBeInstanceOf(DecryptionError);
    });

    it('throws DecryptionError when the buffer is shorter than the header', async () => {
      const short = Buffer.from('TCKE1');
      await expect(decryptFileContent(short, passphrase)).rejects.toBeInstanceOf(DecryptionError);
    });
  });
});
