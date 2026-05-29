/**
 * Encryption password-verification storage unit tests.
 *
 * The password-derived verification salt+hash were written into .tuckrc.json,
 * a TRACKED file that gets committed and pushed (often to a public remote),
 * enabling offline brute-force. They must live off-repo in the state dir.
 * Also: verifyStoredPassword previously returned true when no verification data
 * existed, making the change-password old-password check a no-op.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import {
  writeEncryptionVerification,
  verifyStoredPassword,
  getEncryptionVerifyPath,
} from '../../src/lib/crypto/manager.js';

describe('encryption verification storage', () => {
  beforeEach(() => {
    vol.mkdirSync('/test-home/.tuck', { recursive: true });
  });

  it('returns false when no verification data exists (no silent true)', async () => {
    expect(await verifyStoredPassword('anything')).toBe(false);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    await writeEncryptionVerification('correct horse battery staple');
    expect(await verifyStoredPassword('correct horse battery staple')).toBe(true);
    expect(await verifyStoredPassword('wrong password')).toBe(false);
  });

  it('stores verification data off-repo (state dir), never under ~/.tuck', async () => {
    await writeEncryptionVerification('pw');
    const verifyPath = getEncryptionVerifyPath();
    expect(vol.existsSync(verifyPath)).toBe(true);
    expect(verifyPath).not.toContain('/.tuck/');
    // and the tracked config must not carry the hash
    const cfg = '/test-home/.tuck/.tuckrc.json';
    if (vol.existsSync(cfg)) {
      expect(vol.readFileSync(cfg, 'utf-8').toString()).not.toContain('_verificationHash');
    }
  });
});
