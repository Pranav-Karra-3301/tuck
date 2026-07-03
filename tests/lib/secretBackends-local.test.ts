/**
 * LocalBackend tests.
 *
 * The local backend is the always-available fallback that reads
 * secrets.local.json. It must report itself available/authenticated with no
 * external deps, return stored values (and null for misses), and surface the
 * stored metadata via listSecrets. Exercised over memfs + the real store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_TUCK_DIR } from '../setup.js';
import { LocalBackend } from '../../src/lib/secretBackends/local.js';
import { setSecret } from '../../src/lib/secrets/store.js';

describe('LocalBackend', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });
  afterEach(() => {
    vol.reset();
  });

  it('advertises its identity and is always available/authenticated', async () => {
    const backend = new LocalBackend(TEST_TUCK_DIR);
    expect(backend.name).toBe('local');
    expect(backend.displayName).toBe('Local secrets file');
    expect(backend.cliName).toBeNull();
    expect(await backend.isAvailable()).toBe(true);
    expect(await backend.isAuthenticated()).toBe(true);
  });

  it('authenticate() and lock() are no-ops that resolve', async () => {
    const backend = new LocalBackend(TEST_TUCK_DIR);
    await expect(backend.authenticate()).resolves.toBeUndefined();
    await expect(backend.lock()).resolves.toBeUndefined();
  });

  it('getSecret returns the stored value', async () => {
    await setSecret(TEST_TUCK_DIR, 'API_KEY', 'abc123');
    const backend = new LocalBackend(TEST_TUCK_DIR);
    expect(await backend.getSecret({ name: 'API_KEY' })).toBe('abc123');
  });

  it('getSecret returns null for an unknown secret', async () => {
    const backend = new LocalBackend(TEST_TUCK_DIR);
    expect(await backend.getSecret({ name: 'MISSING' })).toBeNull();
  });

  it('listSecrets maps store entries to SecretInfo with placeholder + lastModified', async () => {
    await setSecret(TEST_TUCK_DIR, 'API_KEY', 'v', { description: 'test key' });
    const backend = new LocalBackend(TEST_TUCK_DIR);

    const list = await backend.listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('API_KEY');
    expect(list[0].path).toBe('{{API_KEY}}');
    // setSecret always stamps lastUsed → lastModified is a Date.
    expect(list[0].lastModified).toBeInstanceOf(Date);
  });

  it('listSecrets returns an empty array when the store is empty', async () => {
    const backend = new LocalBackend(TEST_TUCK_DIR);
    expect(await backend.listSecrets()).toEqual([]);
  });

  it('getSetupInstructions mentions the local secrets file', () => {
    const backend = new LocalBackend(TEST_TUCK_DIR);
    const help = backend.getSetupInstructions();
    expect(help).toContain('secrets.local.json');
    expect(help).toContain('tuck secrets set');
  });
});
