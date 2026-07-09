import { basename } from 'path';
import { sortJsonKeys } from './jsonKey.js';
import type {
  arrayMergeStrategySchema,
  conflictResolutionSchema,
  mergePolicySchema,
} from '../schemas/manifest.schema.js';
import type { z } from 'zod';

/**
 * Structured three-way JSON merge.
 *
 * This module is intentionally **pure** — no filesystem, no git, no logging —
 * so it is trivially unit-testable and safe to reuse from `tuck sync`,
 * `tuck apply`, or the MCP server. The filesystem/git orchestration lives in
 * the callers (see {@link file:./jsonMergeSync.ts}).
 *
 * The classic merge problem: an agent tool (Claude Code, etc.) rewrites its own
 * JSON config on two machines. Naive push/pull captures whichever side synced
 * last and silently drops the other side's edits. A three-way merge with the
 * last-synced version as the common ancestor recovers BOTH sides' changes and
 * only surfaces a genuine conflict when the same leaf was changed two different
 * ways.
 */

export type ArrayMergeStrategy = z.infer<typeof arrayMergeStrategySchema>;
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;
export type MergePolicy = z.infer<typeof mergePolicySchema>;

/** The default policy applied to auto-detected agent config files. */
export const DEFAULT_JSON_MERGE_POLICY: MergePolicy = {
  format: 'json',
  arrays: 'union',
  conflict: 'manual',
};

/**
 * A JSON value. We deliberately avoid `any`: everything flowing through the
 * merge is a well-typed JSON node.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Sentinel meaning "this key does not exist on this side". Distinguishing
 * absence from an explicit `null`/`undefined` value is what lets the merge tell
 * a deletion apart from a value change.
 */
const MISSING = Symbol('tuck.jsonMerge.MISSING');
type Missing = typeof MISSING;
type Slot = JsonValue | Missing;

/** A single unresolved conflict, addressed by a dotted/bracketed JSON path. */
export interface JsonMergeConflict {
  /** Human-readable path to the conflicting node, e.g. `permissions.allow` or `env.TOKEN`. */
  path: string;
  /** The local (ours) value, or `undefined` when the key was deleted locally. */
  ours: JsonValue | undefined;
  /** The incoming (theirs) value, or `undefined` when the key was deleted remotely. */
  theirs: JsonValue | undefined;
  /** The common-ancestor value, or `undefined` when the key did not exist in the base. */
  base: JsonValue | undefined;
  /** Short description of why this could not be auto-merged. */
  reason: string;
}

/** Result of merging parsed JSON values. */
export interface JsonMergeResult {
  merged: JsonValue;
  conflicts: JsonMergeConflict[];
}

/** Result of merging JSON *text* (parse → merge → serialize). */
export interface JsonTextMergeResult {
  /** Serialized merged JSON (indentation inferred from `ours`), or null on hard failure. */
  text: string | null;
  conflicts: JsonMergeConflict[];
  /** True when a side could not be parsed as JSON — smart merge is impossible. */
  unparsable: boolean;
}

const isPlainObject = (value: Slot): value is { [key: string]: JsonValue } =>
  value !== MISSING &&
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value);

const isArray = (value: Slot): value is JsonValue[] =>
  value !== MISSING && Array.isArray(value);

/**
 * Canonical, order-independent serialization used for deep equality and for
 * array de-duplication. Object keys are sorted so `{a:1,b:2}` and `{b:2,a:1}`
 * hash identically; array order is preserved (arrays are ordered values).
 *
 * Derived from the shared {@link sortJsonKeys} deep key-sort (same primitive
 * behind jsonKey's `canonicalJson`) so the two canonical serializers cannot
 * drift: `canonicalize(v)` is exactly `JSON.stringify` over a recursively
 * key-sorted `v`. `sortJsonKeys` uses a null-prototype result object, so an own
 * `__proto__` data key survives here just as it did in the previous hand-rolled
 * recursion.
 */
export const canonicalize = (value: JsonValue): string =>
  JSON.stringify(sortJsonKeys(value));

/** Deep structural equality via canonical serialization. */
const deepEqual = (a: Slot, b: Slot): boolean => {
  if (a === MISSING || b === MISSING) return a === b;
  return canonicalize(a) === canonicalize(b);
};

const asValue = (slot: Slot): JsonValue | undefined => (slot === MISSING ? undefined : slot);

/**
 * Merge two arrays that have both diverged from their common ancestor.
 * `replace` is handled by the caller (it degrades to a scalar conflict).
 *
 * `union` is **base-aware**: an item present in `base` but dropped by one side
 * was deliberately deleted, and that deletion is honored even if the other side
 * still carries it (e.g. a locally-revoked `permissions.allow` entry is not
 * silently re-granted just because the incoming copy still lists it). Concretely
 * an item is kept iff either:
 *   - it is a genuine addition — absent from `base` and present on at least one
 *     side (unioned), or
 *   - it survived on **both** sides — present in `base`, `ours`, and `theirs`.
 * An item in `base` that is missing from either side is treated as deleted.
 *
 * Because union arrays have no element identity beyond canonical value equality,
 * a "modification" of a base item reads as delete-old + add-new: the old value
 * (gone from both sides) drops out and the new value (absent from base) is added.
 * Ordering is stable — `ours` order first, then new `theirs` additions.
 */
const mergeArrays = (
  base: Slot,
  ours: JsonValue[],
  theirs: JsonValue[],
  strategy: ArrayMergeStrategy
): JsonValue[] => {
  if (strategy === 'concat') {
    return [...ours, ...theirs];
  }
  // union: three-way set merge keyed by canonical value.
  const baseKeys = new Set<string>(
    (isArray(base) ? base : []).map(canonicalize)
  );
  const oursKeys = new Set<string>(ours.map(canonicalize));
  const theirsKeys = new Set<string>(theirs.map(canonicalize));

  const keep = (key: string): boolean =>
    baseKeys.has(key)
      ? // Present in base: retained only if neither side deleted it.
        oursKeys.has(key) && theirsKeys.has(key)
      : // Absent from base: a genuine addition from whichever side has it.
        true;

  const emitted = new Set<string>();
  const result: JsonValue[] = [];
  for (const item of [...ours, ...theirs]) {
    const key = canonicalize(item);
    if (emitted.has(key)) continue;
    if (!keep(key)) continue;
    emitted.add(key);
    result.push(item);
  }
  return result;
};

/**
 * Recursively merge one slot from each side, given the common-ancestor slot.
 * Pushes any unresolved conflicts onto `conflicts` (addressed by `path`).
 */
const mergeSlot = (
  base: Slot,
  ours: Slot,
  theirs: Slot,
  policy: MergePolicy,
  path: string,
  conflicts: JsonMergeConflict[]
): Slot => {
  // Fast paths: no divergence to reconcile.
  if (deepEqual(ours, theirs)) return ours; // both sides identical
  if (deepEqual(ours, base)) return theirs; // only theirs changed → take theirs
  if (deepEqual(theirs, base)) return ours; // only ours changed → keep ours

  // Both sides changed, differently. Recurse structurally when shapes align.
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    return mergeObjects(base, ours, theirs, policy, path, conflicts);
  }

  if (isArray(ours) && isArray(theirs) && policy.arrays !== 'replace') {
    return mergeArrays(base, ours, theirs, policy.arrays);
  }

  // Irreconcilable leaf (scalar/type mismatch, or array under `replace`).
  return resolveConflict(base, ours, theirs, policy, path, conflicts);
};

const mergeObjects = (
  base: Slot,
  ours: { [key: string]: JsonValue },
  theirs: { [key: string]: JsonValue },
  policy: MergePolicy,
  path: string,
  conflicts: JsonMergeConflict[]
): { [key: string]: JsonValue } => {
  const baseObj = isPlainObject(base) ? base : undefined;
  // Null-prototype result so a merged "__proto__" key is stored as a plain own
  // data property instead of tripping the Object.prototype setter (which would
  // hijack the prototype and drop the key from serialization). JSON.stringify
  // still serializes every own enumerable key, "__proto__" included.
  const result: { [key: string]: JsonValue } = Object.create(null) as {
    [key: string]: JsonValue;
  };

  // Object.hasOwn (never the inherited `in`) so keys shadowing Object.prototype
  // members — toString, constructor, valueOf, hasOwnProperty, __proto__ — are
  // classified by their real presence and never silently dropped.
  const keys = new Set<string>([...Object.keys(ours), ...Object.keys(theirs)]);
  // Iterate ours-first, then theirs-only keys, for stable, intuitive ordering.
  const orderedKeys = [
    ...Object.keys(ours),
    ...Object.keys(theirs).filter((k) => !Object.hasOwn(ours, k)),
  ];

  for (const key of orderedKeys) {
    if (!keys.has(key)) continue;
    keys.delete(key);

    const childPath = path ? `${path}.${key}` : key;
    const ourSlot: Slot = Object.hasOwn(ours, key) ? ours[key] : MISSING;
    const theirSlot: Slot = Object.hasOwn(theirs, key) ? theirs[key] : MISSING;
    const baseSlot: Slot = baseObj && Object.hasOwn(baseObj, key) ? baseObj[key] : MISSING;

    const merged = mergeSlot(baseSlot, ourSlot, theirSlot, policy, childPath, conflicts);
    if (merged !== MISSING) {
      result[key] = merged;
    }
  }

  return result;
};

/**
 * Resolve an irreconcilable slot per the policy. `manual` records a conflict
 * and leaves `ours` in place so the serialized file stays valid JSON; the
 * caller decides whether to block on recorded conflicts.
 */
const resolveConflict = (
  base: Slot,
  ours: Slot,
  theirs: Slot,
  policy: MergePolicy,
  path: string,
  conflicts: JsonMergeConflict[]
): Slot => {
  if (policy.conflict === 'ours') return ours;
  if (policy.conflict === 'theirs') return theirs;

  conflicts.push({
    path,
    ours: asValue(ours),
    theirs: asValue(theirs),
    base: asValue(base),
    reason:
      ours === MISSING
        ? 'deleted locally but modified in the incoming copy'
        : theirs === MISSING
          ? 'modified locally but deleted in the incoming copy'
          : 'changed to different values on both sides',
  });
  // Keep a valid document: prefer ours, or theirs if ours was deleted.
  return ours === MISSING ? theirs : ours;
};

/**
 * Three-way merge of already-parsed JSON values.
 *
 * @param base   Common ancestor (the last-synced version).
 * @param ours   Local value.
 * @param theirs Incoming value.
 */
export const mergeJsonValues = (
  base: JsonValue,
  ours: JsonValue,
  theirs: JsonValue,
  policy: MergePolicy = DEFAULT_JSON_MERGE_POLICY
): JsonMergeResult => {
  const conflicts: JsonMergeConflict[] = [];
  const merged = mergeSlot(base, ours, theirs, policy, '', conflicts);
  // The top-level slot is always present (callers pass real values, not MISSING).
  return { merged: merged === MISSING ? null : merged, conflicts };
};

/**
 * Detect the indentation used by a JSON document so the merged output matches
 * the local file's style. Defaults to two spaces.
 */
export const detectJsonIndent = (text: string): number | string => {
  const match = text.match(/^\{\s*\n(\s+)/);
  if (match) {
    const ws = match[1].replace(/\n/g, '');
    if (ws.includes('\t')) return '\t';
    if (ws.length > 0) return ws.length;
  }
  return 2;
};

const tryParse = (text: string): { ok: true; value: JsonValue } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
};

/**
 * Three-way merge of JSON *text*. Parses each side, merges structurally, and
 * re-serializes using the indentation inferred from `oursText`. When any side
 * is not valid JSON the merge is impossible and `unparsable` is set so the
 * caller can fall back to git's textual conflict handling.
 */
export const threeWayMergeJsonText = (
  baseText: string,
  oursText: string,
  theirsText: string,
  policy: MergePolicy = DEFAULT_JSON_MERGE_POLICY
): JsonTextMergeResult => {
  const base = tryParse(baseText);
  const ours = tryParse(oursText);
  const theirs = tryParse(theirsText);

  if (!base.ok || !ours.ok || !theirs.ok) {
    return { text: null, conflicts: [], unparsable: true };
  }

  const { merged, conflicts } = mergeJsonValues(base.value, ours.value, theirs.value, policy);
  const indent = detectJsonIndent(oursText);
  const serialized = JSON.stringify(merged, null, indent);
  // Preserve a trailing newline when the local file had one (POSIX convention).
  const text = oursText.endsWith('\n') ? `${serialized}\n` : serialized;
  return { text, conflicts, unparsable: false };
};

/**
 * Filenames (basename) that get a structured JSON merge policy automatically,
 * even when the manifest carries no explicit policy. These are the high-churn,
 * agent-rewritten configs the feature targets. Everything else is opt-in via
 * `tuck merge set`.
 */
const AGENT_JSON_FILENAMES = new Set<string>([
  'settings.json', // Claude Code / VS Code settings
  'settings.local.json', // Claude Code local overrides
  '.mcp.json', // Model Context Protocol servers
  'mcp.json',
  '.claude.json',
]);

/**
 * Resolve the effective merge policy for a tracked file. An explicit manifest
 * policy always wins; otherwise a curated allowlist of agent config filenames
 * gets the safe union default. Returns null when the file should use plain
 * copy semantics (the default for everything else).
 */
export const resolveMergePolicy = (
  source: string,
  manifestPolicy?: MergePolicy
): MergePolicy | null => {
  if (manifestPolicy) return manifestPolicy;
  const name = basename(source);
  if (AGENT_JSON_FILENAMES.has(name)) {
    return DEFAULT_JSON_MERGE_POLICY;
  }
  return null;
};

/** True when the file has a structured merge policy (explicit or auto-detected). */
export const hasMergePolicy = (source: string, manifestPolicy?: MergePolicy): boolean =>
  resolveMergePolicy(source, manifestPolicy) !== null;
