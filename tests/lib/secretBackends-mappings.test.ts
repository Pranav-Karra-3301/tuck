/**
 * Secret mappings file management tests.
 *
 * secrets.mappings.json maps placeholder names to backend-specific paths and IS
 * version controlled. It is read to build the argv passed to op/bw/pass, so its
 * CRUD/merge/parse semantics are correctness-critical. Exercised over memfs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_TUCK_DIR } from '../setup.js';
import {
  getMappingsPath,
  loadMappings,
  saveMappings,
  getMapping,
  setMapping,
  listMappings,
  getBackendPath,
} from '../../src/lib/secretBackends/mappings.js';

const MAPPINGS_FILE = join(TEST_TUCK_DIR, 'secrets.mappings.json');

describe('secret mappings', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    vol.writeFileSync(MAPPINGS_FILE, JSON.stringify({ version: '1.0.0', mappings: {} }));
  });
  afterEach(() => {
    vol.reset();
  });

  it('getMappingsPath respects the default and a custom filename', () => {
    expect(getMappingsPath(TEST_TUCK_DIR)).toBe(MAPPINGS_FILE);
    expect(getMappingsPath(TEST_TUCK_DIR, 'custom.json')).toBe(
      join(TEST_TUCK_DIR, 'custom.json')
    );
  });

  it('loadMappings returns defaults when the file does not exist', async () => {
    vol.unlinkSync(MAPPINGS_FILE);
    const mappings = await loadMappings(TEST_TUCK_DIR);
    expect(mappings).toEqual({ version: '1.0.0', mappings: {} });
  });

  it('setMapping on the missing-file path does not mutate the shared module default', async () => {
    // Regression: loadMappings must return an independent copy (fresh nested
    // `mappings` object) so mutating one load never leaks into the next.
    vol.unlinkSync(MAPPINGS_FILE);
    await setMapping(TEST_TUCK_DIR, 'LEAK_CHECK', 'local', true);

    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    const fresh = await loadMappings(TEST_TUCK_DIR);
    expect(fresh.mappings).toEqual({});
  });

  it('loadMappings warns and returns defaults on a corrupt file', async () => {
    vol.writeFileSync(MAPPINGS_FILE, '{ not valid json ');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mappings = await loadMappings(TEST_TUCK_DIR);

    expect(mappings).toEqual({ version: '1.0.0', mappings: {} });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load mappings file')
    );
    warnSpy.mockRestore();
  });

  it('setMapping persists a backend path and round-trips via load', async () => {
    await setMapping(TEST_TUCK_DIR, 'GITHUB_TOKEN', '1password', 'op://Personal/GH/password');

    const onDisk = JSON.parse(vol.readFileSync(MAPPINGS_FILE, 'utf-8') as string);
    expect(onDisk.mappings.GITHUB_TOKEN['1password']).toBe('op://Personal/GH/password');

    const mapping = await getMapping(TEST_TUCK_DIR, 'GITHUB_TOKEN');
    expect(mapping).toEqual({ '1password': 'op://Personal/GH/password' });
  });

  it('setMapping with the "local" pseudo-backend stores a boolean flag', async () => {
    await setMapping(TEST_TUCK_DIR, 'API_KEY', 'local', true);
    expect(await getMapping(TEST_TUCK_DIR, 'API_KEY')).toEqual({ local: true });

    // The string "true" is also coerced to the boolean flag.
    await setMapping(TEST_TUCK_DIR, 'API_KEY', 'local', 'true');
    expect((await getMapping(TEST_TUCK_DIR, 'API_KEY'))!.local).toBe(true);
  });

  it('getMapping returns null for an unknown secret', async () => {
    expect(await getMapping(TEST_TUCK_DIR, 'UNKNOWN')).toBeNull();
  });

  it('getBackendPath resolves real backends and the local name-echo, else null', async () => {
    await setMapping(TEST_TUCK_DIR, 'TOKEN', 'pass', 'work/token');
    await setMapping(TEST_TUCK_DIR, 'TOKEN', 'local', true);

    expect(await getBackendPath(TEST_TUCK_DIR, 'TOKEN', 'pass')).toBe('work/token');
    // For local, a truthy flag echoes the secret name back as its "path".
    expect(await getBackendPath(TEST_TUCK_DIR, 'TOKEN', 'local')).toBe('TOKEN');
    // No bitwarden mapping configured → null.
    expect(await getBackendPath(TEST_TUCK_DIR, 'TOKEN', 'bitwarden')).toBeNull();
    // Unknown secret → null.
    expect(await getBackendPath(TEST_TUCK_DIR, 'MISSING', 'pass')).toBeNull();
  });

  it('getBackendPath returns null for local when the local flag is unset', async () => {
    await setMapping(TEST_TUCK_DIR, 'TOKEN', 'pass', 'work/token');
    expect(await getBackendPath(TEST_TUCK_DIR, 'TOKEN', 'local')).toBeNull();
  });

  it('listMappings returns the full mappings record', async () => {
    await setMapping(TEST_TUCK_DIR, 'A', 'pass', 'a');
    await setMapping(TEST_TUCK_DIR, 'B', 'pass', 'b');
    const all = await listMappings(TEST_TUCK_DIR);
    expect(Object.keys(all).sort()).toEqual(['A', 'B']);
  });

  it('saveMappings writes pretty JSON terminated by a newline', async () => {
    await saveMappings(TEST_TUCK_DIR, { version: '1.0.0', mappings: { A: { pass: 'a' } } });
    const raw = vol.readFileSync(MAPPINGS_FILE, 'utf-8') as string;
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "version"');
  });
});
