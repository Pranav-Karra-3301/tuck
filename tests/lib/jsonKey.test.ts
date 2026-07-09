import { describe, it, expect } from 'vitest';
import {
  parseJsonKeyPath,
  canonicalJson,
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
  it('REPLACES the tracked subtree while leaving every other key untouched', () => {
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
    // The tracked subtree is REPLACED wholesale: entries deleted from the repo
    // copy ('stale') must NOT survive on the live machine — a deep-merge here
    // would resurrect them and the next sync would push them back to the repo,
    // reverting the deletion globally.
    expect(merged.mcpServers).toEqual({
      git: { command: 'NEW' },
      added: { command: 'y' },
    });
  });

  it('propagates deletions inside the tracked subtree (no resurrection loop)', () => {
    const live = JSON.stringify({ mcpServers: { removed: { command: 'gone' } }, other: 1 });
    const repoSubtree = canonicalJson({ kept: { command: 'k' } });
    const merged = JSON.parse(mergeSubtreeIntoLive(live, repoSubtree, 'mcpServers'));
    expect(merged.mcpServers.removed).toBeUndefined();
    expect(merged.mcpServers.kept).toEqual({ command: 'k' });
    expect(merged.other).toBe(1);
  });

  it('rejects prototype-named key path segments', () => {
    for (const bad of ['__proto__', 'constructor', 'a.prototype.b']) {
      expect(() => parseJsonKeyPath(bad)).toThrow(/reserved property/);
    }
  });

  it('never matches inherited properties during navigation', () => {
    // 'toString' exists on every object via the prototype chain; extraction
    // must treat it as ABSENT when it is not an own key (previously inherited
    // lookups "succeeded" and wrote literal `undefined` — invalid JSON — to
    // the repo). ('constructor'/'__proto__' are rejected at parse time.)
    expect(() => extractSubtree(JSON.stringify({ a: 1 }), 'toString')).toThrow(/not found/);
  });

  it('a "__proto__" data key in live JSON never pollutes Object.prototype', () => {
    // Build `live` as a RAW JSON string so it actually carries a `__proto__`
    // DATA key. An object literal `{ '__proto__': ... }` sets the prototype slot
    // (a non-enumerable internal), which JSON.stringify drops — so the merge
    // would never see the key at all and the pollution path would be untested.
    const live = '{ "__proto__": { "polluted": true }, "mcpServers": {} }';
    const repoSubtree = canonicalJson({ s: { command: 'x' } });
    const merged = mergeSubtreeIntoLive(live, repoSubtree, 'mcpServers');

    // Parsing/navigating a real `__proto__` key must not touch Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);

    // The untracked `__proto__` member is outside the tracked path, so the
    // span-splice preserves its bytes verbatim.
    expect(merged).toContain('"__proto__"');

    // And the tracked subtree was replaced with the repo copy.
    const reparsed = JSON.parse(merged) as { mcpServers: unknown };
    expect(reparsed.mcpServers).toEqual({ s: { command: 'x' } });
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

  it('throws when an INTERMEDIATE node on the write path is not an object', () => {
    // Tracking a.b when live has "a": [1,2,3] must fail loudly rather than
    // silently replace the whole array (which would discard untracked data).
    const live = JSON.stringify({ a: [1, 2, 3], keep: 1 });
    expect(() => mergeSubtreeIntoLive(live, canonicalJson({ x: 1 }), 'a.b')).toThrow(JsonKeyError);
    expect(() => mergeSubtreeIntoLive(live, canonicalJson({ x: 1 }), 'a.b')).toThrow(
      /not an object/i
    );
  });
});

describe('parseJsonKeyPath escaping', () => {
  it('treats a backslash-escaped dot as a literal character in a single key name', () => {
    // `servers.github\.copilot` addresses servers -> "github.copilot"
    expect(parseJsonKeyPath('servers.github\\.copilot')).toEqual(['servers', 'github.copilot']);
  });

  it('unescapes a literal backslash (\\\\ -> \\)', () => {
    expect(parseJsonKeyPath('a\\\\b')).toEqual(['a\\b']);
  });

  it('still splits on UNESCAPED dots', () => {
    expect(parseJsonKeyPath('a.b\\.c.d')).toEqual(['a', 'b.c', 'd']);
  });

  it('applies the empty-segment guard to the unescaped result', () => {
    expect(() => parseJsonKeyPath('a..b')).toThrow(JsonKeyError);
  });

  it('applies the prototype-pollution guard to the UNESCAPED segment names', () => {
    expect(() => parseJsonKeyPath('a.__proto__')).toThrow(/reserved property/);
  });
});

describe('mergeSubtreeIntoLive span-splice (byte preservation)', () => {
  it('preserves a large integer in the UNTRACKED remainder byte-for-byte', () => {
    const live = [
      '{',
      '  "bigId": 1234567890123456789,',
      '  "mcpServers": {',
      '    "git": { "command": "OLD" }',
      '  }',
      '}',
    ].join('\n');
    const out = mergeSubtreeIntoLive(live, canonicalJson({ git: { command: 'NEW' } }), 'mcpServers');
    // The untracked big int must survive verbatim — a JSON.parse round-trip would
    // corrupt it to ...800.
    expect(out).toContain('1234567890123456789');
    expect(out).not.toContain('1234567890123456800');
    // And the tracked subtree is actually replaced.
    expect(JSON.parse(out).mcpServers).toEqual({ git: { command: 'NEW' } });
  });

  it('preserves the textual key order of the untracked remainder', () => {
    const live = ['{', '  "z": 1,', '  "a": 2,', '  "tracked": {},', '  "m": 3', '}'].join('\n');
    const out = mergeSubtreeIntoLive(live, canonicalJson({ v: 1 }), 'tracked');
    expect(out.indexOf('"z"')).toBeLessThan(out.indexOf('"a"'));
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"tracked"'));
    expect(out.indexOf('"tracked"')).toBeLessThan(out.indexOf('"m"'));
  });

  it('does not reorder integer-like keys in the untracked remainder', () => {
    // JSON.parse/stringify reorders numeric string keys ascending (1,2,10); the
    // span-splice must keep the original textual order (10,2,1).
    const live = ['{', '  "10": "a",', '  "2": "b",', '  "1": "c",', '  "tracked": {}', '}'].join(
      '\n'
    );
    const out = mergeSubtreeIntoLive(live, canonicalJson({ v: 1 }), 'tracked');
    expect(out.indexOf('"10"')).toBeLessThan(out.indexOf('"2"'));
    expect(out.indexOf('"2"')).toBeLessThan(out.indexOf('"1"'));
  });

  it('preserves tab indentation of untracked lines and re-indents the value with tabs', () => {
    const live = '{\n\t"tracked": {\n\t\t"old": 1\n\t},\n\t"keep": 2\n}';
    const out = mergeSubtreeIntoLive(live, canonicalJson({ fresh: true }), 'tracked');
    expect(out).toContain('\t"keep": 2');
    expect(out).toContain('\t"tracked": {');
    expect(JSON.parse(out)).toEqual({ tracked: { fresh: true }, keep: 2 });
  });

  it('preserves 4-space indentation', () => {
    const live = [
      '{',
      '    "tracked": {',
      '        "old": 1',
      '    },',
      '    "keep": 2',
      '}',
    ].join('\n');
    const out = mergeSubtreeIntoLive(live, canonicalJson({ nested: { deep: true } }), 'tracked');
    expect(JSON.parse(out)).toEqual({ tracked: { nested: { deep: true } }, keep: 2 });
    expect(out).toContain('    "tracked": {');
    expect(out).toContain('        "nested": {');
    expect(out).toContain('            "deep": true');
  });

  it('replaces the subtree correctly at a deeply nested path', () => {
    const live = [
      '{',
      '  "a": {',
      '    "b": {',
      '      "c": { "old": 1 }',
      '    }',
      '  },',
      '  "keep": 9',
      '}',
    ].join('\n');
    const out = mergeSubtreeIntoLive(live, canonicalJson({ fresh: true }), 'a.b.c');
    const parsed = JSON.parse(out);
    expect(parsed.a.b.c).toEqual({ fresh: true });
    expect(parsed.keep).toBe(9);
  });

  it('inserts the key into the nearest existing ancestor object when the path is missing', () => {
    const live = ['{', '  "editor": {},', '  "keep": 1', '}'].join('\n');
    const out = mergeSubtreeIntoLive(live, canonicalJson({ enabled: true }), 'editor.settings');
    const parsed = JSON.parse(out);
    expect(parsed.editor.settings).toEqual({ enabled: true });
    expect(parsed.keep).toBe(1);
  });

  it('handles unicode escapes and braces inside string values without confusing nesting', () => {
    const live = JSON.stringify(
      { weird: 'a{[}] " brace A \\ end', tracked: { old: 1 } },
      null,
      2
    );
    const out = mergeSubtreeIntoLive(live, canonicalJson({ fresh: true }), 'tracked');
    const parsed = JSON.parse(out);
    expect(parsed.weird).toBe('a{[}] " brace A \\ end');
    expect(parsed.tracked).toEqual({ fresh: true });
  });

  it('touches only the tracked value in a compact file, leaving other bytes intact', () => {
    const live = '{"tracked":{"old":1},"keep":2}';
    const out = mergeSubtreeIntoLive(live, canonicalJson({ new: 1 }), 'tracked');
    expect(out).toBe('{"tracked":{"new":1},"keep":2}');
  });

  it('preserves a trailing newline in the untouched remainder', () => {
    const live = '{\n  "tracked": {},\n  "keep": 1\n}\n';
    const out = mergeSubtreeIntoLive(live, canonicalJson({ a: 1 }), 'tracked');
    expect(out.endsWith('}\n')).toBe(true);
    expect(JSON.parse(out)).toEqual({ tracked: { a: 1 }, keep: 1 });
  });

  it('round-trips an escaped-dot key through extract then write-back', () => {
    const live = JSON.stringify(
      { servers: { 'github.copilot': { on: true }, other: 1 } },
      null,
      2
    );
    const sub = extractSubtree(live, 'servers.github\\.copilot');
    expect(JSON.parse(sub)).toEqual({ on: true });
    const merged = mergeSubtreeIntoLive(live, canonicalJson({ on: false }), 'servers.github\\.copilot');
    const parsed = JSON.parse(merged);
    expect(parsed.servers['github.copilot']).toEqual({ on: false });
    expect(parsed.servers.other).toBe(1);
  });
});
