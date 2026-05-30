/**
 * Fallback keystore using encrypted local file
 * Used when system keychain is not available
 */

import { readFile, writeFile, chmod, rm } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ensureDir, pathExists } from 'fs-extra';
import type { Keystore } from './types.js';
import { getFallbackKeystorePath, getLegacyFallbackKeystorePath } from '../../state.js';

const ALGORITHM = 'aes-256-gcm';
const INSTALL_SECRET_BYTES = 32;

/**
 * Path to the per-install random secret. Lives under the user's tuck dir so it
 * is created once per machine/install and reused thereafter.
 */
const getInstallSecretPath = (): string => join(homedir(), '.tuck', 'keystore.key');

/**
 * Read (or create on first run) the per-install random secret. Mixing this
 * 32-byte random value into the key derivation means the fallback keystore file
 * is no longer derivable from machine info alone — an attacker also needs the
 * locally-stored, 0600 secret. Synchronous so it can feed the sync getMachineKey.
 */
const readOrCreateInstallSecret = (): Buffer => {
  const secretPath = getInstallSecretPath();

  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath);
    if (existing.length === INSTALL_SECRET_BYTES) {
      return existing;
    }
    // Corrupt/short secret: fall through and regenerate. Rotating it only
    // invalidates the local encrypted keystore (re-derivable on next store).
  }

  const secret = randomBytes(INSTALL_SECRET_BYTES);
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, secret);
  // Restrict to owner only (best-effort on platforms without POSIX perms).
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Ignore on platforms that don't support chmod (e.g. Windows).
  }
  return secret;
};

interface KeystoreData {
  entries: Record<string, Record<string, string>>;
  version: number;
}

export class FallbackKeystore implements Keystore {
  private keystorePath: string;
  private legacyKeystorePath: string | null;

  constructor(customPath?: string) {
    this.keystorePath = customPath || getFallbackKeystorePath();
    this.legacyKeystorePath = customPath ? null : getLegacyFallbackKeystorePath();
  }

  getName(): string {
    return 'Local encrypted file';
  }

  async isAvailable(): Promise<boolean> {
    // Always available as fallback
    return true;
  }

  async store(service: string, account: string, secret: string): Promise<void> {
    const data = await this.loadData();

    if (!data.entries[service]) {
      data.entries[service] = {};
    }
    data.entries[service][account] = secret;

    await this.saveData(data);
  }

  async retrieve(service: string, account: string): Promise<string | null> {
    const data = await this.loadData();
    return data.entries[service]?.[account] || null;
  }

  async delete(service: string, account: string): Promise<void> {
    const data = await this.loadData();

    if (data.entries[service]) {
      delete data.entries[service][account];

      // Clean up empty service
      if (Object.keys(data.entries[service]).length === 0) {
        delete data.entries[service];
      }
    }

    await this.saveData(data);
  }

  /**
   * Derive a machine-specific key for encrypting the keystore
   * This provides some protection but is not as secure as a system keychain
   */
  private getMachineKey(): Buffer {
    // Combine machine-specific values to create a deterministic key
    // This isn't perfect security but prevents casual file theft
    const factors = [
      hostname(),
      userInfo().username,
      homedir(),
      process.platform,
      'tuck-keystore-v1', // Version string for key derivation
    ].join(':');

    // Mix in a per-install random 32-byte secret (persisted 0600 on first run)
    // so the key isn't derivable from machine info alone. The HMAC keyed by the
    // secret binds the deterministic factors to this specific install.
    const installSecret = readOrCreateInstallSecret();

    return createHash('sha256')
      .update(installSecret)
      .update(':')
      .update(factors)
      .digest();
  }

  /**
   * The pre-install-secret key derivation (deterministic machine factors only).
   * Kept so a keystore file written BEFORE the per-install secret was introduced
   * stays decryptable across the upgrade; the data is transparently re-encrypted
   * with the current key on the next saveData() (migration). Without this,
   * upgrading would silently orphan a user's stored secrets / backup-encryption
   * password — a data-loss regression.
   */
  private getLegacyMachineKey(): Buffer {
    const factors = [
      hostname(),
      userInfo().username,
      homedir(),
      process.platform,
      'tuck-keystore-v1',
    ].join(':');

    return createHash('sha256').update(factors).digest();
  }

  private async loadData(): Promise<KeystoreData> {
    const loadPath = await this.getReadablePath();
    if (!loadPath) {
      return { entries: {}, version: 1 };
    }

    let encrypted: Buffer;
    try {
      encrypted = await readFile(loadPath);
    } catch {
      // Unreadable, start fresh
      return { entries: {}, version: 1 };
    }

    // Try the current key first, then the legacy (pre-install-secret) key so a
    // keystore written before this upgrade stays readable. A subsequent
    // saveData() re-encrypts the whole file with the current key (migration).
    for (const key of [this.getMachineKey(), this.getLegacyMachineKey()]) {
      try {
        const decrypted = this.decrypt(encrypted, key);
        return JSON.parse(decrypted.toString('utf-8')) as KeystoreData;
      } catch {
        // Wrong key (or corrupt) — try the next candidate.
      }
    }
    // Corrupted or undecryptable with any known key, start fresh.
    return { entries: {}, version: 1 };
  }

  private async saveData(data: KeystoreData): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    const encrypted = this.encrypt(Buffer.from(json, 'utf-8'));

    await ensureDir(dirname(this.keystorePath));
    await writeFile(this.keystorePath, encrypted);
    // Restrict permissions to owner only
    await chmod(this.keystorePath, 0o600);

    if (this.legacyKeystorePath && this.legacyKeystorePath !== this.keystorePath) {
      await rm(this.legacyKeystorePath, { force: true }).catch(() => undefined);
    }
  }

  private async getReadablePath(): Promise<string | null> {
    if (await pathExists(this.keystorePath)) {
      return this.keystorePath;
    }

    if (this.legacyKeystorePath && (await pathExists(this.legacyKeystorePath))) {
      return this.legacyKeystorePath;
    }

    return null;
  }

  private encrypt(data: Buffer): Buffer {
    const key = this.getMachineKey();
    const iv = randomBytes(12);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: IV (12) + AUTH_TAG (16) + CIPHERTEXT
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  private decrypt(encrypted: Buffer, key: Buffer = this.getMachineKey()): Buffer {
    const iv = encrypted.subarray(0, 12);
    const authTag = encrypted.subarray(12, 28);
    const ciphertext = encrypted.subarray(28);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
