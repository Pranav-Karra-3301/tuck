/**
 * File-level encryption for tracked dotfiles.
 *
 * This module provides standalone helpers for encrypting and decrypting
 * arbitrary file contents using a user-supplied passphrase. It is intended
 * for per-file encryption of tracked dotfiles, distinct from the existing
 * backup-level encryption in `./encryption.ts` (which uses scrypt and a
 * different magic header).
 *
 * Format on disk:
 *   magic   (5 bytes)  : ASCII "TCKE1"
 *   salt    (16 bytes) : random per-encryption
 *   iv      (12 bytes) : GCM nonce
 *   authTag (16 bytes) : GCM authentication tag
 *   ciphertext (rest)
 *
 * Key derivation: PBKDF2-HMAC-SHA256 with 200,000 iterations -> 32 byte key.
 * Cipher: AES-256-GCM.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2 as pbkdf2Cb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import { EncryptionError, DecryptionError } from '../../errors.js';

const pbkdf2 = promisify(pbkdf2Cb);

const MAGIC = Buffer.from('TCKE1', 'ascii');
const MAGIC_LENGTH = MAGIC.length; // 5
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_DIGEST = 'sha256';
const ALGORITHM = 'aes-256-gcm';

const HEADER_LENGTH = MAGIC_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

/**
 * Detects whether a buffer carries the file-encryption magic header.
 *
 * Returns false for buffers that are too short or have a different prefix;
 * does NOT validate that the contents are decryptable.
 */
export const isEncryptedFile = (content: Buffer): boolean => {
  if (!Buffer.isBuffer(content)) return false;
  if (content.length < MAGIC_LENGTH) return false;
  const prefix = content.subarray(0, MAGIC_LENGTH);
  // Constant-time comparison for the magic prefix.
  return timingSafeEqual(prefix, MAGIC);
};

/**
 * Encrypts plaintext bytes with a passphrase.
 *
 * Returns a self-contained buffer:
 *   MAGIC | SALT | IV | AUTH_TAG | CIPHERTEXT
 */
export const encryptFileContent = async (
  plaintext: Buffer,
  passphrase: string
): Promise<Buffer> => {
  if (!Buffer.isBuffer(plaintext)) {
    throw new EncryptionError('Plaintext must be a Buffer');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new EncryptionError('Passphrase must be a non-empty string');
  }

  try {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = await pbkdf2(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([MAGIC, salt, iv, authTag, ciphertext]);
  } catch (error: unknown) {
    if (error instanceof EncryptionError) throw error;
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new EncryptionError(`Failed to encrypt file content: ${message}`);
  }
};

/**
 * Decrypts a buffer produced by `encryptFileContent`.
 *
 * Throws DecryptionError on bad magic, truncated headers, wrong passphrase,
 * or corrupted ciphertext.
 */
export const decryptFileContent = async (
  ciphertext: Buffer,
  passphrase: string
): Promise<Buffer> => {
  if (!Buffer.isBuffer(ciphertext)) {
    throw new DecryptionError('Ciphertext must be a Buffer');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new DecryptionError('Passphrase must be a non-empty string');
  }
  if (ciphertext.length < HEADER_LENGTH) {
    throw new DecryptionError('Encrypted payload is too short to contain a valid header');
  }
  if (!isEncryptedFile(ciphertext)) {
    throw new DecryptionError('Buffer does not contain a tuck-encrypted file (bad magic header)');
  }

  let offset = MAGIC_LENGTH;
  const salt = ciphertext.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = ciphertext.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = ciphertext.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const payload = ciphertext.subarray(offset);

  try {
    const key = await pbkdf2(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch (error: unknown) {
    // GCM authentication failure surfaces as a generic Error; treat any
    // failure here as decryption failure to avoid leaking details.
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new DecryptionError(`Failed to decrypt file content: ${message}`, [
      'Verify the passphrase is correct',
      'Ensure the file has not been modified or truncated',
    ]);
  }
};
