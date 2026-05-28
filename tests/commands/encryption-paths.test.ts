/**
 * decrypt-file output-path resolution unit tests.
 *
 * `tuck encryption decrypt-file` must never write plaintext over its own
 * encrypted input. The old `inAbs.replace(/\.enc$/, '') || `${inAbs}.dec``
 * fallback never fired (a non-empty path is truthy), so an encrypted file
 * lacking a `.enc` suffix had its ciphertext overwritten in place.
 */
import { describe, it, expect } from 'vitest';
import { resolveDecryptOutPath } from '../../src/commands/encryption.js';

describe('resolveDecryptOutPath', () => {
  it('strips a .enc suffix when no --out is given', () => {
    expect(resolveDecryptOutPath('/a/b/secret.enc')).toBe('/a/b/secret');
  });

  it('appends .dec when the input has no .enc suffix (never in-place)', () => {
    expect(resolveDecryptOutPath('/a/b/secret')).toBe('/a/b/secret.dec');
  });

  it('honors an explicit --out path', () => {
    expect(resolveDecryptOutPath('/a/b/secret.enc', '/tmp/out')).toBe('/tmp/out');
  });

  it('refuses to write over the input when --out equals input', () => {
    expect(() => resolveDecryptOutPath('/a/b/secret', '/a/b/secret')).toThrow();
  });

  it('refuses the implicit in-place case for a suffixless encrypted input via --out', () => {
    expect(() => resolveDecryptOutPath('/a/b/secret.enc', '/a/b/secret.enc')).toThrow();
  });
});
