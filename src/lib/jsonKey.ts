/**
 * JSON-path-scoped tracking primitives.
 *
 * tuck can track a *subtree* of a JSON file rather than the whole file:
 * `tuck add ~/.claude.json --key mcpServers` extracts only the `mcpServers`
 * value into the repo copy, and on apply/restore that subtree is deep-merged
 * back into the live file — leaving every other key (machine state, OAuth
 * tokens, session caches, conversation history) untouched.
 *
 * This module is the pure, dependency-free core of that behavior:
 *   - {@link extractSubtree}       live file text → canonical JSON of the subtree
 *     (what lands in the repo)
 *   - {@link mergeSubtreeIntoLive} repo subtree + live file text → full live file
 *     text with the subtree deep-merged back in
 *   - {@link deepMergeJson}        the recursive object merge both rely on
 *
 * All extraction is serialized with sorted keys ({@link canonicalJson}) so the
 * repo copy — and therefore its checksum — is stable regardless of the live
 * file's key order or whitespace. That lets status/sync detect real subtree
 * drift by comparing checksums, exactly like the rest of tuck's state model.
 *
 * v1 scope (documented limitations):
 *   - Strict JSON only. Files with comments/trailing commas (JSONC, e.g. some
 *     VS Code settings.json) are rejected rather than silently corrupted.
 *   - Key paths address object properties via dots (`a.b.c`). Array indices are
 *     not addressable; the leaf VALUE may be any JSON type (object/array/scalar).
 */

import { JsonKeyError } from '../errors.js';

/** A JSON value with no functions/undefined — what `JSON.parse` yields. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** True for a non-null, non-array plain object (the only mergeable/navigable shape). */
export const isPlainObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Split a dot-delimited key path into its segments, rejecting empty input and
 * empty segments (`a..b`, leading/trailing dots) so a malformed path fails
 * loudly at parse time rather than silently matching nothing.
 */
export const parseJsonKeyPath = (key: string): string[] => {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new JsonKeyError('A JSON key path is required (e.g. --key mcpServers)');
  }
  const segments = key.split('.');
  if (segments.some((segment) => segment === '')) {
    throw new JsonKeyError(
      `Invalid JSON key path "${key}": segments must be non-empty (no leading, trailing, or doubled dots)`
    );
  }
  // Prototype-named segments would match inherited properties during
  // navigation ('constructor' "exists" on every object) and writing to
  // __proto__ mutates Object.prototype — reject them outright.
  const dangerous = segments.find((segment) =>
    ['__proto__', 'prototype', 'constructor'].includes(segment)
  );
  if (dangerous !== undefined) {
    throw new JsonKeyError(
      `Invalid JSON key path "${key}": "${dangerous}" is a reserved property name`
    );
  }
  return segments;
};

/** Recursively sort object keys so serialization is deterministic. */
const sortValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortValue(value[k]);
    }
    return out;
  }
  return value;
};

/**
 * Serialize a JSON value canonically: keys sorted, 2-space indented, trailing
 * newline. Used for the repo copy of a subtree so its bytes (and checksum) are
 * identical for identical content regardless of the source file's ordering.
 */
export const canonicalJson = (value: JsonValue): string =>
  `${JSON.stringify(sortValue(value), null, 2)}\n`;

/** Parse text as strict JSON, raising a {@link JsonKeyError} with context on failure. */
const parseJsonOrThrow = (content: string, label: string): JsonValue => {
  try {
    return JSON.parse(content) as JsonValue;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new JsonKeyError(`${label} is not valid JSON: ${reason}`);
  }
};

/**
 * Navigate `root` along `segments`. Intermediate nodes must be plain objects;
 * the leaf value may be any JSON type. Returns `{ found: false }` if any segment
 * is missing or an intermediate node is not an object.
 */
const getValueAtPath = (
  root: JsonValue,
  segments: string[]
): { found: true; value: JsonValue } | { found: false } => {
  let current: JsonValue = root;
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
};

/**
 * Deep-merge `patch` onto `base`. When BOTH are plain objects the merge is
 * recursive and key-wise (base keys absent from patch are preserved); otherwise
 * `patch` replaces `base` wholesale. Arrays are treated as opaque values and
 * replaced, never element-merged (element identity is undefined for config
 * arrays, so a union/index-merge would corrupt them).
 */
export const deepMergeJson = (base: JsonValue, patch: JsonValue): JsonValue => {
  if (isPlainObject(base) && isPlainObject(patch)) {
    // Null-prototype accumulator: a legitimate "__proto__" data key parsed
    // from JSON must never hit Object.prototype through plain assignment.
    const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(base)) {
      out[key] = base[key];
    }
    for (const key of Object.keys(patch)) {
      out[key] = Object.prototype.hasOwnProperty.call(base, key)
        ? deepMergeJson(base[key], patch[key])
        : patch[key];
    }
    return out;
  }
  return patch;
};

/**
 * Return a copy of `obj` with `value` REPLACING whatever sits at `segments`,
 * creating intermediate objects as needed. Everything OUTSIDE the tracked path
 * is preserved; everything AT the path is tuck-managed by definition, so the
 * repo subtree replaces it wholesale — a deep-merge here would resurrect keys
 * deleted from the repo copy on every apply (and the next sync would capture
 * the resurrected key back into the repo, reverting the deletion globally).
 */
const mergeAtPath = (
  obj: Record<string, JsonValue>,
  segments: string[],
  value: JsonValue
): Record<string, JsonValue> => {
  const [head, ...rest] = segments;
  const clone: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(obj)) {
    clone[key] = obj[key];
  }
  if (rest.length === 0) {
    clone[head] = value;
  } else {
    const existing: JsonValue | undefined = Object.prototype.hasOwnProperty.call(clone, head)
      ? clone[head]
      : undefined;
    const child = isPlainObject(existing) ? existing : {};
    clone[head] = mergeAtPath(child, rest, value);
  }
  return clone;
};

/**
 * Extract the subtree at `key` from a JSON file's text and return it as
 * canonical JSON (the exact bytes stored as the repo copy).
 *
 * @throws {@link JsonKeyError} when the content is not a JSON object, the key
 *   path is malformed, or the key path is not present.
 */
export const extractSubtree = (content: string, key: string): string => {
  const parsed = parseJsonOrThrow(content, 'File');
  if (!isPlainObject(parsed)) {
    throw new JsonKeyError('JSON-key tracking requires a top-level JSON object');
  }
  const segments = parseJsonKeyPath(key);
  const result = getValueAtPath(parsed, segments);
  if (!result.found) {
    throw new JsonKeyError(`Key path "${key}" was not found in the file`);
  }
  return canonicalJson(result.value);
};

/**
 * True when `content` is a JSON object that contains the given key path. Used
 * for non-throwing drift checks (sync/status) where an absent key means "the
 * tracked subtree is missing from the live file", not an error.
 */
export const hasSubtree = (content: string, key: string): boolean => {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(content) as JsonValue;
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  let segments: string[];
  try {
    segments = parseJsonKeyPath(key);
  } catch {
    return false;
  }
  return getValueAtPath(parsed, segments).found;
};

/**
 * Write a repo-stored subtree back into a live file's text at `key`, returning
 * the full updated file text (2-space indented, trailing newline).
 *
 * Every key outside the tracked path is preserved byte-for-value; the value AT
 * the tracked path is REPLACED by the repo subtree (it is tuck-managed by
 * definition — replacing is what lets deletions inside the subtree propagate
 * across machines). When the live file is absent/empty the result is a new
 * object holding just the subtree.
 *
 * @throws {@link JsonKeyError} when the repo subtree or a non-empty live file is
 *   not valid JSON, or the live top level is not a JSON object.
 */
export const mergeSubtreeIntoLive = (
  liveContent: string | null,
  repoSubtree: string,
  key: string
): string => {
  const subtreeValue = parseJsonOrThrow(repoSubtree, 'Repo subtree');
  const segments = parseJsonKeyPath(key);

  let live: JsonValue;
  if (liveContent === null || liveContent.trim() === '') {
    live = {};
  } else {
    live = parseJsonOrThrow(liveContent, 'Live file');
  }
  if (!isPlainObject(live)) {
    throw new JsonKeyError('JSON-key tracking requires the live file to be a JSON object');
  }

  const merged = mergeAtPath(live, segments, subtreeValue);
  return `${JSON.stringify(merged, null, 2)}\n`;
};
