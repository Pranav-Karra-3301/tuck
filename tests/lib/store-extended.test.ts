/**
 * Local secrets store (secrets.local.json) tests.
 *
 * This file holds real plaintext secret values and is never committed. These
 * tests fill gaps around: 0600 permissions on save, permission auto-repair on
 * load, corrupt-store hard failure vs empty-store defaults, bulk set/touch, the
 * value-vs-metadata listing split, and the name validation/normalization rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_TUCK_DIR } from '../setup.js';
import {
  getSecretsPath,
  loadSecretsStore,
  saveSecretsStore,
  setSecret,
  getSecret,
  unsetSecret,
  hasSecret,
  listSecrets,
  getAllSecrets,
  getSecretCount,
  setSecrets,
  touchSecrets,
  isValidSecretName,
  normalizeSecretName,
} from '../../src/lib/secrets/store.js';

const STORE_FILE = join(TEST_TUCK_DIR, 'secrets.local.json');

describe('secrets store', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });
  afterEach(() => {
    vol.reset();
  });

  it('loadSecretsStore returns an empty store when the file is absent', async () => {
    const store = await loadSecretsStore(TEST_TUCK_DIR);
    expect(store).toEqual({ version: '1.0.0', secrets: {} });
  });

  it('setSecret / getSecret round-trip and preserve addedAt on update', async () => {
    await setSecret(TEST_TUCK_DIR, 'API_KEY', 'v1', { description: 'd', source: 's' });
    expect(await getSecret(TEST_TUCK_DIR, 'API_KEY')).toBe('v1');

    const first = await loadSecretsStore(TEST_TUCK_DIR);
    const addedAt = first.secrets.API_KEY.addedAt;

    await setSecret(TEST_TUCK_DIR, 'API_KEY', 'v2');
    const second = await loadSecretsStore(TEST_TUCK_DIR);
    expect(second.secrets.API_KEY.value).toBe('v2');
    // addedAt is stable across updates; placeholder is derived from the name.
    expect(second.secrets.API_KEY.addedAt).toBe(addedAt);
    expect(second.secrets.API_KEY.placeholder).toBe('{{API_KEY}}');
  });

  it('saveSecretsStore writes the file with 0600 permissions', async () => {
    await setSecret(TEST_TUCK_DIR, 'API_KEY', 'v');
    const mode = vol.statSync(STORE_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('loadSecretsStore repairs over-permissive files to 0600', async () => {
    // Write a valid store that is world/group-readable.
    vol.writeFileSync(
      STORE_FILE,
      JSON.stringify({ version: '1.0.0', secrets: {} }),
      { mode: 0o644 }
    );
    await loadSecretsStore(TEST_TUCK_DIR);
    const mode = vol.statSync(STORE_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('loadSecretsStore throws a clear error on a corrupt store', async () => {
    vol.writeFileSync(STORE_FILE, '{ this is not json', { mode: 0o600 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadSecretsStore(TEST_TUCK_DIR)).rejects.toThrow(
      'Failed to load secrets store'
    );
    errSpy.mockRestore();
  });

  it('unsetSecret removes an existing secret and reports false for a missing one', async () => {
    await setSecret(TEST_TUCK_DIR, 'A', '1');
    expect(await unsetSecret(TEST_TUCK_DIR, 'A')).toBe(true);
    expect(await hasSecret(TEST_TUCK_DIR, 'A')).toBe(false);
    expect(await unsetSecret(TEST_TUCK_DIR, 'GHOST')).toBe(false);
  });

  it('listSecrets returns metadata WITHOUT values; getAllSecrets returns name→value', async () => {
    await setSecret(TEST_TUCK_DIR, 'A', 'secret-a', { description: 'da' });
    await setSecret(TEST_TUCK_DIR, 'B', 'secret-b');

    const list = await listSecrets(TEST_TUCK_DIR);
    expect(list).toHaveLength(2);
    // No "value" key is leaked in the display listing.
    for (const entry of list) {
      expect(Object.prototype.hasOwnProperty.call(entry, 'value')).toBe(false);
    }

    const all = await getAllSecrets(TEST_TUCK_DIR);
    expect(all).toEqual({ A: 'secret-a', B: 'secret-b' });
    expect(await getSecretCount(TEST_TUCK_DIR)).toBe(2);
  });

  it('setSecrets bulk-adds multiple secrets in one write', async () => {
    await setSecrets(TEST_TUCK_DIR, [
      { name: 'A', value: '1' },
      { name: 'B', value: '2', description: 'db' },
    ]);
    expect(await getAllSecrets(TEST_TUCK_DIR)).toEqual({ A: '1', B: '2' });
  });

  it('touchSecrets updates lastUsed only for known names', async () => {
    await setSecret(TEST_TUCK_DIR, 'A', '1');
    const before = (await loadSecretsStore(TEST_TUCK_DIR)).secrets.A.lastUsed;

    // Advance the clock so the ISO timestamp is guaranteed to differ.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5000));
    await touchSecrets(TEST_TUCK_DIR, ['A', 'UNKNOWN']);
    vi.useRealTimers();

    const after = (await loadSecretsStore(TEST_TUCK_DIR)).secrets.A.lastUsed;
    expect(after).not.toBe(before);
    // The unknown name did not create an entry.
    expect(await hasSecret(TEST_TUCK_DIR, 'UNKNOWN')).toBe(false);
  });

  it('touchSecrets is a no-op (no write) when no names match', async () => {
    await setSecret(TEST_TUCK_DIR, 'A', '1');
    const raw = vol.readFileSync(STORE_FILE, 'utf-8');
    await touchSecrets(TEST_TUCK_DIR, ['NOPE']);
    // Byte-for-byte unchanged since nothing matched.
    expect(vol.readFileSync(STORE_FILE, 'utf-8')).toBe(raw);
  });

  it('getSecretsPath joins the tuck dir and store filename', () => {
    expect(getSecretsPath(TEST_TUCK_DIR)).toBe(STORE_FILE);
  });

  it('saveSecretsStore + loadSecretsStore round-trip an explicit store object', async () => {
    await saveSecretsStore(TEST_TUCK_DIR, {
      version: '1.0.0',
      secrets: {
        TOK: {
          value: 'v',
          placeholder: '{{TOK}}',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    const loaded = await loadSecretsStore(TEST_TUCK_DIR);
    expect(loaded.secrets.TOK.value).toBe('v');
  });
});

describe('secret name validation & normalization', () => {
  it('isValidSecretName accepts UPPER_SNAKE and rejects other shapes', () => {
    expect(isValidSecretName('API_KEY')).toBe(true);
    expect(isValidSecretName('A')).toBe(true);
    expect(isValidSecretName('lowercase')).toBe(false);
    expect(isValidSecretName('1LEADING_DIGIT')).toBe(false);
    expect(isValidSecretName('HAS-DASH')).toBe(false);
    expect(isValidSecretName('')).toBe(false);
    expect(isValidSecretName('X'.repeat(101))).toBe(false);
  });

  it('normalizeSecretName uppercases, replaces separators, and collapses underscores', () => {
    expect(normalizeSecretName('github token')).toBe('GITHUB_TOKEN');
    expect(normalizeSecretName('aws.access-key')).toBe('AWS_ACCESS_KEY');
    expect(normalizeSecretName('__leading__trailing__')).toBe('LEADING_TRAILING');
  });

  it('normalizeSecretName prefixes when the result would not start with a letter', () => {
    // Leading digits are stripped; "123abc" → "ABC".
    expect(normalizeSecretName('123abc')).toBe('ABC');
    // A purely non-alpha input falls back to the SECRET sentinel.
    expect(normalizeSecretName('123456')).toBe('SECRET');
    expect(normalizeSecretName('!!!')).toBe('SECRET');
  });

  it('normalizeSecretName truncates to the max length', () => {
    const long = 'a'.repeat(150);
    expect(normalizeSecretName(long).length).toBeLessThanOrEqual(100);
  });
});
