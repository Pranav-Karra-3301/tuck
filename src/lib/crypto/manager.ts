/**
 * High-level encryption manager for tuck
 * Handles password management, keychain integration, and config updates
 */

import { loadConfig, saveConfig } from '../config.js';
import { getTuckDir } from '../paths.js';
import {
  generateSalt,
  generateVerificationHash,
  verifyPassword,
  encryptBuffer,
  decryptBuffer,
} from './encryption.js';
import { getKeystore, TUCK_SERVICE, TUCK_ACCOUNT } from './keystore/index.js';
import { EncryptionError, DecryptionError } from '../../errors.js';

export interface EncryptionStatus {
  enabled: boolean;
  keystoreType: string;
  hasStoredPassword: boolean;
}

/**
 * Check if encryption is enabled and configured
 */
export const getEncryptionStatus = async (): Promise<EncryptionStatus> => {
  const config = await loadConfig(getTuckDir());
  const keystore = await getKeystore();
  const storedPassword = await keystore.retrieve(TUCK_SERVICE, TUCK_ACCOUNT);

  return {
    enabled: config.encryption?.backupsEnabled ?? false,
    keystoreType: keystore.getName(),
    hasStoredPassword: storedPassword !== null,
  };
};

/**
 * Check if backup encryption is enabled
 */
export const isEncryptionEnabled = async (): Promise<boolean> => {
  const config = await loadConfig(getTuckDir());
  return config.encryption?.backupsEnabled ?? false;
};

/**
 * Set up encryption with a new password
 * Stores password in keychain and verification data in config
 */
export const setupEncryption = async (password: string): Promise<void> => {
  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  // Generate salt for password verification
  const salt = generateSalt();
  const verificationHash = generateVerificationHash(password, salt);

  // Store password in keychain
  const keystore = await getKeystore();
  await keystore.store(TUCK_SERVICE, TUCK_ACCOUNT, password);

  // Update config with encryption settings
  config.encryption = {
    ...config.encryption,
    backupsEnabled: true,
    _verificationSalt: salt.toString('hex'),
    _verificationHash: verificationHash,
  };

  await saveConfig(config, tuckDir);
};

/**
 * Disable encryption
 * Removes password from keychain but keeps verification data for potential re-enable
 */
export const disableEncryption = async (): Promise<void> => {
  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  // Remove from keychain
  const keystore = await getKeystore();
  await keystore.delete(TUCK_SERVICE, TUCK_ACCOUNT);

  // Update config
  config.encryption = {
    ...config.encryption,
    backupsEnabled: false,
  };

  await saveConfig(config, tuckDir);
};

/**
 * Get the encryption password
 * Tries keychain first, returns null if not found
 */
export const getStoredPassword = async (): Promise<string | null> => {
  const keystore = await getKeystore();
  return keystore.retrieve(TUCK_SERVICE, TUCK_ACCOUNT);
};

/**
 * Store a password in the keychain
 */
export const storePassword = async (password: string): Promise<void> => {
  const keystore = await getKeystore();
  await keystore.store(TUCK_SERVICE, TUCK_ACCOUNT, password);
};

/**
 * Verify a password against stored verification data
 * Returns true if password is correct
 */
export const verifyStoredPassword = async (password: string): Promise<boolean> => {
  const config = await loadConfig(getTuckDir());

  const saltHex = config.encryption?._verificationSalt;
  const expectedHash = config.encryption?._verificationHash;

  if (!saltHex || !expectedHash) {
    // No verification data, assume password is correct
    // (this handles migration from unencrypted state)
    return true;
  }

  const salt = Buffer.from(saltHex, 'hex');
  return verifyPassword(password, salt, expectedHash);
};

/**
 * Change the encryption password
 * Re-encrypts verification data and updates keychain
 */
export const changePassword = async (oldPassword: string, newPassword: string): Promise<void> => {
  // Verify old password first
  const isValid = await verifyStoredPassword(oldPassword);
  if (!isValid) {
    throw new EncryptionError('Current password is incorrect');
  }

  // Set up with new password
  await setupEncryption(newPassword);
};

/**
 * Encrypt data using stored password or provided password
 */
export const encryptData = async (data: Buffer, password?: string): Promise<Buffer> => {
  const pwd = password || (await getStoredPassword());
  if (!pwd) {
    throw new EncryptionError('No encryption password available', [
      'Run `tuck encryption setup` to configure encryption',
      'Or provide password with --password flag',
    ]);
  }

  return encryptBuffer(data, pwd);
};

/**
 * Decrypt data using stored password or provided password
 */
export const decryptData = async (encrypted: Buffer, password?: string): Promise<Buffer> => {
  const pwd = password || (await getStoredPassword());
  if (!pwd) {
    throw new DecryptionError('No decryption password available', [
      'Enter your backup password when prompted',
      'Or provide password with --password flag',
    ]);
  }

  try {
    return decryptBuffer(encrypted, pwd);
  } catch (error) {
    throw new DecryptionError('Wrong password or corrupted data', [
      'Verify you are using the correct password',
      'The backup file may have been corrupted',
    ]);
  }
};

/**
 * Get password for encryption/decryption operations
 * Returns stored password or null if not available
 * Caller should prompt user if null is returned
 */
export const getPasswordOrNull = async (): Promise<string | null> => {
  return getStoredPassword();
};
