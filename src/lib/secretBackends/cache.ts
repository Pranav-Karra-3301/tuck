/**
 * In-memory cache for secret values
 *
 * Caches resolved secrets to avoid repeated calls to password managers.
 * Cache entries expire based on configured timeout.
 */

import type { BackendName, CachedSecret, CacheStats } from './types.js';

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
   * Check if a secret is cached (and not expired)
   * @param name - The secret placeholder name
   * @returns true if cached and not expired
   */
  has(name: string): boolean {
    const entry = this.cache.get(name);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(name);
      return false;
    }
    return true;
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

  /**
   * Invalidate all secrets from a specific backend
   * @param backend - The backend to invalidate
   */
  invalidateBackend(backend: BackendName): void {
    for (const [name, entry] of this.cache.entries()) {
      if (entry.backend === backend) {
        this.cache.delete(name);
      }
    }
  }

  /**
   * Remove expired entries from the cache
   * @returns Number of entries removed
   */
  prune(): number {
    const now = Date.now();
    let removed = 0;

    for (const [name, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(name);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * Reset statistics counters
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get all cached secret names
   */
  keys(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Get cache hit rate as a percentage
   */
  getHitRate(): number {
    const total = this.hits + this.misses;
    if (total === 0) return 0;
    return (this.hits / total) * 100;
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
 * Clear the global cache contents (keeps the instance)
 */
export const clearGlobalCache = (): void => {
  if (globalCache) {
    globalCache.invalidate();
  }
};

/**
 * Reset the global cache instance (for testing)
 * This destroys the singleton and allows a fresh cache to be created
 */
export const resetGlobalCache = (): void => {
  globalCache = null;
};
