/**
 * Fallback keystore using encrypted local file
 * Used when system keychain is not available
 */

import { readFile, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ensureDir, pathExists } from 'fs-extra';
import type { Keystore } from './types.js';

const KEYSTORE_FILE = '.tuck-keystore.enc';
const ALGORITHM = 'aes-256-gcm';

interface KeystoreData {
  entries: Record<string, Record<string, string>>;
  version: number;
}

export class FallbackKeystore implements Keystore {
  private keystorePath: string;

  constructor(customPath?: string) {
    this.keystorePath = customPath || join(homedir(), '.tuck', KEYSTORE_FILE);
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

    // Use SHA-256 to get consistent 32-byte key
    return createHash('sha256').update(factors).digest();
  }

  private async loadData(): Promise<KeystoreData> {
    if (!(await pathExists(this.keystorePath))) {
      return { entries: {}, version: 1 };
    }

    try {
      const encrypted = await readFile(this.keystorePath);
      const decrypted = this.decrypt(encrypted);
      return JSON.parse(decrypted.toString('utf-8'));
    } catch {
      // Corrupted or unreadable, start fresh
      return { entries: {}, version: 1 };
    }
  }

  private async saveData(data: KeystoreData): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    const encrypted = this.encrypt(Buffer.from(json, 'utf-8'));

    await ensureDir(join(homedir(), '.tuck'));
    await writeFile(this.keystorePath, encrypted);
    // Restrict permissions to owner only
    await chmod(this.keystorePath, 0o600);
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

  private decrypt(encrypted: Buffer): Buffer {
    const key = this.getMachineKey();

    const iv = encrypted.subarray(0, 12);
    const authTag = encrypted.subarray(12, 28);
    const ciphertext = encrypted.subarray(28);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
