import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getCachedKeystorePassphrase,
  primeSessionKeyCache,
  hasSessionKey,
  setSessionKeyTtl,
  clearSessionKeyCache,
} from '../../src/lib/crypto/sessionKeyCache.js';
import { enterReadOnlyMode, resetReadOnlyMode } from '../../src/lib/readOnlyMode.js';

describe('sessionKeyCache', () => {
  afterEach(() => {
    clearSessionKeyCache();
    resetReadOnlyMode();
  });

  it('unlocks the keystore at most once per session (one fetch for many reads)', async () => {
    const fetch = vi.fn(async () => 'pw');
    expect(await getCachedKeystorePassphrase(fetch)).toBe('pw');
    expect(await getCachedKeystorePassphrase(fetch)).toBe('pw');
    expect(await getCachedKeystorePassphrase(fetch)).toBe('pw');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caches a null answer too (keystore has no key) without re-fetching', async () => {
    const fetch = vi.fn(async () => null);
    expect(await getCachedKeystorePassphrase(fetch)).toBeNull();
    expect(await getCachedKeystorePassphrase(fetch)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never fetches in read-only mode and returns null when nothing is cached', async () => {
    enterReadOnlyMode();
    const fetch = vi.fn(async () => 'pw');
    expect(await getCachedKeystorePassphrase(fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(hasSessionKey()).toBe(false);
  });

  it('serves a value cached BEFORE read-only mode without touching the keystore', async () => {
    primeSessionKeyCache('cached-pw');
    enterReadOnlyMode();
    const fetch = vi.fn(async () => 'fresh-pw');
    expect(await getCachedKeystorePassphrase(fetch)).toBe('cached-pw');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('re-fetches after the TTL expires', async () => {
    setSessionKeyTtl(0); // every entry is immediately stale
    const fetch = vi
      .fn<[], Promise<string | null>>()
      .mockResolvedValueOnce('one')
      .mockResolvedValueOnce('two');
    expect(await getCachedKeystorePassphrase(fetch)).toBe('one');
    // wait a tick so Date.now() advances past expiresAt
    await new Promise((r) => setTimeout(r, 2));
    expect(await getCachedKeystorePassphrase(fetch)).toBe('two');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('clearSessionKeyCache forgets the cached value', async () => {
    primeSessionKeyCache('pw');
    expect(hasSessionKey()).toBe(true);
    clearSessionKeyCache();
    expect(hasSessionKey()).toBe(false);
  });
});
