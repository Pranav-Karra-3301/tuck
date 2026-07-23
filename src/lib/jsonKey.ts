/**
 * JSON-path-scoped tracking primitives.
 *
 * tuck can track a *subtree* of a JSON file rather than the whole file:
 * `tuck add ~/.claude.json --key mcpServers` extracts only the `mcpServers`
 * value into the repo copy, and on apply/restore that subtree is written back
 * into the live file at that exact path — leaving every other key (machine
 * state, OAuth tokens, session caches, conversation history) untouched.
 *
 * This module is the pure, dependency-free core of that behavior:
 *   - {@link extractSubtree}       live file text → canonical JSON of the subtree
 *     (what lands in the repo)
 *   - {@link mergeSubtreeIntoLive} repo subtree + live file text → full live file
 *     text with the subtree REPLACED at the tracked path (a span-splice that
 *     rewrites ONLY the tracked value's byte range, so every other byte — big
 *     integers, key order, indentation, trailing whitespace — is preserved
 *     verbatim)
 *
 * Extraction is serialized with sorted keys ({@link canonicalJson}) so the repo
 * copy — and therefore its checksum — is stable regardless of the live file's
 * key order or whitespace. That lets status/sync detect real subtree drift by
 * comparing checksums, exactly like the rest of tuck's state model.
 *
 * WHY replace-at-path and not deep-merge: everything AT the tracked path is
 * tuck-managed by definition. A deep-merge would resurrect keys the user
 * deleted from the repo copy on every apply, and the next sync would recapture
 * the resurrected key — reverting the deletion globally. So the tracked value is
 * replaced wholesale while everything outside it is left byte-for-byte intact.
 *
 * Key paths address object properties via dots (`a.b.c`); a literal dot inside a
 * single key name is escaped with a backslash (`--key 'servers.github\.copilot'`
 * addresses `servers` → `github.copilot`). Array indices are not addressable;
 * the leaf VALUE may be any JSON type (object/array/scalar).
 *
 * v1 scope (documented limitations):
 *   - Strict JSON only. Files with comments/trailing commas (JSONC, e.g. some
 *     VS Code settings.json) are rejected rather than silently corrupted.
 */

import { createHash } from 'node:crypto';

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
 * Split a dot-delimited key path into its (unescaped) segments.
 *
 * Dots separate segments; a backslash escapes the following character so a key
 * name that itself contains a dot is addressable: `servers.github\.copilot`
 * yields `['servers', 'github.copilot']`. `\\` produces a literal backslash; a
 * backslash before any other character is preserved literally.
 *
 * Empty input and empty segments (`a..b`, leading/trailing dots) are rejected so
 * a malformed path fails loudly at parse time rather than silently matching
 * nothing. The prototype-pollution guard is applied to the UNESCAPED segment
 * names (the actual property names that will be navigated/created).
 */
export const parseJsonKeyPath = (key: string): string[] => {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new JsonKeyError('A JSON key path is required (e.g. --key mcpServers)');
  }

  // Split on UNESCAPED dots only, unescaping `\.`/`\\` as we go.
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (ch === '\\') {
      const next = key[i + 1];
      if (next === '.' || next === '\\') {
        current += next;
        i++;
        continue;
      }
      // Lone backslash (not escaping a dot/backslash): keep it literally.
      current += ch;
      continue;
    }
    if (ch === '.') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  if (segments.some((segment) => segment === '')) {
    throw new JsonKeyError(
      `Invalid JSON key path "${key}": segments must be non-empty (no leading, trailing, or doubled dots)`
    );
  }
  // Prototype-named segments would match inherited properties during navigation
  // ('constructor' "exists" on every object) and writing to __proto__ mutates
  // Object.prototype — reject them outright. Checked on the UNESCAPED names.
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

/**
 * Recursively sort object keys so serialization is deterministic. The shared
 * deep key-sort primitive: `canonicalJson` (here) and `canonicalize` in
 * jsonMerge.ts both derive from it, so the two canonical serializers can never
 * drift apart.
 *
 * The result object is created with a `null` prototype so a literal `__proto__`
 * data key (which `JSON.parse` yields as an OWN property) is stored as a plain
 * own property instead of hijacking the prototype slot — this is what keeps
 * `JSON.stringify(sortJsonKeys(v))` byte-identical to the hand-written
 * `canonicalize(v)` (which reads own keys directly), including for `__proto__`.
 */
export const sortJsonKeys = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (isPlainObject(value)) {
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const k of Object.keys(value).sort()) {
      out[k] = sortJsonKeys(value[k]);
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
  `${JSON.stringify(sortJsonKeys(value), null, 2)}\n`;

/**
 * The single SHA-256 checksum of a tracked JSON subtree's canonical text. Change
 * detection (sync), status, and verify must all hash an extracted subtree the
 * SAME way for their checksums to agree, so the algorithm lives here in exactly
 * one place. Hashes the UTF-8 bytes of `text` (equivalent to, and replacing, the
 * former `Buffer.from(text, 'utf8')` wrapper).
 */
export const hashSubtree = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

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

// ---------------------------------------------------------------------------
// Span-splice write-back
//
// mergeSubtreeIntoLive must preserve every byte OUTSIDE the tracked path exactly
// — round-tripping the whole file through JSON.parse/JSON.stringify would corrupt
// large integers (1234567890123456789 → …800), reorder integer-like keys, and
// normalize indentation. So instead of re-serializing the whole object, we
// tokenize the live JSON text to find the byte range of the value at the tracked
// path and replace ONLY that range.
// ---------------------------------------------------------------------------

interface ObjectMember {
  /** UNESCAPED key name (JSON escapes decoded). */
  key: string;
  /** Offset of the opening quote of this member's key. */
  keyStart: number;
  /** The member's value node (carries its own byte span). */
  value: ValueNode;
}

interface ObjectNode {
  kind: 'object';
  start: number;
  end: number;
  /** Offset just after the opening `{`. */
  bodyStart: number;
  /** Offset of the closing `}`. */
  bodyEnd: number;
  members: ObjectMember[];
}

interface ScalarNode {
  kind: 'array' | 'string' | 'number' | 'literal';
  start: number;
  end: number;
}

type ValueNode = ObjectNode | ScalarNode;

/**
 * A minimal recursive-descent JSON parser that records the byte span of every
 * value (and, for objects, of every member). It exists so we can splice a single
 * value in place without touching any other byte. String scanning honors escape
 * sequences so braces/brackets inside strings never confuse nesting.
 */
class JsonSpanParser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): ValueNode {
    this.skipWs();
    const node = this.parseValue();
    this.skipWs();
    if (this.i !== this.s.length) {
      this.fail('unexpected trailing content');
    }
    return node;
  }

  private skipWs(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else break;
    }
  }

  private fail(msg: string): never {
    throw new JsonKeyError(`Live file is not valid JSON: ${msg} at position ${this.i}`);
  }

  private parseValue(): ValueNode {
    const c = this.s[this.i];
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"') {
      const str = this.parseString();
      return { kind: 'string', start: str.start, end: str.end };
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    if (this.s.startsWith('true', this.i)) {
      const start = this.i;
      this.i += 4;
      return { kind: 'literal', start, end: this.i };
    }
    if (this.s.startsWith('false', this.i)) {
      const start = this.i;
      this.i += 5;
      return { kind: 'literal', start, end: this.i };
    }
    if (this.s.startsWith('null', this.i)) {
      const start = this.i;
      this.i += 4;
      return { kind: 'literal', start, end: this.i };
    }
    this.fail(`unexpected character ${JSON.stringify(c ?? '<eof>')}`);
  }

  private parseObject(): ObjectNode {
    const start = this.i;
    this.i++; // consume '{'
    const bodyStart = this.i;
    const members: ObjectMember[] = [];
    this.skipWs();
    if (this.s[this.i] === '}') {
      const bodyEnd = this.i;
      this.i++;
      return { kind: 'object', start, end: this.i, bodyStart, bodyEnd, members };
    }
    for (;;) {
      this.skipWs();
      if (this.s[this.i] !== '"') this.fail('expected string key');
      const keyStart = this.i;
      const keyStr = this.parseString();
      this.skipWs();
      if (this.s[this.i] !== ':') this.fail("expected ':'");
      this.i++;
      this.skipWs();
      const value = this.parseValue();
      members.push({ key: keyStr.decoded, keyStart, value });
      this.skipWs();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === '}') {
        const bodyEnd = this.i;
        this.i++;
        return { kind: 'object', start, end: this.i, bodyStart, bodyEnd, members };
      }
      this.fail("expected ',' or '}'");
    }
  }

  private parseArray(): ScalarNode {
    const start = this.i;
    this.i++; // consume '['
    this.skipWs();
    if (this.s[this.i] === ']') {
      this.i++;
      return { kind: 'array', start, end: this.i };
    }
    for (;;) {
      this.skipWs();
      this.parseValue();
      this.skipWs();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === ']') {
        this.i++;
        return { kind: 'array', start, end: this.i };
      }
      this.fail("expected ',' or ']'");
    }
  }

  private parseString(): { start: number; end: number; decoded: string } {
    const start = this.i;
    this.i++; // opening quote
    let decoded = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated string');
      const c = this.s[this.i];
      if (c === '"') {
        this.i++;
        break;
      }
      if (c === '\\') {
        const esc = this.s[this.i + 1];
        switch (esc) {
          case '"':
            decoded += '"';
            this.i += 2;
            break;
          case '\\':
            decoded += '\\';
            this.i += 2;
            break;
          case '/':
            decoded += '/';
            this.i += 2;
            break;
          case 'b':
            decoded += '\b';
            this.i += 2;
            break;
          case 'f':
            decoded += '\f';
            this.i += 2;
            break;
          case 'n':
            decoded += '\n';
            this.i += 2;
            break;
          case 'r':
            decoded += '\r';
            this.i += 2;
            break;
          case 't':
            decoded += '\t';
            this.i += 2;
            break;
          case 'u': {
            const hex = this.s.slice(this.i + 2, this.i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape');
            decoded += String.fromCharCode(parseInt(hex, 16));
            this.i += 6;
            break;
          }
          default:
            this.fail('invalid escape sequence');
        }
        continue;
      }
      decoded += c;
      this.i++;
    }
    return { start, end: this.i, decoded };
  }

  private parseNumber(): ScalarNode {
    const start = this.i;
    const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
    if (this.s[this.i] === '-') this.i++;
    while (isDigit(this.s[this.i])) this.i++;
    if (this.s[this.i] === '.') {
      this.i++;
      while (isDigit(this.s[this.i])) this.i++;
    }
    if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      this.i++;
      if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
      while (isDigit(this.s[this.i])) this.i++;
    }
    return { kind: 'number', start, end: this.i };
  }
}

/** Leading whitespace of the line containing `offset` (its indentation prefix). */
const lineIndent = (text: string, offset: number): string => {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
  let j = lineStart;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  return text.slice(lineStart, j);
};

/**
 * Best-effort detection of the file's indent unit (one indentation level). Reads
 * the whitespace of the first indented line — in a pretty-printed object that is
 * a depth-1 key, i.e. exactly one unit. Falls back to two spaces for single-line
 * or unindented files (only consulted when re-serializing a multi-line value).
 */
const detectIndentUnit = (text: string): string => {
  const m = text.match(/\n([ \t]+)\S/);
  return m ? m[1] : '  ';
};

/** Wrap `leaf` in nested objects for `segments` (`['a','b'], v` → `{a:{b:v}}`). */
const buildNested = (segments: string[], leaf: JsonValue): JsonValue => {
  let value = leaf;
  for (let k = segments.length - 1; k >= 0; k--) {
    value = { [segments[k]]: value };
  }
  return value;
};

/**
 * Serialize a value for splicing into the live text. When `multiline`, pretty-
 * print with the file's indent unit and re-indent every line after the first by
 * `continuationIndent` so the value sits correctly at its depth; when not,
 * emit compact JSON (single-line files stay single-line). Keys are sorted so the
 * spliced value matches the canonical repo copy's ordering.
 */
const serializeSpliceValue = (
  value: JsonValue,
  indentUnit: string,
  multiline: boolean,
  continuationIndent: string
): string => {
  const sorted = sortJsonKeys(value);
  if (!multiline) return JSON.stringify(sorted);
  const raw = JSON.stringify(sorted, null, indentUnit);
  return raw
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : continuationIndent + line))
    .join('\n');
};

/** Splice a brand-new `"key": value` member into `container`, preserving layout. */
const insertMember = (
  text: string,
  container: ObjectNode,
  key: string,
  value: JsonValue,
  indentUnit: string,
  multiline: boolean
): string => {
  const keyJson = JSON.stringify(key);

  if (container.members.length === 0) {
    // Empty object: replace the whitespace between the braces with one member.
    const baseIndent = lineIndent(text, container.start);
    const memberIndent = baseIndent + indentUnit;
    if (!multiline) {
      const valueStr = serializeSpliceValue(value, indentUnit, false, '');
      return (
        text.slice(0, container.bodyStart) +
        `${keyJson}:${valueStr}` +
        text.slice(container.bodyEnd)
      );
    }
    const valueStr = serializeSpliceValue(value, indentUnit, true, memberIndent);
    const inserted = `\n${memberIndent}${keyJson}: ${valueStr}\n${baseIndent}`;
    return text.slice(0, container.bodyStart) + inserted + text.slice(container.bodyEnd);
  }

  // Non-empty object: append after the last member's value (which carries no
  // trailing comma), inserting the comma ourselves.
  const last = container.members[container.members.length - 1];
  const insertAt = last.value.end;
  if (!multiline) {
    const valueStr = serializeSpliceValue(value, indentUnit, false, '');
    return text.slice(0, insertAt) + `,${keyJson}:${valueStr}` + text.slice(insertAt);
  }
  const memberIndent = lineIndent(text, last.keyStart);
  const valueStr = serializeSpliceValue(value, indentUnit, true, memberIndent);
  const inserted = `,\n${memberIndent}${keyJson}: ${valueStr}`;
  return text.slice(0, insertAt) + inserted + text.slice(insertAt);
};

/**
 * Write a repo-stored subtree back into a live file's text at `key`, returning
 * the full updated file text.
 *
 * The value AT the tracked path is REPLACED by the repo subtree (it is
 * tuck-managed by definition — replacing is what lets deletions inside the
 * subtree propagate across machines). Every byte OUTSIDE that path is preserved
 * verbatim via a span-splice: large integers, key order, indentation style, and
 * trailing whitespace of the untracked remainder are all left exactly as-is.
 * When the tracked path is absent it is inserted into the nearest existing
 * ancestor object (creating intermediate objects as needed). When the live file
 * is absent/empty the result is a new object holding just the subtree.
 *
 * @throws {@link JsonKeyError} when the repo subtree or a non-empty live file is
 *   not valid JSON, the live top level is not a JSON object, or an INTERMEDIATE
 *   node on the path exists but is not an object (descending into it would
 *   discard that data).
 */
export const mergeSubtreeIntoLive = (
  liveContent: string | null,
  repoSubtree: string,
  key: string
): string => {
  const subtreeValue = parseJsonOrThrow(repoSubtree, 'Repo subtree');
  const segments = parseJsonKeyPath(key);

  // Empty/absent live file: no bytes to preserve — synthesize a fresh object.
  if (liveContent === null || liveContent.trim() === '') {
    return `${JSON.stringify(buildNested(segments, subtreeValue), null, 2)}\n`;
  }

  let root: ValueNode;
  try {
    root = new JsonSpanParser(liveContent).parse();
  } catch (error) {
    if (error instanceof JsonKeyError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new JsonKeyError(`Live file is not valid JSON: ${reason}`);
  }
  if (root.kind !== 'object') {
    throw new JsonKeyError('JSON-key tracking requires the live file to be a JSON object');
  }

  const indentUnit = detectIndentUnit(liveContent);
  const multiline = liveContent.includes('\n');

  let container: ObjectNode = root;
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const member = container.members.find((m) => m.key === seg);
    const isLast = idx === segments.length - 1;

    if (member) {
      if (isLast) {
        // Replace the tracked value's byte span in place.
        const keyIndent = lineIndent(liveContent, member.keyStart);
        const replacement = serializeSpliceValue(subtreeValue, indentUnit, multiline, keyIndent);
        return (
          liveContent.slice(0, member.value.start) +
          replacement +
          liveContent.slice(member.value.end)
        );
      }
      if (member.value.kind !== 'object') {
        // An intermediate node exists but is not an object: overwriting it would
        // discard whatever it holds (an array, scalar, …). Fail loudly — callers
        // catch JsonKeyError and skip this file rather than corrupt it.
        throw new JsonKeyError(
          `Cannot write JSON key path "${key}": "${segments.slice(0, idx + 1).join('.')}" ` +
            `in the live file is a ${member.value.kind}, not an object — refusing to overwrite it`
        );
      }
      container = member.value;
      continue;
    }

    // Missing segment: insert into the nearest existing ancestor object, wrapping
    // the subtree in any intermediate objects the remaining path still needs.
    const newValue = buildNested(segments.slice(idx + 1), subtreeValue);
    return insertMember(liveContent, container, seg, newValue, indentUnit, multiline);
  }

  // Unreachable: `segments` is always non-empty, so the loop returns above.
  /* istanbul ignore next */
  throw new JsonKeyError(`Key path "${key}" could not be resolved`);
};
