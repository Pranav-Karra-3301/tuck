/**
 * Machine-local keyed-HMAC drift cache — how read-only commands detect drift in
 * encrypted files WITHOUT decrypting anything.
 *
 * The problem: an encrypted tracked file holds CIPHERTEXT in the repo and
 * PLAINTEXT on the live system. To tell whether the user edited the live copy,
 * the naive approach decrypts the repo copy and compares — which unlocks the
 * keystore and can pop a prompt on every `tuck status`.
 *
 * The fix: whenever a NON-read-only command already holds the plaintext (verify,
 * apply, restore, sync), it records a keyed HMAC of that plaintext here, pinned
 * to the repo copy's checksum. Then a read-only command computes the HMAC of the
 * CURRENT live bytes and compares — no decryption, no keystore, no prompt.
 *
 *   live HMAC == cached HMAC  → live matches last-known-good → no local drift
 *   live HMAC != cached HMAC  → user edited the live file    → drift-local
 *   no fresh cache entry      → unknown (read-only degrades to "ok"; a full
 *                               command such as `tuck verify` warms the cache)
 *
 * Why keyed (HMAC) rather than a plain checksum: a bare SHA-256 of a secret's
 * plaintext would let anyone who reads the cache confirm a guessed secret value
 * offline. Keying with a machine-local random key defeats that — the cache is
 * useless without the key, and the key never leaves this machine and is never
 * committed to the repo.
 *
 * Both the key and the cache live in tuck's per-machine state directory, NOT in
 * the repo, because a fingerprint keyed by machine A's key is meaningless on
 * machine B. Nothing here is ever pushed to git.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getStateDir } from '../state.js';
import { atomicWriteFile } from '../files.js';
import { pathExists } from '../paths.js';
import { driftCacheSchema, type DriftCache, type DriftEntry } from '../../schemas/driftCache.schema.js';

/** Result of comparing a live file against its cached fingerprint. */
export type DriftComparison =
  /** Live bytes match the last-known-good plaintext — no local drift. */
  | 'match'
  /** Live bytes differ from the last-known-good plaintext — local drift. */
  | 'mismatch'
  /** No usable fingerprint (no key, no entry, or the repo copy moved on). */
  | 'unknown';

const getDriftKeyPath = (): string => join(getStateDir(), 'drift.key');
const getDriftCachePath = (): string => join(getStateDir(), 'drift-cache.json');

/**
 * In-process cache of the machine-local HMAC key so we read the key file at most
 * once per run. `undefined` = not yet loaded; `null` = loaded and absent.
 */
let keyCache: Buffer | null | undefined;

const writeFileSecure = async (filePath: string, data: string): Promise<void> => {
  // atomicWriteFile writes a sibling temp file then renames, so the parent dir
  // must already exist — the state dir is not guaranteed to be present yet.
  await mkdir(dirname(filePath), { recursive: true });
  // 0600: the drift key and cache are per-machine secrets-adjacent state.
  // Atomic temp+rename so a crash mid-write never leaves a truncated cache
  // (the standard for every other JSON state file in the repo).
  await atomicWriteFile(filePath, data, { mode: 0o600 });
};

/**
 * Load the machine-local HMAC key.
 *
 * @param create When true, generate and persist a fresh 32-byte key if none
 *   exists. Read-only callers pass `false` so an inspection command never writes
 *   to disk; write callers (recordDriftEntry) pass `true`.
 * @returns The key, or null when absent and `create` is false.
 */
export const getDriftKey = async (create = false): Promise<Buffer | null> => {
  if (keyCache !== undefined) {
    if (keyCache !== null) return keyCache;
    if (!create) return null;
    // keyCache === null but caller wants to create — fall through to generate.
  }

  const keyPath = getDriftKeyPath();
  if (await pathExists(keyPath)) {
    try {
      const raw = (await readFile(keyPath, 'utf-8')).trim();
      const buf = Buffer.from(raw, 'base64');
      if (buf.length >= 32) {
        keyCache = buf;
        return buf;
      }
    } catch {
      // Unreadable/corrupt key — regenerate below if allowed.
    }
  }

  if (!create) {
    keyCache = null;
    return null;
  }

  // Single-flight: concurrent first-warm callers (computeStateModel records
  // entries via Promise.all) must all receive the SAME key — two generated
  // keys would leave some entries HMAC'd under a lost key, which later compare
  // as 'mismatch' and emit the false drift signal this module promises never
  // to produce.
  if (!keyCreationInFlight) {
    keyCreationInFlight = (async (): Promise<Buffer | null> => {
      const freshKey = randomBytes(32);
      try {
        await mkdir(dirname(keyPath), { recursive: true });
        // 'wx' (O_EXCL): lose the cross-process race gracefully — whoever
        // creates the file wins, everyone else re-reads it.
        await writeFile(keyPath, freshKey.toString('base64'), { mode: 0o600, flag: 'wx' });
        // A brand-new key invalidates every existing entry (they were HMAC'd
        // under a key that no longer exists — e.g. the corrupt-key path).
        await clearDriftEntries();
        keyCache = freshKey;
        return freshKey;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          try {
            const raw = (await readFile(keyPath, 'utf-8')).trim();
            const buf = Buffer.from(raw, 'base64');
            if (buf.length >= 32) {
              keyCache = buf;
              return buf;
            }
          } catch {
            // fall through
          }
        }
        keyCache = null;
        return null;
      } finally {
        keyCreationInFlight = null;
      }
    })();
  }
  return keyCreationInFlight;
};

/** In-flight key generation, shared by concurrent callers (single-flight). */
let keyCreationInFlight: Promise<Buffer | null> | null = null;

/** Drop every cache entry (the key changed; old HMACs are meaningless). */
const clearDriftEntries = async (): Promise<void> => {
  try {
    await writeFileSecure(getDriftCachePath(), JSON.stringify(emptyCache(), null, 2));
  } catch {
    // Best-effort.
  }
};

/**
 * Serialize read-modify-write cycles on the cache file: concurrent
 * recordDriftEntry calls would otherwise lose each other's entries.
 */
let cacheWriteQueue: Promise<void> = Promise.resolve();

/** Keyed HMAC-SHA256 (hex) of `plaintext` under the given key. */
export const computePlaintextHmac = (plaintext: Buffer | string, key: Buffer): string =>
  createHmac('sha256', key).update(plaintext).digest('hex');

const emptyCache = (): DriftCache => ({ version: 1, entries: {} });

/** Read and validate the drift cache. Returns an empty cache on missing/corrupt. */
export const readDriftCache = async (): Promise<DriftCache> => {
  const cachePath = getDriftCachePath();
  if (!(await pathExists(cachePath))) return emptyCache();
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf-8'));
    const result = driftCacheSchema.safeParse(parsed);
    return result.success ? result.data : emptyCache();
  } catch {
    return emptyCache();
  }
};

/** Look up a single file's fingerprint, or null if none is recorded. */
export const getDriftEntry = async (fileId: string): Promise<DriftEntry | null> => {
  const cache = await readDriftCache();
  return cache.entries[fileId] ?? null;
};

/**
 * Record (or refresh) a file's last-known-good plaintext fingerprint.
 *
 * Called by NON-read-only commands that already hold the plaintext. Generates
 * the machine-local key on first use. Never throws to the caller — a drift-cache
 * write failure must not break apply/verify (it only means the next read-only
 * status degrades to "unknown" for this file).
 *
 * @param fileId Manifest file id.
 * @param plaintext The plaintext that belongs on the live system.
 * @param repoChecksum Checksum of the repo copy this plaintext was derived from.
 */
export const recordDriftEntry = async (
  fileId: string,
  plaintext: Buffer | string,
  repoChecksum: string
): Promise<void> => {
  try {
    const key = await getDriftKey(true);
    if (!key) return;
    const hmac = computePlaintextHmac(plaintext, key);
    // Queue the read-modify-write so concurrent recorders (Promise.all in
    // computeStateModel) never clobber each other's entries.
    const task = cacheWriteQueue.then(async () => {
      const cache = await readDriftCache();
      cache.entries[fileId] = {
        plaintextHmac: hmac,
        repoChecksum,
        updated: new Date().toISOString(),
      };
      await writeFileSecure(getDriftCachePath(), JSON.stringify(cache, null, 2));
    });
    cacheWriteQueue = task.catch(() => undefined);
    await task;
  } catch {
    // Best-effort cache; never surface to the caller.
  }
};

/**
 * Compare live bytes against the cached fingerprint WITHOUT any decryption.
 *
 * Returns `'unknown'` (never a false drift signal) when there is no key, no
 * entry, or the entry was derived from a different repo copy than the one now on
 * disk. Read-only commands treat `'unknown'` as "no reportable drift".
 *
 * @param fileId Manifest file id.
 * @param liveBytes Current bytes of the live file.
 * @param repoChecksum Checksum of the current repo copy.
 */
export const compareLiveToCache = async (
  fileId: string,
  liveBytes: Buffer | string,
  repoChecksum: string
): Promise<DriftComparison> => {
  const key = await getDriftKey(false);
  if (!key) return 'unknown';

  const entry = await getDriftEntry(fileId);
  if (!entry) return 'unknown';
  // Pinned to a stale repo copy (e.g. after `git pull`): can't trust it.
  if (entry.repoChecksum !== repoChecksum) return 'unknown';

  return computePlaintextHmac(liveBytes, key) === entry.plaintextHmac ? 'match' : 'mismatch';
};

/** Reset the in-process key cache. For tests. */
export const resetDriftKeyCache = (): void => {
  keyCache = undefined;
  keyCreationInFlight = null;
};
