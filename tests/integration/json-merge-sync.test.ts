/**
 * Sandboxed integration test for the sync-time structured JSON merge.
 *
 * Exercises the real filesystem pipeline `tuck sync` uses when a merge-policy
 * file diverges: capture the pre-pull repo copy (the common ancestor), then
 * three-way merge base × live(ours) × post-pull-repo(theirs) and converge both
 * copies. Uses fresh OS temp dirs only — never the real HOME, no git, no
 * network. The global memfs mocks are unmocked so real fs.readFile/writeFile
 * run, mirroring what `captureMergeBases` does at runtime.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('fs-extra');
vi.unmock('os');

import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureMergeBases,
  decideFileMerge,
  combineMergeBases,
} from '../../src/lib/jsonMergeSync.js';
import { resolveMergePolicy } from '../../src/lib/jsonMerge.js';
import type { TrackedFileOutput } from '../../src/schemas/manifest.schema.js';

const DEST_REL = 'files/agent/settings.json';

const makeTrackedFile = (overrides: Partial<TrackedFileOutput> = {}): TrackedFileOutput => ({
  source: '~/.claude/settings.json',
  destination: DEST_REL,
  category: 'misc',
  strategy: 'copy',
  encrypted: false,
  template: false,
  added: new Date().toISOString(),
  modified: new Date().toISOString(),
  checksum: 'deadbeef',
  bundle: 'default',
  ...overrides,
});

describe('sync-time JSON merge (real temp dirs)', () => {
  let tuckDir: string;

  beforeEach(async () => {
    tuckDir = mkdtempSync(join(tmpdir(), 'tuck-jsonmerge-'));
    await fs.mkdir(join(tuckDir, 'files', 'agent'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tuckDir, { recursive: true, force: true });
  });

  it('captures the repo copy of auto-detected agent config files as the merge base', async () => {
    const base = JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2) + '\n';
    await fs.writeFile(join(tuckDir, DEST_REL), base, 'utf-8');

    const files: Record<string, TrackedFileOutput> = { f1: makeTrackedFile() };
    const bases = await captureMergeBases(tuckDir, files);

    expect(bases.get('~/.claude/settings.json')).toBe(base);
  });

  it('does NOT capture bases for files without a merge policy', async () => {
    await fs.writeFile(join(tuckDir, DEST_REL), '{}', 'utf-8');
    const files: Record<string, TrackedFileOutput> = {
      f1: makeTrackedFile({ source: '~/.zshrc' }),
    };
    const bases = await captureMergeBases(tuckDir, files);
    expect(bases.size).toBe(0);
  });

  it('NEVER captures a base for a jsonKey (--key) file, even under a merge-policy path', async () => {
    // The repo copy of a --key file is only the tracked SUBTREE document, while
    // the live file is the whole config. Whole-file three-way merging it would
    // splice subtree keys into the live root and transiently write the whole
    // live file (tokens included) into the repo — data corruption. It must be
    // skipped so its subtree-aware sync path is the only one that touches it.
    const subtreeDoc = JSON.stringify({ allow: ['Read'] }, null, 2) + '\n';
    await fs.writeFile(join(tuckDir, DEST_REL), subtreeDoc, 'utf-8');

    // A source path that WOULD otherwise get a merge policy, but marked jsonKey.
    const files: Record<string, TrackedFileOutput> = {
      f1: makeTrackedFile({ source: '~/.claude.json', jsonKey: 'projects.foo' }),
    };
    const bases = await captureMergeBases(tuckDir, files);
    expect(bases.size).toBe(0);
    expect(bases.has('~/.claude.json')).toBe(false);
  });

  it('unions divergent permission allowlists across two machines end to end', async () => {
    // 1. Last-synced state = repo copy before pull (the base).
    const base = JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2) + '\n';
    const destPath = join(tuckDir, DEST_REL);
    await fs.writeFile(destPath, base, 'utf-8');

    const file = makeTrackedFile();
    const bases = await captureMergeBases(tuckDir, { f1: file });
    const baseText = bases.get(file.source);
    expect(baseText).toBeDefined();

    // 2. Remote (machine A) added WebFetch; the pull advanced the repo copy.
    const remoteText = JSON.stringify({ permissions: { allow: ['Read', 'WebFetch'] } }, null, 2) + '\n';
    await fs.writeFile(destPath, remoteText, 'utf-8');

    // 3. Local agent (machine B) added Bash to the live file.
    const livePath = join(tuckDir, 'live-settings.json');
    const liveText = JSON.stringify({ permissions: { allow: ['Read', 'Bash(git:*)'] } }, null, 2) + '\n';
    await fs.writeFile(livePath, liveText, 'utf-8');

    // 4. Reconcile.
    const policy = resolveMergePolicy(file.source, file.merge);
    expect(policy).not.toBeNull();
    const decision = decideFileMerge(baseText!, liveText, remoteText, policy!);
    expect(decision.kind).toBe('clean');

    if (decision.kind !== 'clean') throw new Error('expected clean merge');

    // 5. Converge both copies (what sync writes).
    await fs.writeFile(livePath, decision.text, 'utf-8');
    await fs.writeFile(destPath, decision.text, 'utf-8');

    const merged = JSON.parse(await fs.readFile(livePath, 'utf-8')) as {
      permissions: { allow: string[] };
    };
    expect(merged.permissions.allow.sort()).toEqual(['Bash(git:*)', 'Read', 'WebFetch']);
    // Both machines converged to the identical document.
    expect(await fs.readFile(destPath, 'utf-8')).toBe(decision.text);
  });

  it('skips reconciliation when the pull brought no change to the file', async () => {
    const base = JSON.stringify({ a: 1 }, null, 2) + '\n';
    const live = JSON.stringify({ a: 2 }, null, 2) + '\n';
    const policy = resolveMergePolicy('~/.claude/settings.json')!;
    // remote === base → nothing to reconcile; normal copy captures local edit.
    const decision = decideFileMerge(base, live, base, policy);
    expect(decision.kind).toBe('skip');
  });

  it('surfaces a conflict when both machines set the same scalar differently', async () => {
    const base = JSON.stringify({ model: 'sonnet' }, null, 2) + '\n';
    const remote = JSON.stringify({ model: 'opus' }, null, 2) + '\n';
    const live = JSON.stringify({ model: 'haiku' }, null, 2) + '\n';
    const policy = resolveMergePolicy('~/.claude/settings.json')!;
    const decision = decideFileMerge(base, live, remote, policy);
    expect(decision.kind).toBe('conflict');
    if (decision.kind !== 'conflict') throw new Error('expected conflict');
    expect(decision.conflicts.map((c) => c.path)).toContain('model');
  });
});

describe('combineMergeBases precedence (persisted wins over fresh)', () => {
  it('keeps the persisted base on collision, fills gaps from fresh', () => {
    const fresh = new Map<string, string>([
      ['~/.claude/settings.json', 'FRESH-WRONG'],
      ['~/.gitconfig', 'FRESH-ONLY'],
    ]);
    const persisted = new Map<string, string>([['~/.claude/settings.json', 'PERSISTED-RIGHT']]);

    const combined = combineMergeBases(fresh, persisted);

    // Persisted ancestor wins — after an abort the repo copy already holds the
    // previously-pulled remote, so a fresh base captured this run is the wrong
    // (post-pull) ancestor.
    expect(combined.get('~/.claude/settings.json')).toBe('PERSISTED-RIGHT');
    // Files with no pending base still get the fresh base.
    expect(combined.get('~/.gitconfig')).toBe('FRESH-ONLY');
    expect(combined.size).toBe(2);
  });

  it('returns the fresh map contents when nothing is persisted', () => {
    const fresh = new Map<string, string>([['~/.zshrc', 'BASE']]);
    const combined = combineMergeBases(fresh, new Map());
    expect(combined.get('~/.zshrc')).toBe('BASE');
    expect(combined.size).toBe(1);
  });
});
