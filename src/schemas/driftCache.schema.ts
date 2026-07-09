import { z } from 'zod';

/**
 * A single tracked file's last-known-good plaintext fingerprint.
 *
 * `plaintextHmac` is a keyed HMAC-SHA256 (hex) of the plaintext tuck last knew
 * belonged on the live system for this file. The HMAC key is machine-local (see
 * `driftCache.ts`), so this fingerprint reveals nothing about the secret to
 * anyone who does not already hold that local key — which is exactly why it is
 * safe to compare against WITHOUT decrypting anything.
 *
 * `repoChecksum` pins the fingerprint to the repo copy it was derived from: if
 * the repo file changes (e.g. a `git pull`), the entry is considered stale and
 * ignored until a full command re-derives it.
 */
export const driftEntrySchema = z.object({
  plaintextHmac: z.string(),
  repoChecksum: z.string(),
  updated: z.string(),
});

export const driftCacheSchema = z.object({
  version: z.literal(1),
  entries: z.record(driftEntrySchema).default({}),
});

export type DriftEntry = z.output<typeof driftEntrySchema>;
export type DriftCache = z.output<typeof driftCacheSchema>;
