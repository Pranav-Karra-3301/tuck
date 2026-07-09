/**
 * Session cache for the unlocked file-encryption passphrase.
 *
 * tuck encrypts tracked files at rest with a single per-machine passphrase held
 * in the OS keystore (macOS Keychain / libsecret / Windows fallback). Retrieving
 * it can pop an interactive unlock prompt. Commands like `tuck apply` decrypt
 * MANY files in one run — without caching, that is one keystore round-trip (and
 * potentially one prompt) PER FILE.
 *
 * This module unlocks the keystore AT MOST ONCE per process and memoizes the
 * result with a TTL, so a whole apply/restore run costs a single prompt. It is
 * also the enforcement point for the read-only guarantee: when a read-only
 * command (status/diff/list) is running, this cache NEVER reaches out to the
 * keystore — it returns a value already cached in this process or `null`, so no
 * prompt can appear.
 *
 * "Unlocked key" here means the passphrase string in process memory; it is never
 * written to disk. The cache lives only for the lifetime of the process (plus
 * the TTL, which matters for long-lived hosts such as the MCP server).
 */

import { isReadOnlyMode } from '../readOnlyMode.js';

/** Default session TTL: 15 minutes. */
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

interface CachedPassphrase {
  /** The passphrase, or null if the keystore held nothing (a real "no key" answer). */
  value: string | null;
  /** Epoch ms after which this entry is considered stale. */
  expiresAt: number;
}

let cached: CachedPassphrase | null = null;
let ttlMs = DEFAULT_SESSION_TTL_MS;

/** How the caller should fetch the passphrase on a cache miss. */
export type PassphraseFetcher = () => Promise<string | null>;

const isFresh = (entry: CachedPassphrase | null): entry is CachedPassphrase =>
  entry !== null && Date.now() < entry.expiresAt;

/**
 * Return the keystore passphrase, unlocking the keystore at most once per
 * session.
 *
 *   - If a fresh value is cached, it is returned WITHOUT calling `fetch` — so no
 *     keystore access and no prompt.
 *   - In read-only mode, the keystore is NEVER touched: a fresh cached value is
 *     returned if present, otherwise `null`. `fetch` is not invoked.
 *   - Otherwise `fetch` runs exactly once, and its result (including `null`) is
 *     cached for the TTL so repeated calls in the same run reuse it.
 *
 * @param fetch Retrieves the passphrase from the keystore. Called at most once
 *   per TTL window, and never in read-only mode.
 */
export const getCachedKeystorePassphrase = async (
  fetch: PassphraseFetcher
): Promise<string | null> => {
  if (isFresh(cached)) {
    return cached.value;
  }

  // Read-only commands must never trigger a keystore unlock. With no fresh
  // cache entry there is nothing to return but null — and crucially we do NOT
  // call `fetch`, so no prompt can appear.
  if (isReadOnlyMode()) {
    return null;
  }

  const value = await fetch();
  cached = { value, expiresAt: Date.now() + ttlMs };
  return value;
};

/**
 * Seed the cache directly (tests, or a command that already unlocked the key by
 * other means). Marks the value fresh for the current TTL.
 */
export const primeSessionKeyCache = (value: string | null): void => {
  cached = { value, expiresAt: Date.now() + ttlMs };
};

/** Whether a fresh passphrase is currently cached in this process. */
export const hasSessionKey = (): boolean => isFresh(cached);

/** Override the session TTL (milliseconds). Affects entries cached afterwards. */
export const setSessionKeyTtl = (ms: number): void => {
  ttlMs = ms;
};

/** Clear the cached passphrase and restore the default TTL. For tests / logout. */
export const clearSessionKeyCache = (): void => {
  cached = null;
  ttlMs = DEFAULT_SESSION_TTL_MS;
};
