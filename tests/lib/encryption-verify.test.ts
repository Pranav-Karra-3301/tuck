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
    // Seed a REAL tracked config so the "hash must not land in it" assertion
    // actually runs (previously the `if (existsSync)` guard was false and the
    // safety check was skipped entirely).
    const cfg = '/test-home/.tuck/.tuckrc.json';
    const originalConfig =
      JSON.stringify({ version: '1.0.0', encryption: { backupsEnabled: false } }, null, 2) + '\n';
    vol.writeFileSync(cfg, originalConfig);

    await writeEncryptionVerification('pw');

    const verifyPath = getEncryptionVerifyPath();
    expect(vol.existsSync(verifyPath)).toBe(true);
    expect(verifyPath).not.toContain('/.tuck/');
    // The verification salt+hash must be written ONLY off-repo...
    expect(vol.readFileSync(verifyPath, 'utf-8').toString()).toContain('hash');

    // ...and the tracked, committed config must be left untouched — no hash,
    // no salt, byte-for-byte identical to what we seeded.
    expect(vol.existsSync(cfg)).toBe(true);
    const afterConfig = vol.readFileSync(cfg, 'utf-8').toString();
    expect(afterConfig).not.toContain('_verificationHash');
    expect(afterConfig).not.toContain('_verificationSalt');
    expect(afterConfig).toBe(originalConfig);
  });
});
