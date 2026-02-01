/**
 * Core encryption/decryption using AES-256-GCM
 * Uses Node.js built-in crypto module - no external dependencies
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';

// Constants
const ALGORITHM = 'aes-256-gcm';
const MAGIC_HEADER = Buffer.from('TUCK-ENC-V1');
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

// scrypt parameters - tuned for ~100ms on modern hardware
const SCRYPT_N = 2 ** 17; // 131072 - memory cost
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelism

export interface EncryptedFileHeader {
  magic: Buffer;
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Derive a 256-bit key from password using scrypt
 * scrypt is memory-hard, making it resistant to GPU/ASIC attacks
 */
export const deriveKey = (password: string, salt: Buffer): Buffer => {
  return scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
};

/**
 * Generate a verification hash for password validation
 * This allows checking if password is correct without decrypting data
 */
export const generateVerificationHash = (password: string, salt: Buffer): string => {
  const key = deriveKey(password, salt);
  return createHash('sha256').update(key).digest('hex');
};

/**
 * Verify password against stored verification hash
 */
export const verifyPassword = (password: string, salt: Buffer, expectedHash: string): boolean => {
  const hash = generateVerificationHash(password, salt);
  // Constant-time comparison to prevent timing attacks
  if (hash.length !== expectedHash.length) return false;
  let result = 0;
  for (let i = 0; i < hash.length; i++) {
    result |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return result === 0;
};

/**
 * Encrypt a buffer using AES-256-GCM
 * Returns: MAGIC_HEADER + SALT + IV + AUTH_TAG + CIPHERTEXT
 */
export const encryptBuffer = (data: Buffer, password: string): Buffer => {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Assemble encrypted file: MAGIC + SALT + IV + AUTH_TAG + CIPHERTEXT
  return Buffer.concat([MAGIC_HEADER, salt, iv, authTag, ciphertext]);
};

/**
 * Decrypt a buffer encrypted with encryptBuffer
 * Throws if decryption fails (wrong password or corrupted data)
 */
export const decryptBuffer = (encrypted: Buffer, password: string): Buffer => {
  // Validate minimum size
  const headerSize = MAGIC_HEADER.length + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (encrypted.length < headerSize) {
    throw new Error('Invalid encrypted data: too short');
  }

  // Parse header
  let offset = 0;

  const magic = encrypted.subarray(offset, offset + MAGIC_HEADER.length);
  offset += MAGIC_HEADER.length;

  if (!magic.equals(MAGIC_HEADER)) {
    throw new Error('Invalid encrypted file format: bad magic header');
  }

  const salt = encrypted.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;

  const iv = encrypted.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;

  const authTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;

  const ciphertext = encrypted.subarray(offset);

  // Derive key and decrypt
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Decryption failed: wrong password or corrupted data');
  }
};

/**
 * Encrypt a file and write to destination
 * Adds .enc extension if not present
 */
export const encryptFile = async (
  sourcePath: string,
  destPath: string,
  password: string
): Promise<void> => {
  const data = await readFile(sourcePath);
  const encrypted = encryptBuffer(data, password);
  await writeFile(destPath, encrypted);
};

/**
 * Decrypt a file and write to destination
 */
export const decryptFile = async (
  sourcePath: string,
  destPath: string,
  password: string
): Promise<void> => {
  const encrypted = await readFile(sourcePath);
  const decrypted = decryptBuffer(encrypted, password);
  await writeFile(destPath, decrypted);
};

/**
 * Check if a file is encrypted (has TUCK-ENC-V1 magic header)
 */
export const isEncryptedFile = async (filePath: string): Promise<boolean> => {
  try {
    const fd = await import('fs/promises').then((fs) => fs.open(filePath, 'r'));
    const buffer = Buffer.alloc(MAGIC_HEADER.length);
    await fd.read(buffer, 0, MAGIC_HEADER.length, 0);
    await fd.close();
    return buffer.equals(MAGIC_HEADER);
  } catch {
    return false;
  }
};

/**
 * Check if a buffer is encrypted (has TUCK-ENC-V1 magic header)
 */
export const isEncryptedBuffer = (data: Buffer): boolean => {
  if (data.length < MAGIC_HEADER.length) return false;
  return data.subarray(0, MAGIC_HEADER.length).equals(MAGIC_HEADER);
};

/**
 * Generate a random salt for password verification storage
 */
export const generateSalt = (): Buffer => {
  return randomBytes(SALT_LENGTH);
};

/**
 * Get encryption overhead in bytes
 * Useful for estimating encrypted file sizes
 */
export const getEncryptionOverhead = (): number => {
  return MAGIC_HEADER.length + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
};
