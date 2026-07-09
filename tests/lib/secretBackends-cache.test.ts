/**
 * SecretCache unit tests.
 *
 * The cache sits in front of every password-manager call, so a stale/expired
 * entry served as fresh, or a failure to expire, is a correctness AND a security
 * concern (a rotated secret could keep resolving to the old value). These tests
 * lock in TTL expiry, selective invalidation, and the process-global singleton
 * lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SecretCache,
  getGlobalCache,
  resetGlobalCache,
} from '../../src/lib/secretBackends/cache.js';

describe('SecretCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stored value on a hit', () => {
    const cache = new SecretCache();
    cache.set('TOKEN', 'sekret', 'local');

    const entry = cache.get('TOKEN');
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe('sekret');
    expect(entry!.backend).toBe('local');
  });

  it('returns null for an unknown key', () => {
    const cache = new SecretCache();
    expect(cache.get('NOPE')).toBeNull();
  });

  it('expires entries after the TTL and deletes them on read', () => {
    vi.useFakeTimers();
    const cache = new SecretCache(1000); // 1s TTL
    cache.set('TOKEN', 'v', 'local');

    // Still valid just before expiry.
    vi.advanceTimersByTime(999);
    expect(cache.get('TOKEN')?.value).toBe('v');

    // Past expiry: miss, entry pruned from the map.
    vi.advanceTimersByTime(2);
    expect(cache.get('TOKEN')).toBeNull();
  });

  it('honors a per-entry TTL override', () => {
    vi.useFakeTimers();
    const cache = new SecretCache(60_000);
    cache.set('SHORT', 'v', 'local', 500);

    vi.advanceTimersByTime(600);
    expect(cache.get('SHORT')).toBeNull();
  });

  it('invalidate(name) removes only that entry; invalidate() clears all', () => {
    const cache = new SecretCache();
    cache.set('A', '1', 'local');
    cache.set('B', '2', 'local');

    cache.invalidate('A');
    expect(cache.get('A')).toBeNull();
    expect(cache.get('B')?.value).toBe('2');

    cache.invalidate();
    expect(cache.get('B')).toBeNull();
  });
});

describe('global cache singleton', () => {
  beforeEach(() => {
    resetGlobalCache();
  });
  afterEach(() => {
    resetGlobalCache();
  });

  it('getGlobalCache returns the same instance across calls', () => {
    const a = getGlobalCache();
    const b = getGlobalCache();
    expect(a).toBe(b);
  });

  it('resetGlobalCache destroys the singleton so a fresh one is created', () => {
    const first = getGlobalCache();
    first.set('A', '1', 'local');
    resetGlobalCache();
    const second = getGlobalCache();
    expect(second).not.toBe(first);
    expect(second.get('A')).toBeNull();
  });
});
