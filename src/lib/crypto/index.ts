/**
 * Crypto module - encryption and keystore utilities
 */

// Core encryption functions
export {
  deriveKey,
  generateVerificationHash,
  verifyPassword,
  encryptBuffer,
  decryptBuffer,
  encryptFile,
  decryptFile,
  isEncryptedFile,
  isEncryptedBuffer,
  generateSalt,
  getEncryptionOverhead,
} from './encryption.js';

// Keystore (credential storage)
export {
  getKeystore,
  getKeystoreName,
  clearKeystoreCache,
  TUCK_SERVICE,
  TUCK_ACCOUNT,
} from './keystore/index.js';

export type { Keystore } from './keystore/index.js';

// High-level encryption manager
export {
  getEncryptionStatus,
  setupEncryption,
  disableEncryption,
  getStoredPassword,
  verifyStoredPassword,
  changePassword,
} from './manager.js';

export type { EncryptionStatus } from './manager.js';

// File-level encryption (per-file, PBKDF2 + AES-256-GCM, "TCKE1" header)
// Note: aliased to avoid clashing with the file-path based `isEncryptedFile`
// exported from './encryption.js'.
export {
  encryptFileContent,
  decryptFileContent,
  isEncryptedFile as isEncryptedFileBuffer,
} from './fileEncryption.js';
