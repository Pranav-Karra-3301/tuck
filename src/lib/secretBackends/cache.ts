/**
 * In-memory cache for secret values
 *
 * Caches resolved secrets to avoid repeated calls to password managers.
 * Cache entries expire based on configured timeout.
 */

import type { BackendName, CachedSecret } from './types.js';

/** Default cache timeout in milliseconds (5 minutes) */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * SecretCache provides in-memory caching for resolved secrets.
 *
 * Features:
 * - TTL-based expiration
 * - Cache statistics
 * - Selective invalidation
 */
export class SecretCache {
  private cache = new Map<string, CachedSecret>();
  private hits = 0;
  private misses = 0;

  /**
   * Create a new secret cache
   * @param defaultTtlMs - Default time-to-live in milliseconds
   */
  constructor(private defaultTtlMs: number = DEFAULT_TTL_MS) {}

  /**
   * Get a cached secret
   * @param name - The secret placeholder name
   * @returns The cached secret, or null if not found or expired
   */
  get(name: string): CachedSecret | null {
    const entry = this.cache.get(name);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(name);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry;
  }

  /**
   * Cache a secret value
   * @param name - The secret placeholder name
   * @param value - The secret value
   * @param backend - Which backend provided the value
   * @param ttlMs - Optional TTL override in milliseconds
   */
  set(name: string, value: string, backend: BackendName, ttlMs?: number): void {
    const now = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;

    this.cache.set(name, {
      value,
      backend,
      timestamp: now,
      expiresAt: now + ttl,
    });
  }

  /**
   * Invalidate a specific secret or all secrets
   * @param name - Optional secret name. If not provided, clears all.
   */
  invalidate(name?: string): void {
    if (name) {
      this.cache.delete(name);
    } else {
      this.cache.clear();
    }
  }
}

/** Global cache instance (shared across the session) */
let globalCache: SecretCache | null = null;

/**
 * Get the global secret cache instance
 * @param ttlMs - Optional TTL override (only used on first call)
 */
export const getGlobalCache = (ttlMs?: number): SecretCache => {
  if (!globalCache) {
    globalCache = new SecretCache(ttlMs);
  }
  return globalCache;
};

/**
 * Reset the global cache instance (for testing)
 * This destroys the singleton and allows a fresh cache to be created
 */
export const resetGlobalCache = (): void => {
  globalCache = null;
};
