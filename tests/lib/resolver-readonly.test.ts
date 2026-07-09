/**
 * The secret resolver must refuse to reach a backend while a read-only command
 * is running — but a CACHE HIT (which touches no backend) is still allowed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createResolver } from '../../src/lib/secretBackends/resolver.js';
import { getGlobalCache, resetGlobalCache } from '../../src/lib/secretBackends/cache.js';
import { enterReadOnlyMode, resetReadOnlyMode } from '../../src/lib/readOnlyMode.js';
import { ReadOnlyViolationError } from '../../src/errors.js';
import { securityConfigSchema } from '../../src/schemas/secrets.schema.js';

const config = securityConfigSchema.parse({});

describe('SecretResolver read-only guard', () => {
  beforeEach(() => {
    resetGlobalCache();
    resetReadOnlyMode();
  });
  afterEach(() => {
    resetReadOnlyMode();
    resetGlobalCache();
  });

  it('throws ReadOnlyViolationError before touching any backend', async () => {
    const resolver = createResolver('/test-home/.tuck', config);
    enterReadOnlyMode();
    await expect(resolver.resolveSecret('API_KEY')).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });

  it('still serves a cached secret in read-only mode (no backend access)', async () => {
    // Seed the shared cache the resolver reads from.
    getGlobalCache().set('API_KEY', 'cached-value', 'local');
    const resolver = createResolver('/test-home/.tuck', config);
    enterReadOnlyMode();
    const result = await resolver.resolveSecret('API_KEY');
    expect(result?.value).toBe('cached-value');
    expect(result?.cached).toBe(true);
  });
});
