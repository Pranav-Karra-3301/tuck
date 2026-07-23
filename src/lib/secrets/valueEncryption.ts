/**
 * Value-level (SOPS-style) encryption for tuck.
 *
 * Where {@link ./redactor.ts | the redactor} replaces a detected secret span with
 * a `{{PLACEHOLDER}}` and stores the plaintext elsewhere, value-encryption
 * replaces the *same* span with an inline, self-contained ciphertext token:
 *
 *   AWS_SECRET_ACCESS_KEY=ENC[tuck:v1:<base64>]
 *
 * Only the secret VALUE changes. Keys, structure, comments, and whitespace stay
 * plaintext, so `git diff`, `git merge`, and code review keep working on the
 * encrypted file — the property git-crypt and whole-file encryption throw away.
 *
 * Each token is independently decryptable (it carries its own KDF params, salt,
 * IV, and auth tag), so a three-way merge that moves or reorders lines never
 * corrupts a value. Within a single {@link encryptContentValues} call every new
 * token shares one salt so the key derivation (PBKDF2) runs once regardless of
 * how many values are encrypted; re-encrypting a file only touches values that
 * are still plaintext, leaving existing tokens byte-for-byte unchanged for clean
 * diffs.
 *
 * Crypto: PBKDF2-HMAC-SHA256 (OWASP-recommended 600k iterations) → 32-byte key,
 * AES-256-GCM with a unique 96-bit nonce per value. This mirrors
 * {@link ../crypto/fileEncryption.ts} but packs the parameters into a compact,
 * text-embeddable token instead of a binary file header.
 *
 * Security limitation — no context binding (accepted for v1): a token's GCM auth
 * tag authenticates ONLY the value, not the key it sits next to or the file it
 * lives in. Unlike SOPS's file-level MAC, tuck's tokens carry no AAD, so an
 * attacker with write access to the repo can transplant a valid `ENC[…]` token to
 * a different key or file and it will still decrypt cleanly under the same
 * passphrase — the substitution is undetectable at decrypt time. Changing the
 * token format to bind context would break compatibility, so the mitigation is
 * out-of-band: git history and code review make such a swap visible in a diff.
 * See docs/VALUE-ENCRYPTION.md → "Security notes".
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2 as pbkdf2Cb,
} from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { expandPath, pathExists } from '../paths.js';
import { atomicWriteFile } from '../files.js';
import { EncryptionError, DecryptionError } from '../../errors.js';
import type { SecretMatch } from './scanner.js';

const pbkdf2 = promisify(pbkdf2Cb);

// ============================================================================
// Constants
// ============================================================================

const TOKEN_PREFIX = 'ENC[tuck:v1:';
const TOKEN_SUFFIX = ']';

const ITER_LENGTH = 4; // uint32 BE iteration count
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // GCM nonce
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const PBKDF2_DIGEST = 'sha256';
const ALGORITHM = 'aes-256-gcm';

// Current KDF cost. OWASP recommends >= 600,000 for PBKDF2-HMAC-SHA256.
const PBKDF2_ITERATIONS = 600_000;
// Guard a malicious/corrupt token from forcing an absurd (DoS) or zero-cost KDF.
const MIN_PBKDF2_ITERATIONS = 1;
const MAX_PBKDF2_ITERATIONS = 10_000_000;

const MIN_PAYLOAD_LENGTH = ITER_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

/**
 * Matches a value-encryption token and captures its base64 payload. The base64
 * alphabet (`A-Za-z0-9+/=`) never contains the `]` terminator, so the match is
 * unambiguous even when several tokens sit on one line.
 */
export const VALUE_TOKEN_REGEX = /ENC\[tuck:v1:([A-Za-z0-9+/=]+)\]/g;

// ============================================================================
// Token helpers
// ============================================================================

/** Wrap a base64 payload in the value-token envelope. */
export const formatValueToken = (payloadBase64: string): string =>
  `${TOKEN_PREFIX}${payloadBase64}${TOKEN_SUFFIX}`;

/** Extract the base64 payload from a token, or null when it is not a token. */
export const parseValueToken = (token: string): string | null => {
  const match = token.match(/^ENC\[tuck:v1:([A-Za-z0-9+/=]+)\]$/);
  return match ? match[1] : null;
};

/** True when the content contains at least one value-encryption token. */
export const hasEncryptedValues = (content: string): boolean => {
  // Fresh instance so the shared regex's lastIndex is never carried across calls.
  const regex = new RegExp(VALUE_TOKEN_REGEX.source, VALUE_TOKEN_REGEX.flags);
  return regex.test(content);
};

/** Return each token string (e.g. `ENC[tuck:v1:...]`) present in the content. */
export const findValueTokens = (content: string): string[] => {
  const regex = new RegExp(VALUE_TOKEN_REGEX.source, VALUE_TOKEN_REGEX.flags);
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
};

// ============================================================================
// Single-value crypto
// ============================================================================

/** Derived key + the salt it came from, so callers can reuse one derivation. */
interface DerivedKey {
  key: Buffer;
  salt: Buffer;
  iterations: number;
}

/**
 * Key-derivation seam. Production code always runs PBKDF2 here; exposing it as a
 * mutable binding lets tests assert the per-salt cache in
 * {@link decryptContentValues} collapses N same-salt tokens down to a single
 * (expensive) derivation. Do not depend on this shape outside of tests.
 * @internal
 */
export const keyDerivation = {
  derive(passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
    return pbkdf2(passphrase, salt, iterations, KEY_LENGTH, PBKDF2_DIGEST);
  },
};

const deriveValueKey = async (passphrase: string, salt: Buffer): Promise<Buffer> => {
  return keyDerivation.derive(passphrase, salt, PBKDF2_ITERATIONS);
};

/**
 * Encrypt a single plaintext value into a token payload using a pre-derived key.
 * A fresh IV is generated per value so reusing one key across many values within
 * a file stays GCM-safe.
 */
const encryptWithKey = (plaintext: string, derived: DerivedKey): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derived.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const iters = Buffer.alloc(ITER_LENGTH);
  iters.writeUInt32BE(derived.iterations);

  const payload = Buffer.concat([iters, derived.salt, iv, authTag, ciphertext]);
  return formatValueToken(payload.toString('base64'));
};

/** The parsed, still-encrypted components of a value token. */
interface TokenParts {
  iterations: number;
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Parse a value token's base64 payload into its crypto components. Throws
 * {@link DecryptionError} on a non-token, invalid base64, a truncated header, or
 * an out-of-range iteration count. Does NOT derive a key or decrypt — so callers
 * can share one key derivation across many tokens (see the cache in
 * {@link decryptContentValues}).
 */
const parseTokenPayload = (token: string): TokenParts => {
  const base64 = parseValueToken(token);
  if (base64 === null) {
    throw new DecryptionError('Not a tuck value-encryption token');
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(base64, 'base64');
  } catch {
    throw new DecryptionError('Value token payload is not valid base64');
  }
  if (payload.length < MIN_PAYLOAD_LENGTH) {
    throw new DecryptionError('Value token is too short to contain a valid header');
  }

  let offset = 0;
  const iterations = payload.readUInt32BE(offset);
  offset += ITER_LENGTH;
  if (iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new DecryptionError('Value token declares an out-of-range iteration count');
  }
  const salt = payload.subarray(offset, (offset += SALT_LENGTH));
  const iv = payload.subarray(offset, (offset += IV_LENGTH));
  const authTag = payload.subarray(offset, (offset += AUTH_TAG_LENGTH));
  const ciphertext = payload.subarray(offset);

  return { iterations, salt, iv, authTag, ciphertext };
};

/** Decrypt already-parsed token parts with a pre-derived key. */
const decryptTokenParts = (parts: TokenParts, key: Buffer): string => {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, parts.iv);
    decipher.setAuthTag(parts.authTag);
    const plaintext = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new DecryptionError('Failed to decrypt value: wrong passphrase or corrupted token', [
      'Verify the encryption passphrase is correct',
      'Ensure the token was not modified',
    ]);
  }
};

// ============================================================================
// Content-level operations
// ============================================================================

export interface EncryptValuesResult {
  content: string;
  /** Number of distinct secret values that were encrypted into new tokens. */
  encrypted: number;
  /** Distinct values skipped because they already sat inside an existing token. */
  skipped: number;
}

export interface DecryptValuesResult {
  content: string;
  /** Number of tokens successfully decrypted. */
  decrypted: number;
  /** Tokens that could not be decrypted (wrong passphrase / corruption). */
  failed: number;
}

/**
 * Pick a delimiter character present in NEITHER the content nor any secret value.
 * A marker built around it can never be a substring of a real secret value (and
 * no value can be a substring of the marker's fixed delimiters), which keeps the
 * two-pass replacement below collision-free. Control chars are absent from
 * virtually every real config; we fall back to the Unicode Private Use Area.
 */
const pickReplacementSentinel = (content: string, values: string[]): string => {
  const inUse = (ch: string): boolean =>
    content.includes(ch) || values.some((v) => v.includes(ch));
  for (let code = 0x00; code <= 0x1f; code++) {
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue; // keep tab / CR / LF
    const ch = String.fromCharCode(code);
    if (!inUse(ch)) return ch;
  }
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const ch = String.fromCharCode(code);
    if (!inUse(ch)) return ch;
  }
  throw new EncryptionError('Unable to allocate a collision-free replacement marker');
};

/**
 * Build a unique placeholder `<sentinel><32 random hex><sentinel>` that contains
 * no secret value as a substring. The sentinel is absent from every value, so a
 * value can only ever match inside the random hex core — regenerated away in the
 * astronomically rare case it does.
 */
const makeMarker = (sentinel: string, values: string[]): string => {
  for (;;) {
    const marker = `${sentinel}${randomBytes(16).toString('hex')}${sentinel}`;
    if (!values.some((v) => v.length > 0 && marker.includes(v))) {
      return marker;
    }
  }
};

/**
 * Replace each detected secret span with an inline ciphertext token, encrypting
 * every new value under a single key derivation.
 *
 * Longest values are replaced first: when a shorter secret is a literal
 * substring of a longer one, replacing the shorter first would rewrite the
 * longer secret's prefix and leak its tail — the same ordering rule the redactor
 * uses. Values that already appear only inside an existing token are skipped so
 * re-encrypting a file never double-encrypts its own ciphertext.
 */
export const encryptContentValues = async (
  content: string,
  matches: SecretMatch[],
  passphrase: string
): Promise<EncryptValuesResult> => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new EncryptionError('Passphrase must be a non-empty string');
  }

  // Unique secret values, longest first.
  const uniqueValues = [...new Set(matches.map((m) => m.value))].sort(
    (a, b) => b.length - a.length
  );

  if (uniqueValues.length === 0) {
    return { content, encrypted: 0, skipped: 0 };
  }

  // Regions already occupied by tokens — a value found only inside one of these
  // is ciphertext we must not re-encrypt.
  const existingTokens = findValueTokens(content);

  // Derive the key ONCE for every value encrypted in this call.
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveValueKey(passphrase, salt);
  const derived: DerivedKey = { key, salt, iterations: PBKDF2_ITERATIONS };

  // Two FULL passes, not a per-iteration two-step. Pass 1 swaps every live secret
  // value for a unique placeholder marker; only once ALL values are gone does pass
  // 2 splice in the ciphertext tokens. This is what makes the operation correct:
  // a single-pass value→token swap can corrupt an earlier token, because a later,
  // shorter value that coincidentally occurs inside that token's base64 gets
  // spliced into the ciphertext (occursOutsideTokens only masks tokens that
  // existed BEFORE the loop, never the ones freshly inserted this call). Because
  // no token exists in `result` until pass 2, no value can ever land inside one.
  const sentinel = pickReplacementSentinel(content, uniqueValues);
  const pending: Array<{ marker: string; token: string }> = [];
  let result = content;
  let encrypted = 0;
  let skipped = 0;

  // Pass 1: live values → markers.
  for (const value of uniqueValues) {
    if (!result.includes(value)) {
      continue;
    }
    // Skip a value that only ever appears as part of an existing token's base64
    // payload (i.e. it is already-encrypted content, not a live secret).
    const appearsOutsideTokens = occursOutsideTokens(result, value, existingTokens);
    if (!appearsOutsideTokens) {
      skipped++;
      continue;
    }

    const marker = makeMarker(sentinel, uniqueValues);
    result = result.split(value).join(marker);
    pending.push({ marker, token: encryptWithKey(value, derived) });
    encrypted++;
  }

  // Pass 2: markers → tokens. Tokens only enter `result` now, so none can be
  // corrupted by a value replacement.
  for (const { marker, token } of pending) {
    result = result.split(marker).join(token);
  }

  return { content: result, encrypted, skipped };
};

/**
 * True when `value` occurs somewhere in `content` outside of the given token
 * strings. Used to avoid re-encrypting a value that only exists as part of an
 * already-present ciphertext token.
 */
const occursOutsideTokens = (
  content: string,
  value: string,
  tokens: string[]
): boolean => {
  if (tokens.length === 0) {
    return content.includes(value);
  }
  // Blank out every token region, then check if the value still appears.
  let masked = content;
  for (const token of tokens) {
    masked = masked.split(token).join(' '.repeat(token.length));
  }
  return masked.includes(value);
};

/**
 * Replace every value token in `content` with its decrypted plaintext.
 *
 * Tokens are decrypted independently; a per-salt key cache means files written
 * by a single {@link encryptContentValues} call derive the key just once. When
 * `throwOnFailure` is true (the default) the first undecryptable token throws;
 * otherwise failures are counted and their tokens left in place.
 */
export const decryptContentValues = async (
  content: string,
  passphrase: string,
  options: { throwOnFailure?: boolean } = {}
): Promise<DecryptValuesResult> => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new DecryptionError('Passphrase must be a non-empty string');
  }
  const throwOnFailure = options.throwOnFailure ?? true;

  const tokens = [...new Set(findValueTokens(content))];
  if (tokens.length === 0) {
    return { content, decrypted: 0, failed: 0 };
  }

  // Per-call key cache. Every token written by one encryptContentValues call
  // shares a single salt, so without a cache a 50-token file would run the
  // 600k-iteration PBKDF2 fifty times (seconds of CPU). Keying on salt+iterations
  // (the passphrase is fixed for the whole call) collapses that to one derivation
  // per distinct salt. Promises are cached so a same-salt token reuses the very
  // first derivation even before it resolves. The cache is scoped to this call —
  // derived keys never outlive the operation.
  const keyCache = new Map<string, Promise<Buffer>>();
  const deriveCached = (salt: Buffer, iterations: number): Promise<Buffer> => {
    const cacheKey = `${iterations}:${salt.toString('base64')}`;
    let derived = keyCache.get(cacheKey);
    if (!derived) {
      derived = keyDerivation.derive(passphrase, salt, iterations);
      keyCache.set(cacheKey, derived);
    }
    return derived;
  };

  let result = content;
  let decrypted = 0;
  let failed = 0;

  for (const token of tokens) {
    try {
      const parts = parseTokenPayload(token);
      const key = await deriveCached(parts.salt, parts.iterations);
      const plaintext = decryptTokenParts(parts, key);
      // Two-step replace via a random marker: a decrypted plaintext could, in a
      // pathological case, contain another not-yet-processed token's text, so we
      // never insert plaintext where a later iteration might rescan it. split/join
      // is a LITERAL replace (unlike String.replace it never interprets
      // `$`-sequences in the secret), preserving the credential byte-for-byte.
      const marker = ` TUCK_DEC_${randomBytes(12).toString('hex')} `;
      result = result.split(token).join(marker);
      result = result.split(marker).join(plaintext);
      decrypted++;
    } catch (error) {
      if (throwOnFailure) {
        throw error;
      }
      failed++;
    }
  }

  return { content: result, decrypted, failed };
};

// ============================================================================
// File-level operations
// ============================================================================

export interface EncryptFileResult extends EncryptValuesResult {
  /** True when the file content changed and was rewritten. */
  changed: boolean;
}

export interface DecryptFileResult extends DecryptValuesResult {
  /** True when the file content changed and was rewritten. */
  changed: boolean;
}

/**
 * Encrypt detected secret values in a file in place, preserving its structure.
 *
 * Uses an atomic write so a crash mid-write never truncates the file. Returns
 * `changed: false` (without touching the file) when nothing was encrypted.
 */
export const encryptFileValues = async (
  filepath: string,
  matches: SecretMatch[],
  passphrase: string
): Promise<EncryptFileResult> => {
  const expandedPath = expandPath(filepath);
  const content = await readFile(expandedPath, 'utf-8');
  const result = await encryptContentValues(content, matches, passphrase);

  if (result.content === content) {
    return { ...result, changed: false };
  }

  await atomicWriteFile(expandedPath, result.content);
  return { ...result, changed: true };
};

/**
 * Decrypt all value tokens in a file in place.
 *
 * Uses an atomic write and only rewrites when at least one token decrypted.
 * Returns `changed: false` when the file has no tokens.
 */
export const decryptFileValues = async (
  filepath: string,
  passphrase: string,
  options: { throwOnFailure?: boolean } = {}
): Promise<DecryptFileResult> => {
  const expandedPath = expandPath(filepath);
  const content = await readFile(expandedPath, 'utf-8');
  const result = await decryptContentValues(content, passphrase, options);

  if (result.decrypted === 0 || result.content === content) {
    return { ...result, changed: false };
  }

  await atomicWriteFile(expandedPath, result.content);
  return { ...result, changed: true };
};

/**
 * True when the path is an existing regular file that contains value tokens.
 * Directories, missing paths, and binary/unreadable files return false.
 */
export const fileHasEncryptedValues = async (filepath: string): Promise<boolean> => {
  const expandedPath = expandPath(filepath);
  if (!(await pathExists(expandedPath))) {
    return false;
  }
  try {
    if ((await stat(expandedPath)).isDirectory()) {
      return false;
    }
    const content = await readFile(expandedPath, 'utf-8');
    return hasEncryptedValues(content);
  } catch {
    return false;
  }
};
