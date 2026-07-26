/**
 * High-level encryption manager for tuck
 * Handles password management, keychain integration, and config updates
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir } from 'fs-extra';
import { loadConfig, saveConfig } from '../config.js';
import { getTuckDir, pathExists } from '../paths.js';
import { getStateDir } from '../state.js';
import { atomicWriteFile } from '../files.js';
import {
  generateSalt,
  generateVerificationHash,
  verifyPassword,
} from './encryption.js';
import { getKeystore, TUCK_SERVICE, TUCK_ACCOUNT } from './keystore/index.js';
import { EncryptionError } from '../../errors.js';

interface VerificationData {
  salt: string;
  hash: string;
}

/**
 * Path to the off-repo password-verification file. This is derived from the
 * user's password (salt + scrypt/SHA hash) and MUST NOT live in the tracked
 * `.tuckrc.json`, which is committed and pushed — storing it there would let
 * anyone with the (often public) remote brute-force the password offline.
 */
export const getEncryptionVerifyPath = (): string =>
  join(getStateDir(), 'encryption-verify.json');

/** Read the off-repo verification data, or null if absent/corrupt. */
const loadEncryptionVerification = async (): Promise<VerificationData | null> => {
  const p = getEncryptionVerifyPath();
  if (!(await pathExists(p))) return null;
  try {
    const data = JSON.parse(await readFile(p, 'utf-8'));
    if (typeof data?.salt === 'string' && typeof data?.hash === 'string') {
      return { salt: data.salt, hash: data.hash };
    }
  } catch {
    // fall through
  }
  return null;
};

/** Generate and persist (off-repo, 0600) the verification data for a password. */
export const writeEncryptionVerification = async (password: string): Promise<void> => {
  const salt = generateSalt();
  const hash = generateVerificationHash(password, salt);
  await ensureDir(getStateDir());
  await atomicWriteFile(
    getEncryptionVerifyPath(),
    JSON.stringify({ salt: salt.toString('hex'), hash }, null, 2) + '\n',
    { mode: 0o600 }
  );
};

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
 * Set up encryption with a new password
 * Stores password in keychain and verification data in config
 */
export const setupEncryption = async (password: string): Promise<void> => {
  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  // Persist password-verification data OFF-REPO (never in the tracked config).
  await writeEncryptionVerification(password);

  // Store password in keychain
  const keystore = await getKeystore();
  await keystore.store(TUCK_SERVICE, TUCK_ACCOUNT, password);

  // Update config with encryption settings; migrate out any legacy committed
  // verification fields by explicitly clearing them (JSON.stringify drops them).
  config.encryption = {
    ...config.encryption,
    backupsEnabled: true,
    _verificationSalt: undefined,
    _verificationHash: undefined,
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
 * Verify a password against stored verification data
 * Returns true if password is correct
 */
export const verifyStoredPassword = async (password: string): Promise<boolean> => {
  // Prefer the off-repo verification data; fall back to legacy fields that may
  // still be present in an older committed config (which a re-setup migrates out).
  let saltHex: string | undefined;
  let expectedHash: string | undefined;

  const offRepo = await loadEncryptionVerification();
  if (offRepo) {
    saltHex = offRepo.salt;
    expectedHash = offRepo.hash;
  } else {
    const config = await loadConfig(getTuckDir());
    saltHex = config.encryption?._verificationSalt;
    expectedHash = config.encryption?._verificationHash;
  }

  // No verification data anywhere: we cannot prove the password is correct, so
  // refuse rather than silently accepting it (the old behavior made the
  // change-password old-password check a no-op).
  if (!saltHex || !expectedHash) {
    return false;
  }

  return verifyPassword(password, Buffer.from(saltHex, 'hex'), expectedHash);
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
