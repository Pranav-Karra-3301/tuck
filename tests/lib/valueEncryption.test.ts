/**
 * Value-level (SOPS-style) encryption unit tests.
 *
 * Uses real node crypto (PBKDF2/AES-256-GCM) on small payloads and the memfs
 * fs mock from tests/setup.ts for the file-level helpers. Value counts are kept
 * small so the 600k-iteration KDF stays well under the suite timeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  formatValueToken,
  parseValueToken,
  isValueToken,
  hasEncryptedValues,
  countEncryptedValues,
  findValueTokens,
  encryptValue,
  decryptValue,
  encryptContentValues,
  decryptContentValues,
  encryptFileValues,
  decryptFileValues,
  fileHasEncryptedValues,
  keyDerivation,
} from '../../src/lib/secrets/valueEncryption.js';
import { scanContent } from '../../src/lib/secrets/scanner.js';
import type { SecretMatch } from '../../src/lib/secrets/scanner.js';
import { TEST_HOME } from '../setup.js';

const PASS = 'correct horse battery staple';

/** Build a minimal SecretMatch list from raw values (only `value` matters here). */
const matchesOf = (...values: string[]): SecretMatch[] =>
  values.map((value, i) => ({
    patternId: 'test',
    patternName: 'Test',
    severity: 'high',
    value,
    redactedValue: '[REDACTED]',
    line: i + 1,
    column: 1,
    context: '',
    placeholder: 'SECRET',
  }));

describe('valueEncryption', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  describe('token helpers', () => {
    it('formats and parses a token round-trip', () => {
      const token = formatValueToken('YWJjMTIz');
      expect(token).toBe('ENC[tuck:v1:YWJjMTIz]');
      expect(parseValueToken(token)).toBe('YWJjMTIz');
      expect(isValueToken(token)).toBe(true);
    });

    it('rejects non-tokens', () => {
      expect(parseValueToken('ENC[other:xyz]')).toBeNull();
      expect(parseValueToken('plain value')).toBeNull();
      expect(isValueToken('ENC[tuck:v1:]')).toBe(false); // empty payload
      expect(isValueToken('ENC[tuck:v1:abc] trailing')).toBe(false);
    });

    it('detects, counts, and finds tokens in content', () => {
      const content = 'A=ENC[tuck:v1:AAAA]\nB=plain\nC=ENC[tuck:v1:BBBB]';
      expect(hasEncryptedValues(content)).toBe(true);
      expect(countEncryptedValues(content)).toBe(2);
      expect(findValueTokens(content)).toEqual(['ENC[tuck:v1:AAAA]', 'ENC[tuck:v1:BBBB]']);
    });

    it('reports no tokens for plain content', () => {
      expect(hasEncryptedValues('KEY=value')).toBe(false);
      expect(countEncryptedValues('KEY=value')).toBe(0);
      expect(findValueTokens('KEY=value')).toEqual([]);
    });
  });

  describe('single value encrypt/decrypt', () => {
    it('round-trips a value', async () => {
      const token = await encryptValue('s3cr3t-value', PASS);
      expect(isValueToken(token)).toBe(true);
      expect(token).not.toContain('s3cr3t-value');
      expect(await decryptValue(token, PASS)).toBe('s3cr3t-value');
    });

    it('produces different ciphertext for the same value (fresh salt/IV)', async () => {
      const a = await encryptValue('same', PASS);
      const b = await encryptValue('same', PASS);
      expect(a).not.toBe(b);
      expect(await decryptValue(a, PASS)).toBe('same');
      expect(await decryptValue(b, PASS)).toBe('same');
    });

    it('preserves values containing regex $-sequences verbatim', async () => {
      const tricky = '$&$1${x}$$literal';
      const token = await encryptValue(tricky, PASS);
      expect(await decryptValue(token, PASS)).toBe(tricky);
    });

    it('fails to decrypt with the wrong passphrase', async () => {
      const token = await encryptValue('value', PASS);
      await expect(decryptValue(token, 'wrong')).rejects.toThrow();
    });

    it('rejects a tampered token', async () => {
      const token = await encryptValue('value', PASS);
      const payload = parseValueToken(token)!;
      const bytes = Buffer.from(payload, 'base64');
      bytes[bytes.length - 1] ^= 0xff; // flip a ciphertext bit
      const tampered = formatValueToken(bytes.toString('base64'));
      await expect(decryptValue(tampered, PASS)).rejects.toThrow();
    });

    it('rejects empty passphrases', async () => {
      await expect(encryptValue('x', '')).rejects.toThrow();
      await expect(decryptValue('ENC[tuck:v1:AAAA]', '')).rejects.toThrow();
    });
  });

  describe('content-level encrypt/decrypt', () => {
    it('encrypts only the values, keeping keys/structure/comments plaintext', async () => {
      const content = [
        '# my env file',
        'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
        'DB_PASSWORD=supersecretpassword123',
        '',
        'PLAIN=not-a-secret',
      ].join('\n');
      const matches = matchesOf('AKIAIOSFODNN7EXAMPLE', 'supersecretpassword123');

      const { content: enc, encrypted } = await encryptContentValues(content, matches, PASS);
      expect(encrypted).toBe(2);
      // Keys, comment, and blank line untouched.
      expect(enc).toContain('# my env file');
      expect(enc).toContain('AWS_KEY=ENC[tuck:v1:');
      expect(enc).toContain('DB_PASSWORD=ENC[tuck:v1:');
      expect(enc).toContain('PLAIN=not-a-secret');
      // Secrets gone.
      expect(enc).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(enc).not.toContain('supersecretpassword123');

      const { content: dec, decrypted } = await decryptContentValues(enc, PASS);
      expect(decrypted).toBe(2);
      expect(dec).toBe(content);
    });

    it('round-trips a JSON file preserving structure', async () => {
      const content = JSON.stringify(
        { name: 'app', apiKey: 'sk-live-abcdef123456', nested: { token: 'ghp_secretvalue1234' } },
        null,
        2
      );
      const matches = matchesOf('sk-live-abcdef123456', 'ghp_secretvalue1234');

      const { content: enc } = await encryptContentValues(content, matches, PASS);
      // Still valid JSON with the same keys/shape.
      const parsed = JSON.parse(enc);
      expect(parsed.name).toBe('app');
      expect(parsed.apiKey.startsWith('ENC[tuck:v1:')).toBe(true);
      expect(parsed.nested.token.startsWith('ENC[tuck:v1:')).toBe(true);

      const { content: dec } = await decryptContentValues(enc, PASS);
      expect(dec).toBe(content);
    });

    it('derives one key for many values (shared salt across new tokens)', async () => {
      const content = 'A=aaa111\nB=bbb222\nC=ccc333';
      const matches = matchesOf('aaa111', 'bbb222', 'ccc333');
      const { content: enc, encrypted } = await encryptContentValues(content, matches, PASS);
      expect(encrypted).toBe(3);
      const { content: dec } = await decryptContentValues(enc, PASS);
      expect(dec).toBe(content);
    });

    it('replaces every occurrence of a repeated value with one token', async () => {
      const content = 'A=dupvalue\nB=dupvalue';
      const matches = matchesOf('dupvalue');
      const { content: enc, encrypted } = await encryptContentValues(content, matches, PASS);
      expect(encrypted).toBe(1);
      const tokens = findValueTokens(enc);
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toBe(tokens[1]); // same token reused
      const { content: dec } = await decryptContentValues(enc, PASS);
      expect(dec).toBe(content);
    });

    it('is idempotent: re-encrypting already-encrypted content is a no-op', async () => {
      const content = 'A=secretvalue1';
      const matches = matchesOf('secretvalue1');
      const { content: enc } = await encryptContentValues(content, matches, PASS);

      // Feed the base64 payload back in as if it were a detected secret — it must
      // NOT be re-encrypted because it only lives inside an existing token.
      const payload = parseValueToken(findValueTokens(enc)[0])!;
      const { content: enc2, encrypted, skipped } = await encryptContentValues(
        enc,
        matchesOf(payload),
        PASS
      );
      expect(encrypted).toBe(0);
      expect(skipped).toBe(1);
      expect(enc2).toBe(enc);
    });

    it('does not corrupt an earlier token when a later value occurs inside it', async () => {
      // Deterministic collision: every token literally contains the fixed prefix
      // `ENC[tuck:v1:`, so a secret value of `tuck:v1` is GUARANTEED to appear
      // inside the first (longer) value's token. A single-pass value→token swap
      // would splice the `tuck:v1` value's token into the middle of the first
      // token's base64, destroying it. The two-pass replacement must not.
      const longValue = 'AKIAIOSFODNN7EXAMPLELONGSECRET';
      const collidingValue = 'tuck:v1';
      const content = `LONG=${longValue}\nSHORT=${collidingValue}`;
      const matches = matchesOf(longValue, collidingValue);

      const { content: enc, encrypted } = await encryptContentValues(content, matches, PASS);
      expect(encrypted).toBe(2);
      // Both plaintext values are gone and two intact tokens remain.
      expect(enc).not.toContain(longValue);
      expect(findValueTokens(enc)).toHaveLength(2);

      // The real proof: a clean round trip. Under the old single-pass code the
      // first token is corrupted and this decrypt would fail / not restore.
      const { content: dec, decrypted } = await decryptContentValues(enc, PASS);
      expect(decrypted).toBe(2);
      expect(dec).toBe(content);
    });

    it('derives the key once for many same-salt tokens (per-salt cache)', async () => {
      // All tokens from a single encrypt call share one salt.
      const values = Array.from({ length: 6 }, (_, i) => `secretvalue${i}xyz`);
      const content = values.map((v, i) => `K${i}=${v}`).join('\n');
      const { content: enc, encrypted } = await encryptContentValues(
        content,
        matchesOf(...values),
        PASS
      );
      expect(encrypted).toBe(6);

      const deriveSpy = vi.spyOn(keyDerivation, 'derive');
      try {
        const { content: dec, decrypted } = await decryptContentValues(enc, PASS);
        expect(decrypted).toBe(6);
        expect(dec).toBe(content);
        // One derivation for all six same-salt tokens, not six.
        expect(deriveSpy).toHaveBeenCalledTimes(1);
      } finally {
        deriveSpy.mockRestore();
      }
    });

    it('leaves existing tokens byte-identical when encrypting a newly added value', async () => {
      const first = 'A=alpha111';
      const { content: encFirst } = await encryptContentValues(first, matchesOf('alpha111'), PASS);
      const existingToken = findValueTokens(encFirst)[0];

      const combined = `${encFirst}\nB=beta222`;
      const { content: encSecond, encrypted } = await encryptContentValues(
        combined,
        matchesOf('beta222'),
        PASS
      );
      expect(encrypted).toBe(1);
      // The first token is untouched (clean git diff).
      expect(encSecond).toContain(existingToken);
      const { content: dec } = await decryptContentValues(encSecond, PASS);
      expect(dec).toBe('A=alpha111\nB=beta222');
    });

    it('counts failures without throwing when throwOnFailure is false', async () => {
      const { content: enc } = await encryptContentValues('A=val111', matchesOf('val111'), PASS);
      const res = await decryptContentValues(enc, 'wrong-pass', { throwOnFailure: false });
      expect(res.decrypted).toBe(0);
      expect(res.failed).toBe(1);
      expect(res.content).toBe(enc); // untouched
    });

    it('throws on the first undecryptable token by default', async () => {
      const { content: enc } = await encryptContentValues('A=val111', matchesOf('val111'), PASS);
      await expect(decryptContentValues(enc, 'wrong-pass')).rejects.toThrow();
    });

    it('integrates with the real scanner to locate spans', async () => {
      const content = 'export GITHUB_TOKEN=ghp_0123456789abcdefABCDEF0123456789abcd';
      const found = scanContent(content);
      expect(found.length).toBeGreaterThan(0);
      const { content: enc } = await encryptContentValues(content, found, PASS);
      // The raw secret is gone and an inline token took its place.
      expect(enc).not.toContain('ghp_0123456789abcdefABCDEF0123456789abcd');
      expect(hasEncryptedValues(enc)).toBe(true);
      const { content: dec } = await decryptContentValues(enc, PASS);
      expect(dec).toBe(content);
    });
  });

  describe('file-level operations', () => {
    const filepath = join(TEST_HOME, '.env');

    it('encrypts and decrypts a file in place, preserving structure', async () => {
      const original = 'HOST=localhost\nSECRET=topsecretvalue1\n';
      vol.writeFileSync(filepath, original);

      const encRes = await encryptFileValues(filepath, matchesOf('topsecretvalue1'), PASS);
      expect(encRes.changed).toBe(true);
      expect(encRes.encrypted).toBe(1);

      const onDisk = vol.readFileSync(filepath, 'utf-8') as string;
      expect(onDisk).toContain('HOST=localhost');
      expect(onDisk).not.toContain('topsecretvalue1');
      expect(await fileHasEncryptedValues(filepath)).toBe(true);

      const decRes = await decryptFileValues(filepath, PASS);
      expect(decRes.changed).toBe(true);
      expect(decRes.decrypted).toBe(1);
      expect(vol.readFileSync(filepath, 'utf-8')).toBe(original);
    });

    it('does not rewrite a file with nothing to encrypt', async () => {
      vol.writeFileSync(filepath, 'HOST=localhost\n');
      const res = await encryptFileValues(filepath, matchesOf('not-present-value'), PASS);
      expect(res.changed).toBe(false);
      expect(res.encrypted).toBe(0);
    });

    it('does not rewrite a file with no tokens on decrypt', async () => {
      vol.writeFileSync(filepath, 'HOST=localhost\n');
      const res = await decryptFileValues(filepath, PASS);
      expect(res.changed).toBe(false);
      expect(res.decrypted).toBe(0);
    });

    it('fileHasEncryptedValues is false for missing paths and directories', async () => {
      expect(await fileHasEncryptedValues(join(TEST_HOME, 'nope'))).toBe(false);
      vol.mkdirSync(join(TEST_HOME, 'adir'));
      expect(await fileHasEncryptedValues(join(TEST_HOME, 'adir'))).toBe(false);
    });
  });
});
