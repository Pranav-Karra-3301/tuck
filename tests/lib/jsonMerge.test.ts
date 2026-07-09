import { describe, it, expect } from 'vitest';
import {
  mergeJsonValues,
  threeWayMergeJsonText,
  canonicalize,
  detectJsonIndent,
  resolveMergePolicy,
  hasMergePolicy,
  DEFAULT_JSON_MERGE_POLICY,
  type MergePolicy,
  type JsonValue,
} from '../../src/lib/jsonMerge.js';
import { mergePolicySchema } from '../../src/schemas/manifest.schema.js';

const union: MergePolicy = { format: 'json', arrays: 'union', conflict: 'manual' };

describe('canonicalize', () => {
  it('is order-independent for object keys', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2] as JsonValue)).not.toBe(canonicalize([2, 1] as JsonValue));
  });
});

describe('detectJsonIndent', () => {
  it('detects two-space indent', () => {
    expect(detectJsonIndent('{\n  "a": 1\n}')).toBe(2);
  });
  it('detects four-space indent', () => {
    expect(detectJsonIndent('{\n    "a": 1\n}')).toBe(4);
  });
  it('detects tab indent', () => {
    expect(detectJsonIndent('{\n\t"a": 1\n}')).toBe('\t');
  });
  it('defaults to two spaces', () => {
    expect(detectJsonIndent('{}')).toBe(2);
  });
});

describe('mergeJsonValues — non-diverging fast paths', () => {
  it('takes theirs when only remote changed', () => {
    const { merged, conflicts } = mergeJsonValues({ a: 1 }, { a: 1 }, { a: 2 }, union);
    expect(merged).toEqual({ a: 2 });
    expect(conflicts).toHaveLength(0);
  });

  it('keeps ours when only local changed', () => {
    const { merged, conflicts } = mergeJsonValues({ a: 1 }, { a: 3 }, { a: 1 }, union);
    expect(merged).toEqual({ a: 3 });
    expect(conflicts).toHaveLength(0);
  });

  it('returns the identical value when both sides agree', () => {
    const { merged, conflicts } = mergeJsonValues({ a: 1 }, { a: 9 }, { a: 9 }, union);
    expect(merged).toEqual({ a: 9 });
    expect(conflicts).toHaveLength(0);
  });
});

describe('mergeJsonValues — deep object merge (both changed different keys)', () => {
  it('merges disjoint key edits from both sides', () => {
    const base = { theme: 'dark', font: 'mono' };
    const ours = { theme: 'dark', font: 'mono', localOnly: true };
    const theirs = { theme: 'light', font: 'mono' };
    const { merged, conflicts } = mergeJsonValues(base, ours, theirs, union);
    expect(merged).toEqual({ theme: 'light', font: 'mono', localOnly: true });
    expect(conflicts).toHaveLength(0);
  });

  it('recurses into nested objects', () => {
    const base = { permissions: { allow: [], deny: [] } };
    const ours = { permissions: { allow: ['Bash'], deny: [] } };
    const theirs = { permissions: { allow: ['Read'], deny: [] } };
    const { merged, conflicts } = mergeJsonValues(base, ours, theirs, union);
    expect(merged).toEqual({ permissions: { allow: ['Bash', 'Read'], deny: [] } });
    expect(conflicts).toHaveLength(0);
  });
});

describe('mergeJsonValues — array strategies', () => {
  it('unions allowlists and drops duplicates (the Claude settings case)', () => {
    const base = { allow: ['Read'] };
    const ours = { allow: ['Read', 'Bash(git:*)'] };
    const theirs = { allow: ['Read', 'WebFetch'] };
    const { merged } = mergeJsonValues(base, ours, theirs, union);
    expect(merged).toEqual({ allow: ['Read', 'Bash(git:*)', 'WebFetch'] });
  });

  it('unions arrays of objects by deep equality', () => {
    const base = { servers: [] as JsonValue };
    const ours = { servers: [{ name: 'a' }] };
    const theirs = { servers: [{ name: 'a' }, { name: 'b' }] };
    const { merged } = mergeJsonValues(base, ours, theirs, union);
    expect(merged).toEqual({ servers: [{ name: 'a' }, { name: 'b' }] });
  });

  it('concat keeps duplicates', () => {
    const concat: MergePolicy = { format: 'json', arrays: 'concat', conflict: 'manual' };
    const { merged } = mergeJsonValues({ a: [] as JsonValue }, { a: [1] }, { a: [1, 2] }, concat);
    expect(merged).toEqual({ a: [1, 1, 2] });
  });

  it('replace degrades a diverged array to a conflict under manual', () => {
    const replace: MergePolicy = { format: 'json', arrays: 'replace', conflict: 'manual' };
    const { conflicts } = mergeJsonValues({ a: [] as JsonValue }, { a: [1] }, { a: [2] }, replace);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toBe('a');
  });
});

describe('mergeJsonValues — scalar conflicts', () => {
  it('records a conflict when both sides change a leaf differently (manual)', () => {
    const { merged, conflicts } = mergeJsonValues({ model: 'a' }, { model: 'b' }, { model: 'c' }, union);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ path: 'model', ours: 'b', theirs: 'c', base: 'a' });
    // The document stays valid: ours is retained as the placeholder.
    expect(merged).toEqual({ model: 'b' });
  });

  it('resolves conflicts to ours', () => {
    const ours: MergePolicy = { format: 'json', arrays: 'union', conflict: 'ours' };
    const { merged, conflicts } = mergeJsonValues({ x: 1 }, { x: 2 }, { x: 3 }, ours);
    expect(conflicts).toHaveLength(0);
    expect(merged).toEqual({ x: 2 });
  });

  it('resolves conflicts to theirs', () => {
    const theirs: MergePolicy = { format: 'json', arrays: 'union', conflict: 'theirs' };
    const { merged, conflicts } = mergeJsonValues({ x: 1 }, { x: 2 }, { x: 3 }, theirs);
    expect(conflicts).toHaveLength(0);
    expect(merged).toEqual({ x: 3 });
  });

  it('reports nested conflict paths', () => {
    const base = { a: { b: 1 } };
    const { conflicts } = mergeJsonValues(base, { a: { b: 2 } }, { a: { b: 3 } }, union);
    expect(conflicts[0].path).toBe('a.b');
  });
});

describe('mergeJsonValues — key additions and deletions', () => {
  it('keeps a key added only on one side', () => {
    const { merged } = mergeJsonValues({}, { added: 1 }, {}, union);
    expect(merged).toEqual({ added: 1 });
  });

  it('honors a deletion on one side when the other did not touch it', () => {
    // theirs deleted `old`; ours left it untouched → deletion wins.
    const { merged, conflicts } = mergeJsonValues({ old: 1, keep: 1 }, { old: 1, keep: 1 }, { keep: 1 }, union);
    expect(merged).toEqual({ keep: 1 });
    expect(conflicts).toHaveLength(0);
  });

  it('flags delete-vs-modify as a conflict (manual)', () => {
    // ours modified `k`; theirs deleted it.
    const { conflicts } = mergeJsonValues({ k: 1 }, { k: 2 }, {}, union);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ path: 'k', ours: 2, theirs: undefined });
  });
});

describe('threeWayMergeJsonText', () => {
  it('re-serializes with the local file indentation and trailing newline', () => {
    const base = '{\n  "allow": ["Read"]\n}\n';
    const ours = '{\n  "allow": ["Read", "Bash"]\n}\n';
    const theirs = '{\n  "allow": ["Read", "WebFetch"]\n}\n';
    const result = threeWayMergeJsonText(base, ours, theirs, union);
    expect(result.unparsable).toBe(false);
    expect(result.conflicts).toHaveLength(0);
    expect(result.text).toBe('{\n  "allow": [\n    "Read",\n    "Bash",\n    "WebFetch"\n  ]\n}\n');
  });

  it('flags unparsable input', () => {
    const result = threeWayMergeJsonText('{', '{}', '{}', union);
    expect(result.unparsable).toBe(true);
    expect(result.text).toBeNull();
  });

  it('preserves absence of trailing newline', () => {
    const result = threeWayMergeJsonText('{"a":1}', '{"a":2}', '{"a":1}', union);
    expect(result.text?.endsWith('\n')).toBe(false);
  });
});

describe('resolveMergePolicy / hasMergePolicy', () => {
  it('auto-applies the default policy to Claude settings.json', () => {
    expect(resolveMergePolicy('~/.claude/settings.json')).toEqual(DEFAULT_JSON_MERGE_POLICY);
    expect(hasMergePolicy('~/.claude/settings.json')).toBe(true);
  });

  it('auto-applies to .mcp.json', () => {
    expect(resolveMergePolicy('~/project/.mcp.json')).toEqual(DEFAULT_JSON_MERGE_POLICY);
  });

  it('returns null for ordinary files', () => {
    expect(resolveMergePolicy('~/.zshrc')).toBeNull();
    expect(hasMergePolicy('~/.zshrc')).toBe(false);
  });

  it('lets an explicit manifest policy win over auto-detection', () => {
    const explicit: MergePolicy = { format: 'json', arrays: 'concat', conflict: 'ours' };
    expect(resolveMergePolicy('~/.zshrc', explicit)).toEqual(explicit);
    expect(resolveMergePolicy('~/.claude/settings.json', explicit)).toEqual(explicit);
  });
});

describe('mergePolicySchema', () => {
  it('fills defaults for a bare json policy', () => {
    const parsed = mergePolicySchema.parse({ format: 'json' });
    expect(parsed).toEqual({ format: 'json', arrays: 'union', conflict: 'manual' });
  });

  it('rejects unknown array strategies', () => {
    expect(() => mergePolicySchema.parse({ format: 'json', arrays: 'bogus' })).toThrow();
  });
});

describe('pending merge-base persistence (abort recovery)', () => {
  it('round-trips bases through the state dir and clears them', async () => {
    const { persistPendingMergeBases, loadPendingMergeBases, clearPendingMergeBases } =
      await import('../../src/lib/jsonMergeSync.js');
    const bases = new Map([['~/.claude/settings.json', '{"a":1}']]);
    await persistPendingMergeBases(bases);
    const loaded = await loadPendingMergeBases();
    expect(loaded.get('~/.claude/settings.json')).toBe('{"a":1}');
    await clearPendingMergeBases();
    expect((await loadPendingMergeBases()).size).toBe(0);
  });

  it('returns an empty map on corrupt or absent state (never blocks sync)', async () => {
    const { getPendingMergeBasesPath, loadPendingMergeBases, clearPendingMergeBases } =
      await import('../../src/lib/jsonMergeSync.js');
    await clearPendingMergeBases();
    expect((await loadPendingMergeBases()).size).toBe(0);
    const { vol } = await import('memfs');
    const { dirname } = await import('path');
    vol.mkdirSync(dirname(getPendingMergeBasesPath()), { recursive: true });
    vol.writeFileSync(getPendingMergeBasesPath(), 'not json{');
    expect((await loadPendingMergeBases()).size).toBe(0);
  });
});
