import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { pathExists } from './paths.js';
import { getStateDir } from './state.js';
import {
  threeWayMergeJsonText,
  hasMergePolicy,
  type JsonMergeConflict,
  type MergePolicy,
} from './jsonMerge.js';
import type { TrackedFileOutput } from '../schemas/manifest.schema.js';

/**
 * Sync-time orchestration for {@link file:./jsonMerge.ts}. Everything that
 * touches the filesystem lives here; the pure merge math stays in jsonMerge.ts.
 *
 * The flow `tuck sync` drives:
 *   1. BEFORE pulling, snapshot the repo copy of every merge-policy file. That
 *      copy equals the local machine's last-synced state, so it is the correct
 *      common ancestor ({@link captureMergeBases}).
 *   2. Pull. Git may advance the repo copy to the remote's version.
 *   3. For each locally-modified policy file, three-way merge
 *      base(pre-pull repo) × local(live file) × remote(post-pull repo) and
 *      decide what to write ({@link decideFileMerge}).
 */

/** Per-file merge decision produced by {@link decideFileMerge}. */
export type MergeDecision =
  /** Remote did not change this file — nothing to reconcile; normal copy applies. */
  | { kind: 'skip' }
  /** A side is not valid JSON — smart merge impossible; caller falls back to overwrite. */
  | { kind: 'unparsable' }
  /** Merged cleanly; `text` is the reconciled document to write to live + repo. */
  | { kind: 'clean'; text: string }
  /** Merged but with unresolved conflicts; `text` keeps the document valid. */
  | { kind: 'conflict'; text: string; conflicts: JsonMergeConflict[] };

/**
 * Read the repo copy of every merge-policy tracked file. Call this BEFORE a
 * pull so the captured contents are the common ancestor for the three-way
 * merge. Keyed by the manifest `source` identity. Template/encrypted files are
 * one-directional and never merged, so they are skipped.
 */
export const captureMergeBases = async (
  tuckDir: string,
  files: Record<string, TrackedFileOutput>
): Promise<Map<string, string>> => {
  const bases = new Map<string, string>();
  for (const file of Object.values(files)) {
    if (file.template || file.encrypted) continue;
    if (!hasMergePolicy(file.source, file.merge)) continue;
    const destPath = join(tuckDir, file.destination);
    if (await pathExists(destPath)) {
      try {
        bases.set(file.source, await readFile(destPath, 'utf-8'));
      } catch {
        // Unreadable base → we simply can't three-way merge this file; the
        // caller treats a missing base as "skip" and falls back to plain copy.
      }
    }
  }
  return bases;
};

/**
 * Decide how a single tracked file reconciles, given its three versions.
 *
 * Pure and fully deterministic — this is the unit-testable heart of the
 * sync-time merge.
 *
 * @param baseText   Repo copy captured before pull (common ancestor).
 * @param liveText   Current live file on this machine (ours).
 * @param remoteText Repo copy after pull (theirs).
 */
export const decideFileMerge = (
  baseText: string,
  liveText: string,
  remoteText: string,
  policy: MergePolicy
): MergeDecision => {
  // Remote is byte-identical to the ancestor → the pull brought no change to
  // this file, so there is nothing to merge. The normal live→repo copy will
  // faithfully capture the local edits.
  if (remoteText === baseText) {
    return { kind: 'skip' };
  }

  const result = threeWayMergeJsonText(baseText, liveText, remoteText, policy);
  if (result.unparsable || result.text === null) {
    return { kind: 'unparsable' };
  }
  if (result.conflicts.length === 0) {
    return { kind: 'clean', text: result.text };
  }
  return { kind: 'conflict', text: result.text, conflicts: result.conflicts };
};

// ============================================================================
// Pending merge-base persistence (abort recovery)
// ============================================================================

/**
 * The merge base normally exists only in memory during the sync run that
 * pulled. If the user aborts on a surfaced conflict, the next sync would find
 * the branch no longer behind, capture no bases, and silently commit local
 * values over the remote's. To keep the conflict recoverable, an aborted run
 * persists its bases to the machine-local state dir and the next sync seeds
 * from them (freshly-pulled bases always win). Cleared after a run that
 * reconciles successfully.
 */
const PENDING_MERGE_BASES_FILE = 'pending-json-merge-bases.json';

export const getPendingMergeBasesPath = (): string =>
  join(getStateDir(), PENDING_MERGE_BASES_FILE);

export const persistPendingMergeBases = async (bases: Map<string, string>): Promise<void> => {
  if (bases.size === 0) return;
  const path = getPendingMergeBasesPath();
  await mkdir(getStateDir(), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ version: 1, bases: Object.fromEntries(bases) }, null, 2) + '\n',
    'utf-8'
  );
};

export const loadPendingMergeBases = async (): Promise<Map<string, string>> => {
  const path = getPendingMergeBasesPath();
  if (!(await pathExists(path))) return new Map();
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('bases' in parsed) ||
      typeof (parsed as { bases: unknown }).bases !== 'object' ||
      (parsed as { bases: unknown }).bases === null
    ) {
      return new Map();
    }
    const entries = Object.entries((parsed as { bases: Record<string, unknown> }).bases).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    );
    return new Map(entries);
  } catch {
    // Corrupt state must never block a sync; the worst case is the pre-fix
    // behavior (no recovered base).
    return new Map();
  }
};

export const clearPendingMergeBases = async (): Promise<void> => {
  await rm(getPendingMergeBasesPath(), { force: true });
};
