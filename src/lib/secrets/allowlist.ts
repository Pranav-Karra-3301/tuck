/**
 * Centralized, auditable secret allowlist for tuck.
 *
 * When the scanner flags a value that is actually safe (a false positive, or an
 * intentionally-tracked non-secret), the user can allowlist it once. Every
 * subsequent scan (`tuck add`, `tuck sync`, `tuck secrets scan`, the MCP server)
 * then skips that finding.
 *
 * The allowlist lives in a committed `secrets.allow.json` file so it is
 * centralized and reviewable in code review — the opposite of scattered inline
 * `# tuck:allow` comments. It records only a SHA-256 fingerprint of the value,
 * never the value itself, so it is safe to commit and share.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir } from 'fs-extra';
import { pathExists } from '../paths.js';
import { atomicWriteFile } from '../files.js';
import {
  secretsAllowlistSchema,
  type AllowlistEntry,
  type SecretsAllowlist,
} from '../../schemas/secretsAllowlist.schema.js';
import type { SecretMatch, FileScanResult, ScanSummary } from './scanner.js';

const ALLOWLIST_FILENAME = 'secrets.allow.json';

// ============================================================================
// Path + fingerprint helpers
// ============================================================================

/** Path to the committed allowlist file inside the tuck repo. */
export const getAllowlistPath = (tuckDir: string): string => {
  return join(tuckDir, ALLOWLIST_FILENAME);
};

/**
 * Deterministic, non-reversible fingerprint of a secret value.
 *
 * SECURITY: we hash the raw value with SHA-256 so the committed allowlist never
 * contains the plaintext. Matching later re-hashes the scanned value and
 * compares digests.
 */
export const computeFingerprint = (value: string): string => {
  return createHash('sha256').update(value, 'utf8').digest('hex');
};

// ============================================================================
// Store operations
// ============================================================================

/** Load the allowlist, returning an empty store when the file is absent. */
export const loadAllowlist = async (tuckDir: string): Promise<SecretsAllowlist> => {
  const allowlistPath = getAllowlistPath(tuckDir);

  if (!(await pathExists(allowlistPath))) {
    return { version: '1.0.0', entries: [] };
  }

  try {
    const content = await readFile(allowlistPath, 'utf-8');
    const parsed = JSON.parse(content);
    return secretsAllowlistSchema.parse(parsed);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // A corrupt allowlist must NOT silently disable the scanner (that would let
    // real secrets through). Surface a clear, actionable failure instead.
    throw new Error(
      `[tuck] Failed to load secret allowlist from '${allowlistPath}': ${errorMsg}`
    );
  }
};

/** Persist the allowlist atomically (committed file — default permissions). */
export const saveAllowlist = async (
  tuckDir: string,
  store: SecretsAllowlist
): Promise<void> => {
  const allowlistPath = getAllowlistPath(tuckDir);
  await ensureDir(tuckDir);
  const content = JSON.stringify(store, null, 2) + '\n';
  await atomicWriteFile(allowlistPath, content);
};

// ============================================================================
// CRUD
// ============================================================================

export interface AddAllowlistOptions {
  /** Justification for why this value is safe (required, keeps it auditable). */
  reason: string;
  /** Optional pattern id scope. */
  pattern?: string;
  /** Optional collapsed path scope. */
  path?: string;
  /** Override the recorded actor (defaults to $USER/$USERNAME). */
  addedBy?: string;
}

/**
 * Add (or update) an allowlist entry keyed by fingerprint + optional scope.
 *
 * If an entry with the same fingerprint, pattern, and path already exists its
 * reason/actor/timestamp are refreshed rather than duplicated. Returns the
 * stored entry.
 */
export const addAllowlistEntryByFingerprint = async (
  tuckDir: string,
  fingerprint: string,
  options: AddAllowlistOptions
): Promise<AllowlistEntry> => {
  const store = await loadAllowlist(tuckDir);

  const entry: AllowlistEntry = {
    fingerprint,
    reason: options.reason,
    ...(options.pattern ? { pattern: options.pattern } : {}),
    ...(options.path ? { path: options.path } : {}),
    addedBy: options.addedBy ?? process.env.USER ?? process.env.USERNAME,
    addedAt: new Date().toISOString(),
  };

  const idx = store.entries.findIndex(
    (existing) =>
      existing.fingerprint === entry.fingerprint &&
      existing.pattern === entry.pattern &&
      existing.path === entry.path
  );

  if (idx >= 0) {
    store.entries[idx] = entry;
  } else {
    store.entries.push(entry);
  }

  await saveAllowlist(tuckDir, store);
  return entry;
};

/**
 * Add an allowlist entry for a raw value. The value is fingerprinted before
 * storage and is never written to disk in cleartext.
 */
export const addAllowlistEntryForValue = async (
  tuckDir: string,
  value: string,
  options: AddAllowlistOptions
): Promise<AllowlistEntry> => {
  return addAllowlistEntryByFingerprint(tuckDir, computeFingerprint(value), options);
};

/**
 * Remove all entries whose fingerprint starts with the given prefix (allowing
 * short prefixes on the CLI). Returns the entries that were removed.
 */
export const removeAllowlistEntries = async (
  tuckDir: string,
  fingerprintPrefix: string
): Promise<AllowlistEntry[]> => {
  const store = await loadAllowlist(tuckDir);
  const prefix = fingerprintPrefix.toLowerCase();
  const removed = store.entries.filter((entry) => entry.fingerprint.startsWith(prefix));

  if (removed.length === 0) {
    return [];
  }

  store.entries = store.entries.filter((entry) => !entry.fingerprint.startsWith(prefix));
  await saveAllowlist(tuckDir, store);
  return removed;
};

/** List all allowlist entries. */
export const listAllowlistEntries = async (tuckDir: string): Promise<AllowlistEntry[]> => {
  const store = await loadAllowlist(tuckDir);
  return store.entries;
};

// ============================================================================
// Matching + filtering
// ============================================================================

/**
 * True when a scanner match is suppressed by any allowlist entry.
 *
 * An entry matches when its fingerprint equals SHA-256(match.value) AND every
 * scope it declares also matches: `pattern` (against match.patternId) and
 * `path` (against the file's collapsed path).
 */
export const isMatchAllowed = (
  match: Pick<SecretMatch, 'value' | 'patternId'>,
  collapsedPath: string,
  entries: AllowlistEntry[]
): boolean => {
  if (entries.length === 0) return false;
  const fingerprint = computeFingerprint(match.value);

  return entries.some((entry) => {
    if (entry.fingerprint !== fingerprint) return false;
    if (entry.pattern !== undefined && entry.pattern !== match.patternId) return false;
    if (entry.path !== undefined && entry.path !== collapsedPath) return false;
    return true;
  });
};

/**
 * Return a new ScanSummary with allowlisted matches removed and all aggregate
 * counts recomputed. Files whose matches are all allowlisted drop out entirely.
 */
export const filterSummaryWithAllowlist = (
  summary: ScanSummary,
  entries: AllowlistEntry[]
): ScanSummary => {
  if (entries.length === 0) return summary;

  const filteredResults: FileScanResult[] = [];

  for (const result of summary.results) {
    const keptMatches = result.matches.filter(
      (match) => !isMatchAllowed(match, result.collapsedPath, entries)
    );

    if (keptMatches.length === 0) continue;

    filteredResults.push({
      ...result,
      matches: keptMatches,
      hasSecrets: true,
      criticalCount: keptMatches.filter((m) => m.severity === 'critical').length,
      highCount: keptMatches.filter((m) => m.severity === 'high').length,
      mediumCount: keptMatches.filter((m) => m.severity === 'medium').length,
      lowCount: keptMatches.filter((m) => m.severity === 'low').length,
    });
  }

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalSecrets = 0;
  for (const result of filteredResults) {
    totalSecrets += result.matches.length;
    bySeverity.critical += result.criticalCount;
    bySeverity.high += result.highCount;
    bySeverity.medium += result.mediumCount;
    bySeverity.low += result.lowCount;
  }

  // `scannedFiles`/`skippedFiles`/`totalFiles` describe the scan itself and are
  // unchanged by allowlisting; only the secret-bearing view narrows.
  return {
    ...summary,
    filesWithSecrets: filteredResults.length,
    totalSecrets,
    bySeverity,
    results: filteredResults,
  };
};
