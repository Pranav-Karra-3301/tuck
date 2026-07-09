import { describe, it, expect } from 'vitest';
import {
  parseJsonKeyPath,
  canonicalJson,
  deepMergeJson,
  extractSubtree,
  hasSubtree,
  mergeSubtreeIntoLive,
  isPlainObject,
} from '../../src/lib/jsonKey.js';
import { JsonKeyError } from '../../src/errors.js';

describe('parseJsonKeyPath', () => {
  it('splits a dotted path into segments', () => {
    expect(parseJsonKeyPath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('returns a single segment for a top-level key', () => {
    expect(parseJsonKeyPath('mcpServers')).toEqual(['mcpServers']);
  });

  it.each(['', '   ', '.a', 'a.', 'a..b'])('rejects malformed path %j', (bad) => {
    expect(() => parseJsonKeyPath(bad)).toThrow(JsonKeyError);
  });
});

describe('isPlainObject', () => {
  it('is true only for non-null non-array objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(3)).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys deterministically regardless of input order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('sorts nested object keys and preserves array order', () => {
    const out = canonicalJson({ z: { y: 1, x: 2 }, list: [3, 1, 2] });
    expect(out).toBe('{\n  "list": [\n    3,\n    1,\n    2\n  ],\n  "z": {\n    "x": 2,\n    "y": 1\n  }\n}\n');
  });

  it('ends with a trailing newline', () => {
    expect(canonicalJson({ a: 1 }).endsWith('}\n')).toBe(true);
  });
});

describe('deepMergeJson', () => {
  it('recursively merges plain objects, preserving base keys absent from patch', () => {
    const base = { a: 1, nested: { keep: true, override: 'old' } };
    const patch = { b: 2, nested: { override: 'new' } };
    expect(deepMergeJson(base, patch)).toEqual({
      a: 1,
      b: 2,
      nested: { keep: true, override: 'new' },
    });
  });

  it('replaces arrays wholesale rather than element-merging', () => {
    expect(deepMergeJson({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('replaces a scalar base with a patch object', () => {
    expect(deepMergeJson(5, { a: 1 })).toEqual({ a: 1 });
  });

  it('does not mutate its inputs', () => {
    const base = { nested: { a: 1 } };
    const patch = { nested: { b: 2 } };
    deepMergeJson(base, patch);
    expect(base).toEqual({ nested: { a: 1 } });
    expect(patch).toEqual({ nested: { b: 2 } });
  });
});

describe('extractSubtree', () => {
  const file = JSON.stringify({
    mcpServers: { git: { command: 'git-mcp' } },
    oauthToken: 'secret-abc',
    numStartups: 42,
  });

  it('extracts only the named subtree as canonical JSON', () => {
    expect(extractSubtree(file, 'mcpServers')).toBe(
      canonicalJson({ git: { command: 'git-mcp' } })
    );
  });

  it('extracts a nested key path', () => {
    expect(extractSubtree(file, 'mcpServers.git')).toBe(canonicalJson({ command: 'git-mcp' }));
  });

  it('extracts scalar leaf values', () => {
    expect(extractSubtree(file, 'numStartups')).toBe(canonicalJson(42));
  });

  it('is stable across key ordering of the source file', () => {
    const a = JSON.stringify({ mcpServers: { a: 1, b: 2 }, x: 1 });
    const b = JSON.stringify({ x: 1, mcpServers: { b: 2, a: 1 } });
    expect(extractSubtree(a, 'mcpServers')).toBe(extractSubtree(b, 'mcpServers'));
  });

  it('throws when the key path is missing', () => {
    expect(() => extractSubtree(file, 'doesNotExist')).toThrow(JsonKeyError);
  });

  it('throws when an intermediate node is not an object', () => {
    expect(() => extractSubtree(file, 'oauthToken.deeper')).toThrow(JsonKeyError);
  });

  it('throws on invalid JSON', () => {
    expect(() => extractSubtree('{ not json', 'a')).toThrow(JsonKeyError);
  });

  it('throws when the top level is not an object', () => {
    expect(() => extractSubtree('[1,2,3]', 'a')).toThrow(JsonKeyError);
  });
});

describe('hasSubtree', () => {
  const file = JSON.stringify({ mcpServers: { git: {} }, token: 'x' });
  it('returns true when the key path exists', () => {
    expect(hasSubtree(file, 'mcpServers')).toBe(true);
    expect(hasSubtree(file, 'mcpServers.git')).toBe(true);
  });
  it('returns false for a missing key, invalid json, or malformed path', () => {
    expect(hasSubtree(file, 'nope')).toBe(false);
    expect(hasSubtree('{ bad', 'mcpServers')).toBe(false);
    expect(hasSubtree(file, 'a..b')).toBe(false);
  });
});

describe('mergeSubtreeIntoLive', () => {
  it('deep-merges the subtree back while leaving every other key untouched', () => {
    const live = JSON.stringify(
      {
        oauthToken: 'MACHINE-SECRET',
        numStartups: 99,
        mcpServers: { git: { command: 'OLD' }, stale: { command: 'x' } },
      },
      null,
      2
    );
    const repoSubtree = canonicalJson({ git: { command: 'NEW' }, added: { command: 'y' } });

    const merged = JSON.parse(mergeSubtreeIntoLive(live, repoSubtree, 'mcpServers'));

    // Machine-managed keys are preserved verbatim.
    expect(merged.oauthToken).toBe('MACHINE-SECRET');
    expect(merged.numStartups).toBe(99);
    // The tracked subtree is deep-merged: updated + added + existing siblings kept.
    expect(merged.mcpServers).toEqual({
      git: { command: 'NEW' },
      stale: { command: 'x' },
      added: { command: 'y' },
    });
  });

  it('creates the key (and intermediate objects) when absent from live', () => {
    const live = JSON.stringify({ token: 'keep' });
    const repoSubtree = canonicalJson({ enabled: true });
    const merged = JSON.parse(mergeSubtreeIntoLive(live, repoSubtree, 'editor.settings'));
    expect(merged).toEqual({ token: 'keep', editor: { settings: { enabled: true } } });
  });

  it('treats a null/empty live file as a fresh object', () => {
    const repoSubtree = canonicalJson({ a: 1 });
    expect(JSON.parse(mergeSubtreeIntoLive(null, repoSubtree, 'k'))).toEqual({ k: { a: 1 } });
    expect(JSON.parse(mergeSubtreeIntoLive('   ', repoSubtree, 'k'))).toEqual({ k: { a: 1 } });
  });

  it('round-trips: extract then merge reproduces the tracked subtree', () => {
    const live = JSON.stringify({ mcpServers: { git: { command: 'a' } }, token: 't' });
    const sub = extractSubtree(live, 'mcpServers');
    const merged = JSON.parse(mergeSubtreeIntoLive(live, sub, 'mcpServers'));
    expect(merged.mcpServers).toEqual({ git: { command: 'a' } });
    expect(merged.token).toBe('t');
  });

  it('replaces a conflicting non-object node at the exact path only', () => {
    const live = JSON.stringify({ mcpServers: 'was-a-string', other: 1 });
    const repoSubtree = canonicalJson({ git: {} });
    const merged = JSON.parse(mergeSubtreeIntoLive(live, repoSubtree, 'mcpServers'));
    expect(merged.mcpServers).toEqual({ git: {} });
    expect(merged.other).toBe(1);
  });

  it('throws when the live file is not valid JSON', () => {
    expect(() => mergeSubtreeIntoLive('{ bad', canonicalJson({ a: 1 }), 'k')).toThrow(JsonKeyError);
  });

  it('throws when the live top level is not an object', () => {
    expect(() => mergeSubtreeIntoLive('[1,2]', canonicalJson({ a: 1 }), 'k')).toThrow(JsonKeyError);
  });
});
