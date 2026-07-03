/**
 * File-level encryption for tracked dotfiles.
 *
 * This module provides standalone helpers for encrypting and decrypting
 * arbitrary file contents using a user-supplied passphrase. It is intended
 * for per-file encryption of tracked dotfiles, distinct from the existing
 * backup-level encryption in `./encryption.ts` (which uses scrypt and a
 * different magic header).
 *
 * Format on disk (current, "TCKE2"):
 *   magic   (5 bytes)  : ASCII "TCKE2"
 *   iters   (4 bytes)  : PBKDF2 iteration count, big-endian uint32
 *   salt    (16 bytes) : random per-encryption
 *   iv      (12 bytes) : GCM nonce
 *   authTag (16 bytes) : GCM authentication tag
 *   ciphertext (rest)
 *
 * Legacy format (read-only, "TCKE1"): identical but WITHOUT the iters field; a
 * fixed 200,000 iterations is assumed. Old .enc files (which may already be
 * committed to public remotes and cannot be rotated) stay decryptable.
 *
 * Embedding the iteration count lets us raise the KDF cost over time without a
 * new magic per bump. The current default (600,000) matches OWASP guidance for
 * PBKDF2-HMAC-SHA256; the weaker 200k legacy files remain readable.
 *
 * Key derivation: PBKDF2-HMAC-SHA256 -> 32 byte key. Cipher: AES-256-GCM.
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

const MAGIC_V1 = Buffer.from('TCKE1', 'ascii');
const MAGIC_V2 = Buffer.from('TCKE2', 'ascii');
const MAGIC_LENGTH = MAGIC_V2.length; // 5 (both magics are the same length)
const ITER_LENGTH = 4; // uint32 BE iteration count (V2 only)
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

// Current KDF cost. OWASP recommends >= 600,000 for PBKDF2-HMAC-SHA256.
const PBKDF2_ITERATIONS = 600_000;
// Fixed cost baked into the legacy V1 format (no header field).
const LEGACY_V1_ITERATIONS = 200_000;
// Guard against a malicious/corrupt header forcing an absurd KDF cost (DoS) or
// a zero-cost derivation.
const MIN_PBKDF2_ITERATIONS = 1;
const MAX_PBKDF2_ITERATIONS = 10_000_000;

const PBKDF2_DIGEST = 'sha256';
const ALGORITHM = 'aes-256-gcm';

const V1_HEADER_LENGTH = MAGIC_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
const V2_HEADER_LENGTH = MAGIC_LENGTH + ITER_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

/** Constant-time check that `content` starts with `magic`. */
const hasMagic = (content: Buffer, magic: Buffer): boolean => {
  if (content.length < MAGIC_LENGTH) return false;
  return timingSafeEqual(content.subarray(0, MAGIC_LENGTH), magic);
};

/**
 * Detects whether a buffer carries a file-encryption magic header (either the
 * current TCKE2 or the legacy TCKE1).
 *
 * Returns false for buffers that are too short or have a different prefix;
 * does NOT validate that the contents are decryptable.
 */
export const isEncryptedFile = (content: Buffer): boolean => {
  if (!Buffer.isBuffer(content)) return false;
  return hasMagic(content, MAGIC_V2) || hasMagic(content, MAGIC_V1);
};

/**
 * Encrypts plaintext bytes with a passphrase.
 *
 * Returns a self-contained buffer in the current format:
 *   MAGIC_V2 | ITERS | SALT | IV | AUTH_TAG | CIPHERTEXT
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

    const iters = Buffer.alloc(ITER_LENGTH);
    iters.writeUInt32BE(PBKDF2_ITERATIONS);

    return Buffer.concat([MAGIC_V2, iters, salt, iv, authTag, ciphertext]);
  } catch (error: unknown) {
    if (error instanceof EncryptionError) throw error;
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new EncryptionError(`Failed to encrypt file content: ${message}`);
  }
};

interface ParsedHeader {
  iterations: number;
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  payload: Buffer;
}

/** Parse the version-specific header, returning the KDF params + ciphertext. */
const parseHeader = (buffer: Buffer): ParsedHeader => {
  if (hasMagic(buffer, MAGIC_V2)) {
    if (buffer.length < V2_HEADER_LENGTH) {
      throw new DecryptionError('Encrypted payload is too short to contain a valid header');
    }
    const iterations = buffer.readUInt32BE(MAGIC_LENGTH);
    if (iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
      throw new DecryptionError('Encrypted header declares an out-of-range iteration count');
    }
    let offset = MAGIC_LENGTH + ITER_LENGTH;
    const salt = buffer.subarray(offset, (offset += SALT_LENGTH));
    const iv = buffer.subarray(offset, (offset += IV_LENGTH));
    const authTag = buffer.subarray(offset, (offset += AUTH_TAG_LENGTH));
    return { iterations, salt, iv, authTag, payload: buffer.subarray(offset) };
  }

  if (hasMagic(buffer, MAGIC_V1)) {
    if (buffer.length < V1_HEADER_LENGTH) {
      throw new DecryptionError('Encrypted payload is too short to contain a valid header');
    }
    let offset = MAGIC_LENGTH;
    const salt = buffer.subarray(offset, (offset += SALT_LENGTH));
    const iv = buffer.subarray(offset, (offset += IV_LENGTH));
    const authTag = buffer.subarray(offset, (offset += AUTH_TAG_LENGTH));
    return { iterations: LEGACY_V1_ITERATIONS, salt, iv, authTag, payload: buffer.subarray(offset) };
  }

  throw new DecryptionError('Buffer does not contain a tuck-encrypted file (bad magic header)');
};

/**
 * Decrypts a buffer produced by `encryptFileContent` (TCKE2) or an older tuck
 * (TCKE1).
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

  const { iterations, salt, iv, authTag, payload } = parseHeader(ciphertext);

  try {
    const key = await pbkdf2(passphrase, salt, iterations, KEY_LENGTH, PBKDF2_DIGEST);
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
