/**
 * Zod schema for the centralized secret allowlist (secrets.allow.json)
 *
 * The allowlist is a committed, auditable file that records which specific
 * scanner findings a user has deliberately marked as safe (false positives or
 * intentionally-tracked non-secrets). It replaces scattered inline ignore
 * comments and per-file `.tuckignore` entries with one reviewable list.
 *
 * SECURITY: the allowlist NEVER stores raw secret values. Each entry keys on a
 * SHA-256 fingerprint of the value, so the file is safe to commit and share.
 */

import { z } from 'zod';

/**
 * A single allowlist entry.
 *
 * An entry suppresses a scanner match when its `fingerprint` equals the SHA-256
 * of the matched value AND (when present) the optional `pattern`/`path` scopes
 * also match. Omitting `pattern` and `path` makes the entry apply everywhere the
 * value appears.
 */
export const allowlistEntrySchema = z.object({
  /** SHA-256 hex digest of the allowed secret value (never the value itself). */
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'fingerprint must be a 64-char SHA-256 hex digest'),
  /** Human-readable justification (required — this is what makes it auditable). */
  reason: z.string().min(1),
  /** Optional pattern id scope (e.g. 'aws-access-key-id'). */
  pattern: z.string().optional(),
  /** Optional collapsed path scope (e.g. '~/.config/app/config'). */
  path: z.string().optional(),
  /** Who added the entry (best-effort, from $USER/$USERNAME). */
  addedBy: z.string().optional(),
  /** ISO-8601 timestamp of when the entry was added. */
  addedAt: z.string(),
});

export const secretsAllowlistSchema = z.object({
  version: z.string().default('1.0.0'),
  entries: z.array(allowlistEntrySchema).default([]),
});

export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;
export type SecretsAllowlist = z.infer<typeof secretsAllowlistSchema>;
