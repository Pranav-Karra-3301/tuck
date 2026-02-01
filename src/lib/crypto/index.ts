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
  isEncryptionEnabled,
  setupEncryption,
  disableEncryption,
  getStoredPassword,
  storePassword,
  verifyStoredPassword,
  changePassword,
  encryptData,
  decryptData,
  getPasswordOrNull,
} from './manager.js';

export type { EncryptionStatus } from './manager.js';
