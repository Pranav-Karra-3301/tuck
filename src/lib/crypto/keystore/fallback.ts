/**
 * Fallback keystore using encrypted local file
 * Used when system keychain is not available
 */

import { readFile, writeFile, chmod, rm, rename, unlink } from 'fs/promises';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  constants as fsConstants,
} from 'fs';
import { dirname, join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ensureDir, pathExists } from 'fs-extra';
import type { Keystore } from './types.js';
import {
  getFallbackKeystorePath,
  getLegacyFallbackKeystorePath,
  getStateDir,
} from '../../state.js';

const ALGORITHM = 'aes-256-gcm';
const INSTALL_SECRET_BYTES = 32;

/**
 * Atomically persist an encrypted (binary) keystore buffer with owner-only
 * permissions. Writes to a same-directory temp file, forces 0600 (in case umask
 * stripped bits at create time, and to avoid a brief 0644 window on the real
 * path), then renames into place — a crash/ENOSPC mid-write leaves the previous
 * file intact instead of a truncated one that would be treated as "corrupt".
 */
const atomicWriteKeystore = async (filepath: string, data: Buffer): Promise<void> => {
  const tempPath = `${filepath}.tmp.${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(tempPath, data, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, filepath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

/**
 * Path to the per-install random secret. Lives in the out-of-repo state dir
 * (alongside the keystore file) so `tuck sync` can never stage/commit/push it —
 * a committed secret would make the machine key derivable again from guessable
 * factors, defeating its purpose.
 */
const getInstallSecretPath = (): string => join(getStateDir(), 'keystore', 'keystore.key');

/**
 * Legacy location: older tuck versions wrote the secret INSIDE the repo
 * (~/.tuck/keystore.key), where tuck sync would commit and push it. Kept only so
 * we can migrate it out on first use.
 */
const getLegacyInstallSecretPath = (): string => join(homedir(), '.tuck', 'keystore.key');

/**
 * Move a secret written by an older tuck out of the repo and into the state dir,
 * preserving its bytes so the derived key (and thus the encrypted keystore) stays
 * valid. Best-effort and idempotent; the in-repo copy is always removed so a
 * later sync cannot push it.
 */
const migrateLegacyInstallSecret = (secretPath: string): void => {
  const legacyPath = getLegacyInstallSecretPath();
  if (existsSync(secretPath) || !existsSync(legacyPath)) {
    return;
  }

  try {
    const legacySecret = readFileSync(legacyPath);
    if (legacySecret.length === INSTALL_SECRET_BYTES) {
      mkdirSync(dirname(secretPath), { recursive: true });
      try {
        renameSync(legacyPath, secretPath);
        return;
      } catch {
        // Cross-device or other rename failure — fall back to copy + delete so
        // the in-repo original still gets removed below.
        const fd = openSync(
          secretPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600
        );
        try {
          writeSync(fd, legacySecret);
        } finally {
          closeSync(fd);
        }
      }
    }
    // Either migrated by copy, or the legacy secret was the wrong length and
    // will be regenerated — in both cases drop the in-repo copy.
    unlinkSync(legacyPath);
  } catch {
    // Best-effort; readOrCreateInstallSecret falls through to normal handling.
  }
};

/**
 * Read (or create on first run) the per-install random secret. Mixing this
 * 32-byte random value into the key derivation means the fallback keystore file
 * is no longer derivable from machine info alone — an attacker also needs the
 * locally-stored, 0600 secret. Synchronous so it can feed the sync getMachineKey.
 */
const readOrCreateInstallSecret = (): Buffer => {
  const secretPath = getInstallSecretPath();

  migrateLegacyInstallSecret(secretPath);

  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath);
    if (existing.length === INSTALL_SECRET_BYTES) {
      return existing;
    }
    // Corrupt/short secret. Rotating it loses any data encrypted with it, so
    // preserve the old value (best-effort) for manual recovery before replacing.
    try {
      renameSync(secretPath, `${secretPath}.corrupt`);
    } catch {
      // Couldn't move it aside; the exclusive create below will fail and we
      // fall back to an overwrite as a last resort.
    }
  }

  mkdirSync(dirname(secretPath), { recursive: true });
  const secret = randomBytes(INSTALL_SECRET_BYTES);

  // Atomic create-exclusive (mode 0600) so two processes starting at once can't
  // each write a DIFFERENT secret and silently orphan one another's encrypted
  // data. The loser of the race adopts the winner's secret instead.
  try {
    const fd = openSync(
      secretPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    try {
      writeSync(fd, secret);
    } finally {
      closeSync(fd);
    }
    return secret;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(secretPath);
      if (existing.length === INSTALL_SECRET_BYTES) {
        return existing;
      }
    }
    // Last resort (e.g. a filesystem without O_EXCL semantics): best-effort write.
    writeFileSync(secretPath, secret);
    try {
      chmodSync(secretPath, 0o600);
    } catch {
      // Ignore on platforms that don't support chmod (e.g. Windows).
    }
    return secret;
  }
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
    // Undecryptable with every known key (truncated write, lost install secret,
    // etc.). Preserve the unreadable file as `.corrupt` instead of letting the
    // next saveData() silently overwrite it — it may hold the only copy of the
    // backup-encryption password, and the project rule is never delete without a
    // recovery path. (Mirrors the install-secret `.corrupt` convention above.)
    await rename(loadPath, `${loadPath}.corrupt`).catch(() => undefined);
    return { entries: {}, version: 1 };
  }

  private async saveData(data: KeystoreData): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    const encrypted = this.encrypt(Buffer.from(json, 'utf-8'));

    await ensureDir(dirname(this.keystorePath));
    // Atomic write with owner-only perms — a crash mid-write must not truncate
    // the keystore (which loadData would then treat as corrupt and discard).
    await atomicWriteKeystore(this.keystorePath, encrypted);

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
