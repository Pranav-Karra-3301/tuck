/**
 * Rules fan-out unit tests — the core library that turns one canonical rules
 * file into many per-tool variants (CLAUDE.md, .cursorrules, GEMINI.md, …).
 *
 * All I/O runs against memfs (mocked in tests/setup.ts); os.homedir() is
 * TEST_HOME. Writes go through resolveWriteTarget, so home-scoped variants land
 * under TEST_HOME and repo-scoped variants under the repo root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  trackRuleSet,
  untrackRuleSet,
  loadRulesManifest,
  applyRuleSets,
  computeSetStatus,
  removeToolVariants,
  defaultToolsForSource,
  renderToolContent,
  ruleSetId,
  isKnownTool,
  TOOL_TARGETS,
  ALL_TOOLS,
} from '../../src/lib/rulesFanout.js';
import { defaultTemplateContext } from '../../src/lib/template.js';
import { resetWriteContext } from '../../src/lib/writeContext.js';
import { rulesManifestSchema } from '../../src/schemas/rules.schema.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

const ctx = defaultTemplateContext({});

const readManifest = (): unknown =>
  JSON.parse(vol.readFileSync(join(TEST_TUCK_DIR, 'rules.json'), 'utf-8') as string);

beforeEach(() => {
  vol.reset();
  resetWriteContext();
  vol.mkdirSync(TEST_HOME, { recursive: true });
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
});

afterEach(() => {
  resetWriteContext();
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema + pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('rulesManifestSchema', () => {
  it('rejects a repo-scoped set with no repoRoot', () => {
    const bad = {
      version: '1',
      sets: {
        x: {
          source: '/repo/AGENTS.md',
          scope: 'repo',
          template: true,
          tools: [{ tool: 'claude', strategy: 'materialize' }],
          variables: {},
          added: 'now',
          modified: 'now',
        },
      },
    };
    expect(rulesManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unsafe tool path override (`..` escape)', () => {
    const bad = {
      version: '1',
      sets: {
        x: {
          source: '~/AGENTS.md',
          scope: 'home',
          template: true,
          tools: [{ tool: 'claude', strategy: 'materialize', path: '../../etc/evil' }],
          variables: {},
          added: 'now',
          modified: 'now',
        },
      },
    };
    expect(rulesManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a minimal valid home-scoped set and applies strategy default', () => {
    const good = {
      version: '1',
      sets: {
        x: {
          source: '~/AGENTS.md',
          scope: 'home',
          tools: [{ tool: 'gemini' }],
          added: 'now',
          modified: 'now',
        },
      },
    };
    const parsed = rulesManifestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sets.x.tools[0].strategy).toBe('materialize');
      expect(parsed.data.sets.x.template).toBe(true);
    }
  });
});

describe('isKnownTool / defaultToolsForSource', () => {
  it('recognizes exactly the registered tools', () => {
    expect(ALL_TOOLS.every(isKnownTool)).toBe(true);
    expect(isKnownTool('notatool')).toBe(false);
  });

  it('excludes the tool whose default target IS the canonical source', () => {
    const root = TEST_HOME;
    const tools = defaultToolsForSource(join(root, 'AGENTS.md'), root);
    // `agents` maps to AGENTS.md, so it must be dropped to avoid self-fan-out.
    expect(tools).not.toContain('agents');
    expect(tools).toContain('claude');
  });
});

describe('renderToolContent per-tool templating', () => {
  const source = [
    '# Rules',
    '{{#if tool == "cursor"}}CURSOR-ONLY{{/if}}',
    '{{#if tool == "claude"}}CLAUDE-ONLY{{/if}}',
  ].join('\n');
  const set = {
    source: '~/AGENTS.md',
    scope: 'home' as const,
    template: true,
    tools: [],
    variables: {},
    added: 'n',
    modified: 'n',
  };

  it('binds `tool` so each variant keeps only its own block', () => {
    const cursor = renderToolContent(source, set, 'cursor', ctx);
    const claude = renderToolContent(source, set, 'claude', ctx);
    expect(cursor).toContain('CURSOR-ONLY');
    expect(cursor).not.toContain('CLAUDE-ONLY');
    expect(claude).toContain('CLAUDE-ONLY');
    expect(claude).not.toContain('CURSOR-ONLY');
  });

  it('returns the source verbatim when template=false', () => {
    const raw = renderToolContent(source, { ...set, template: false }, 'cursor', ctx);
    expect(raw).toBe(source);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// track
// ─────────────────────────────────────────────────────────────────────────────

describe('trackRuleSet', () => {
  it('tracks a home-scoped source with default tools and persists rules.json', async () => {
    vol.writeFileSync(join(TEST_HOME, 'AGENTS.md'), '# Rules\n');
    const { id, set } = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'));

    expect(set.scope).toBe('home');
    expect(set.source).toBe('~/AGENTS.md');
    expect(id).toBe('home__agents.md');
    // Default tools = all except `agents` (its default target is the source).
    expect(set.tools.map((t) => t.tool)).not.toContain('agents');
    expect(set.tools.length).toBe(ALL_TOOLS.length - 1);

    const onDisk = rulesManifestSchema.safeParse(readManifest());
    expect(onDisk.success).toBe(true);
  });

  it('honors an explicit tool list and the symlink strategy', async () => {
    vol.writeFileSync(join(TEST_HOME, 'AGENTS.md'), '# Rules\n');
    const { set } = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), {
      tools: ['claude', 'gemini'],
      strategy: 'symlink',
    });
    expect(set.tools.map((t) => t.tool)).toEqual(['claude', 'gemini']);
    expect(set.tools.every((t) => t.strategy === 'symlink')).toBe(true);
  });

  it('detects repo scope when the source is inside a git tree', async () => {
    const repo = join(TEST_HOME, 'proj');
    vol.mkdirSync(join(repo, '.git'), { recursive: true });
    vol.writeFileSync(join(repo, 'AGENTS.md'), '# Rules\n');
    const { set } = await trackRuleSet(TEST_TUCK_DIR, join(repo, 'AGENTS.md'), {
      tools: ['claude'],
    });
    expect(set.scope).toBe('repo');
    expect(set.repoRoot).toBe(repo);
  });

  it('throws FileNotFound for a missing source', async () => {
    await expect(
      trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'nope.md'))
    ).rejects.toThrow();
  });

  it('re-tracking updates tools but preserves the original added timestamp', async () => {
    vol.writeFileSync(join(TEST_HOME, 'AGENTS.md'), '# Rules\n');
    const first = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), {
      tools: ['claude'],
    });
    const second = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), {
      tools: ['gemini'],
    });
    expect(second.id).toBe(first.id);
    expect(second.set.tools.map((t) => t.tool)).toEqual(['gemini']);
    expect(second.set.added).toBe(first.set.added);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

const trackHome = async (
  content: string,
  opts?: Parameters<typeof trackRuleSet>[2]
): Promise<string> => {
  vol.writeFileSync(join(TEST_HOME, 'AGENTS.md'), content);
  const { id } = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), opts);
  return id;
};

describe('applyRuleSets (materialize)', () => {
  it('creates each tool variant with per-tool rendered content', async () => {
    await trackHome(
      '# R\n{{#if tool == "cursor"}}C{{/if}}{{#if tool == "gemini"}}G{{/if}}\n',
      { tools: ['cursor', 'gemini'] }
    );
    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    const actions = results[0].applied.map((a) => [a.tool, a.action]);
    expect(actions).toEqual([
      ['cursor', 'created'],
      ['gemini', 'created'],
    ]);
    expect(vol.readFileSync(join(TEST_HOME, '.cursorrules'), 'utf-8')).toContain('C');
    expect(vol.readFileSync(join(TEST_HOME, '.cursorrules'), 'utf-8')).not.toContain('G');
    expect(vol.readFileSync(join(TEST_HOME, 'GEMINI.md'), 'utf-8')).toContain('G');
  });

  it('is idempotent: a second apply skips up-to-date variants', async () => {
    await trackHome('# R\n', { tools: ['claude'] });
    await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    const second = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    expect(second[0].applied[0].action).toBe('skipped');
    expect(second[0].applied[0].reason).toBe('up to date');
  });

  it('does not touch a differing variant without consent (non-interactive, no force)', async () => {
    await trackHome('# NEW\n', { tools: ['claude'] });
    vol.writeFileSync(join(TEST_HOME, 'CLAUDE.md'), '# HAND-EDITED\n');
    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx });
    expect(results[0].applied[0].action).toBe('skipped');
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).toBe('# HAND-EDITED\n');
  });

  it('overwrites a differing variant with force, snapshotting first', async () => {
    await trackHome('# NEW\n', { tools: ['claude'] });
    vol.writeFileSync(join(TEST_HOME, 'CLAUDE.md'), '# OLD\n');
    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    expect(results[0].applied[0].action).toBe('updated');
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).toBe('# NEW\n');
  });

  it('overwrites when confirmOverwrite returns true', async () => {
    await trackHome('# NEW\n', { tools: ['claude'] });
    vol.writeFileSync(join(TEST_HOME, 'CLAUDE.md'), '# OLD\n');
    const results = await applyRuleSets(TEST_TUCK_DIR, {
      context: ctx,
      confirmOverwrite: async () => true,
    });
    expect(results[0].applied[0].action).toBe('updated');
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).toBe('# NEW\n');
  });

  it('dry-run writes nothing', async () => {
    await trackHome('# R\n', { tools: ['claude'] });
    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, dryRun: true, force: true });
    expect(results[0].applied[0].action).toBe('created');
    expect(results[0].applied[0].reason).toBe('dry-run');
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(false);
  });

  it('restricts to a single set via id', async () => {
    await trackHome('# R\n', { tools: ['claude'] });
    // A second, repo-scoped set that must NOT be applied.
    const repo = join(TEST_HOME, 'proj');
    vol.mkdirSync(join(repo, '.git'), { recursive: true });
    vol.writeFileSync(join(repo, 'AGENTS.md'), '# repo\n');
    await trackRuleSet(TEST_TUCK_DIR, join(repo, 'AGENTS.md'), { tools: ['gemini'] });

    const results = await applyRuleSets(TEST_TUCK_DIR, {
      context: ctx,
      force: true,
      id: 'home__agents.md',
    });
    expect(results).toHaveLength(1);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(true);
    expect(vol.existsSync(join(repo, 'GEMINI.md'))).toBe(false);
  });

  it('throws when the id does not match any set', async () => {
    await trackHome('# R\n', { tools: ['claude'] });
    await expect(
      applyRuleSets(TEST_TUCK_DIR, { context: ctx, id: 'nope' })
    ).rejects.toThrow(/No tracked rule set/);
  });
});

describe('applyRuleSets (symlink)', () => {
  it('symlinks the variant at the canonical source', async () => {
    await trackHome('# R\n', { tools: ['claude'], strategy: 'symlink' });
    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    expect(results[0].applied[0].action).toBe('symlinked');
    const target = join(TEST_HOME, 'CLAUDE.md');
    expect(vol.lstatSync(target).isSymbolicLink()).toBe(true);
    // Reading through the link yields the source content.
    expect(vol.readFileSync(target, 'utf-8')).toBe('# R\n');
  });

  it('skips an already-correct symlink on re-apply', async () => {
    await trackHome('# R\n', { tools: ['claude'], strategy: 'symlink' });
    await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    const second = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    expect(second[0].applied[0].action).toBe('skipped');
    expect(second[0].applied[0].reason).toBe('already linked');
  });
});

describe('repo-scoped apply writes into the repo root', () => {
  it('materializes variants under the repo, not $HOME', async () => {
    const repo = join(TEST_HOME, 'proj');
    vol.mkdirSync(join(repo, '.git'), { recursive: true });
    vol.writeFileSync(join(repo, 'AGENTS.md'), '# repo rules\n');
    const { id } = await trackRuleSet(TEST_TUCK_DIR, join(repo, 'AGENTS.md'), {
      tools: ['claude', 'copilot'],
    });
    await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true, id });
    expect(vol.readFileSync(join(repo, 'CLAUDE.md'), 'utf-8')).toBe('# repo rules\n');
    // copilot nests under .github/ — the parent dir is created.
    expect(vol.readFileSync(join(repo, '.github', 'copilot-instructions.md'), 'utf-8')).toBe(
      '# repo rules\n'
    );
    // Nothing leaked into $HOME.
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// status / untrack
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSetStatus', () => {
  it('reports missing → in-sync → drift across an edit', async () => {
    const id = await trackHome('# v1\n', { tools: ['claude'] });
    const manifest = await loadRulesManifest(TEST_TUCK_DIR);
    const set = manifest.sets[id];

    let status = await computeSetStatus(set, ctx);
    expect(status.tools[0].status).toBe('missing');

    await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true, id });
    status = await computeSetStatus(set, ctx);
    expect(status.tools[0].status).toBe('in-sync');

    vol.writeFileSync(join(TEST_HOME, 'AGENTS.md'), '# v2 CHANGED\n');
    status = await computeSetStatus(set, ctx);
    expect(status.tools[0].status).toBe('drift');
  });

  it('flags a real file where a symlink is expected as foreign', async () => {
    const id = await trackHome('# R\n', { tools: ['claude'], strategy: 'symlink' });
    vol.writeFileSync(join(TEST_HOME, 'CLAUDE.md'), '# a real file\n');
    const manifest = await loadRulesManifest(TEST_TUCK_DIR);
    const status = await computeSetStatus(manifest.sets[id], ctx);
    expect(status.tools[0].status).toBe('foreign');
  });
});

describe('untrackRuleSet / removeToolVariants', () => {
  it('removes the set from the manifest', async () => {
    const id = await trackHome('# R\n', { tools: ['claude'] });
    const removed = await untrackRuleSet(TEST_TUCK_DIR, id);
    expect(removed).not.toBeNull();
    const manifest = await loadRulesManifest(TEST_TUCK_DIR);
    expect(Object.keys(manifest.sets)).toHaveLength(0);
  });

  it('removeToolVariants deletes generated files', async () => {
    const id = await trackHome('# R\n', { tools: ['claude', 'gemini'] });
    await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true, id });
    const manifest = await loadRulesManifest(TEST_TUCK_DIR);
    const removed = await removeToolVariants(manifest.sets[id]);
    expect(removed).toHaveLength(2);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(false);
    expect(vol.existsSync(join(TEST_HOME, 'GEMINI.md'))).toBe(false);
  });

  it('untrack returns null for an unknown id', async () => {
    expect(await untrackRuleSet(TEST_TUCK_DIR, 'ghost')).toBeNull();
  });
});

describe('ruleSetId / TOOL_TARGETS invariants', () => {
  it('gives home and repo sources distinct id namespaces', () => {
    const home = ruleSetId({ scope: 'home', source: '~/AGENTS.md' });
    expect(home.startsWith('home__')).toBe(true);
  });

  it('maps every tool to a distinct destination', () => {
    const dests = Object.values(TOOL_TARGETS);
    expect(new Set(dests).size).toBe(dests.length);
  });
});
