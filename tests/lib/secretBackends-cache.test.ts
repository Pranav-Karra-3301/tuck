/**
 * SecretCache unit tests.
 *
 * The cache sits in front of every password-manager call, so a stale/expired
 * entry served as fresh, or a failure to expire, is a correctness AND a security
 * concern (a rotated secret could keep resolving to the old value). These tests
 * lock in TTL expiry, hit/miss accounting, selective + backend-wide
 * invalidation, pruning, and the process-global singleton lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SecretCache,
  getGlobalCache,
  clearGlobalCache,
  resetGlobalCache,
} from '../../src/lib/secretBackends/cache.js';

describe('SecretCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stored value on a hit and records the hit', () => {
    const cache = new SecretCache();
    cache.set('TOKEN', 'sekret', 'local');

    const entry = cache.get('TOKEN');
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe('sekret');
    expect(entry!.backend).toBe('local');
    expect(cache.getStats()).toMatchObject({ size: 1, hits: 1, misses: 0 });
  });

  it('returns null and records a miss for an unknown key', () => {
    const cache = new SecretCache();
    expect(cache.get('NOPE')).toBeNull();
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hits).toBe(0);
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
    expect(cache.keys()).toEqual([]);
  });

  it('honors a per-entry TTL override', () => {
    vi.useFakeTimers();
    const cache = new SecretCache(60_000);
    cache.set('SHORT', 'v', 'local', 500);

    vi.advanceTimersByTime(600);
    expect(cache.get('SHORT')).toBeNull();
  });

  it('has() reports presence and evicts expired entries as a side effect', () => {
    vi.useFakeTimers();
    const cache = new SecretCache(1000);
    cache.set('A', '1', 'local');
    expect(cache.has('A')).toBe(true);
    expect(cache.has('MISSING')).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(cache.has('A')).toBe(false);
    expect(cache.keys()).toEqual([]);
  });

  it('invalidate(name) removes only that entry; invalidate() clears all', () => {
    const cache = new SecretCache();
    cache.set('A', '1', 'local');
    cache.set('B', '2', 'local');

    cache.invalidate('A');
    expect(cache.has('A')).toBe(false);
    expect(cache.has('B')).toBe(true);

    cache.invalidate();
    expect(cache.keys()).toEqual([]);
  });

  it('invalidateBackend removes only entries from that backend', () => {
    const cache = new SecretCache();
    cache.set('A', '1', 'local');
    cache.set('B', '2', '1password');
    cache.set('C', '3', '1password');

    cache.invalidateBackend('1password');
    expect(cache.keys()).toEqual(['A']);
  });

  it('prune removes expired entries and returns the count', () => {
    vi.useFakeTimers();
    const cache = new SecretCache(1000);
    cache.set('OLD', '1', 'local');
    vi.advanceTimersByTime(1500);
    cache.set('NEW', '2', 'local'); // fresh

    const removed = cache.prune();
    expect(removed).toBe(1);
    expect(cache.keys()).toEqual(['NEW']);
  });

  it('computes hit rate and resets stats', () => {
    const cache = new SecretCache();
    expect(cache.getHitRate()).toBe(0); // no requests yet

    cache.set('A', '1', 'local');
    cache.get('A'); // hit
    cache.get('B'); // miss
    expect(cache.getHitRate()).toBe(50);

    cache.resetStats();
    expect(cache.getStats()).toMatchObject({ hits: 0, misses: 0 });
    // resetStats keeps entries, only counters reset.
    expect(cache.getStats().size).toBe(1);
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

  it('clearGlobalCache empties contents but keeps the instance', () => {
    const cache = getGlobalCache();
    cache.set('A', '1', 'local');
    clearGlobalCache();
    expect(cache.keys()).toEqual([]);
    // Same instance still returned.
    expect(getGlobalCache()).toBe(cache);
  });

  it('resetGlobalCache destroys the singleton so a fresh one is created', () => {
    const first = getGlobalCache();
    first.set('A', '1', 'local');
    resetGlobalCache();
    const second = getGlobalCache();
    expect(second).not.toBe(first);
    expect(second.keys()).toEqual([]);
  });

  it('clearGlobalCache is a no-op when no cache has been created', () => {
    // Should not throw even though the singleton is null.
    expect(() => clearGlobalCache()).not.toThrow();
  });
});
