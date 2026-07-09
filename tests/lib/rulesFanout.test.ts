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
  saveRulesManifest,
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
import type { RuleSet } from '../../src/schemas/rules.schema.js';
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
    const { removed } = await removeToolVariants(manifest.sets[id]);
    expect(removed).toHaveLength(2);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(false);
    expect(vol.existsSync(join(TEST_HOME, 'GEMINI.md'))).toBe(false);
  });

  it('untrack returns null for an unknown id', async () => {
    expect(await untrackRuleSet(TEST_TUCK_DIR, 'ghost')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: verified code-review findings
// ─────────────────────────────────────────────────────────────────────────────

describe('trackRuleSet self-target rejection (explicit --tool)', () => {
  it('rejects materializing a tool onto its own canonical source', async () => {
    vol.writeFileSync(join(TEST_HOME, 'AGENTS.md'), '# canonical\n');
    // `agents` maps to AGENTS.md — fanning it onto AGENTS.md would clobber it.
    await expect(
      trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), { tools: ['agents'] })
    ).rejects.toThrow(/canonical source itself/);
    // Nothing tracked, source untouched.
    expect(vol.existsSync(join(TEST_TUCK_DIR, 'rules.json'))).toBe(false);
    expect(vol.readFileSync(join(TEST_HOME, 'AGENTS.md'), 'utf-8')).toBe('# canonical\n');
  });

  it('rejects symlinking a tool onto its own canonical source', async () => {
    vol.writeFileSync(join(TEST_HOME, 'CLAUDE.md'), '# canonical\n');
    await expect(
      trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'CLAUDE.md'), {
        tools: ['claude'],
        strategy: 'symlink',
      })
    ).rejects.toThrow(/canonical source itself/);
    // The source is not turned into a self-referencing symlink.
    expect(vol.lstatSync(join(TEST_HOME, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).toBe('# canonical\n');
  });
});

describe('re-track cleans up variants of dropped tools', () => {
  it('removes the dropped tool variant when consent is given (force)', async () => {
    const id = await trackHome('# R\n', { tools: ['claude', 'gemini'] });
    await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true, id });
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(true);
    expect(vol.existsSync(join(TEST_HOME, 'GEMINI.md'))).toBe(true);

    const res = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), {
      tools: ['claude'],
      force: true,
    });
    expect(res.orphansRemoved).toHaveLength(1);
    expect(res.orphansSkipped).toHaveLength(0);
    // Dropped tool's variant gone; retained tool's variant untouched.
    expect(vol.existsSync(join(TEST_HOME, 'GEMINI.md'))).toBe(false);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(true);
  });

  it('leaves the orphan in place (reported) when non-interactive without consent', async () => {
    const id = await trackHome('# R\n', { tools: ['claude', 'gemini'] });
    await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true, id });

    const res = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), {
      tools: ['claude'],
    });
    expect(res.orphansRemoved).toHaveLength(0);
    expect(res.orphansSkipped).toHaveLength(1);
    expect(vol.existsSync(join(TEST_HOME, 'GEMINI.md'))).toBe(true);
  });

  it('never deletes a foreign variant of a dropped tool, even with consent', async () => {
    await trackHome('# R\n', { tools: ['claude', 'gemini'] });
    // A symlink where a materialized GEMINI.md is expected → status 'foreign'
    // (clearly not a file tuck generated), so cleanup must preserve it.
    vol.writeFileSync(join(TEST_HOME, 'other.md'), '# elsewhere\n');
    vol.symlinkSync(join(TEST_HOME, 'other.md'), join(TEST_HOME, 'GEMINI.md'));
    const res = await trackRuleSet(TEST_TUCK_DIR, join(TEST_HOME, 'AGENTS.md'), {
      tools: ['claude'],
      force: true, // even WITH consent, a foreign entry is preserved
    });
    expect(res.orphansRemoved).toHaveLength(0);
    expect(res.orphansSkipped).toContain(join(TEST_HOME, 'GEMINI.md'));
    expect(vol.lstatSync(join(TEST_HOME, 'GEMINI.md')).isSymbolicLink()).toBe(true);
  });
});

describe('applyRuleSets per-set error isolation', () => {
  const injectBadRepoSet = async (id: string, repoRoot: string): Promise<void> => {
    const manifest = await loadRulesManifest(TEST_TUCK_DIR);
    const bad: RuleSet = {
      source: join(repoRoot, 'AGENTS.md'),
      scope: 'repo',
      repoRoot,
      template: true,
      tools: [{ tool: 'gemini', strategy: 'materialize' }],
      variables: {},
      added: 'n',
      modified: 'n',
    };
    manifest.sets[id] = bad;
    await saveRulesManifest(TEST_TUCK_DIR, manifest);
  };

  it('applies a valid home set even when another set has a missing repoRoot', async () => {
    await trackHome('# home\n', { tools: ['claude'] });
    await injectBadRepoSet('repo__missing', '/no/such/repo');

    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    const home = results.find((r) => r.id === 'home__agents.md');
    const bad = results.find((r) => r.id === 'repo__missing');
    expect(home?.applied[0]?.action).toBe('created');
    expect(bad?.error).toBeTruthy();
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(true);
  });

  it('rejects repoRoot "/" and a non-git directory, writing nothing for them', async () => {
    await trackHome('# home\n', { tools: ['claude'] });
    await injectBadRepoSet('repo__root', '/');
    vol.mkdirSync(join(TEST_HOME, 'plaindir'), { recursive: true });
    await injectBadRepoSet('repo__nogit', join(TEST_HOME, 'plaindir'));

    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true });
    const rootSet = results.find((r) => r.id === 'repo__root');
    const nogit = results.find((r) => r.id === 'repo__nogit');
    expect(rootSet?.error).toMatch(/too broad|root/i);
    expect(nogit?.error).toMatch(/git/i);
    // No variant leaked into "/" or the non-git dir; the valid set still applied.
    expect(vol.existsSync(join(TEST_HOME, 'plaindir', 'GEMINI.md'))).toBe(false);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(true);
  });

  it('accepts a genuine git repoRoot', async () => {
    const repo = join(TEST_HOME, 'proj');
    vol.mkdirSync(join(repo, '.git'), { recursive: true });
    vol.writeFileSync(join(repo, 'AGENTS.md'), '# repo\n');
    const { id } = await trackRuleSet(TEST_TUCK_DIR, join(repo, 'AGENTS.md'), {
      tools: ['gemini'],
    });
    const results = await applyRuleSets(TEST_TUCK_DIR, { context: ctx, force: true, id });
    expect(results[0].error).toBeUndefined();
    expect(vol.existsSync(join(repo, 'GEMINI.md'))).toBe(true);
  });
});

describe('applyRuleSets dry-run never prompts', () => {
  it('does not call confirmOverwrite for a differing materialize variant', async () => {
    await trackHome('# NEW\n', { tools: ['claude'] });
    vol.writeFileSync(join(TEST_HOME, 'CLAUDE.md'), '# OLD\n');
    let prompted = false;
    const results = await applyRuleSets(TEST_TUCK_DIR, {
      context: ctx,
      dryRun: true,
      confirmOverwrite: async () => {
        prompted = true;
        return true;
      },
    });
    expect(prompted).toBe(false);
    expect(results[0].applied[0].action).toBe('skipped');
    expect(results[0].applied[0].reason).toBe('would prompt to overwrite');
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).toBe('# OLD\n');
  });

  it('does not call confirmOverwrite for a symlink variant replacing a real file', async () => {
    await trackHome('# R\n', { tools: ['claude'], strategy: 'symlink' });
    vol.writeFileSync(join(TEST_HOME, 'CLAUDE.md'), '# real\n');
    let prompted = false;
    const results = await applyRuleSets(TEST_TUCK_DIR, {
      context: ctx,
      dryRun: true,
      confirmOverwrite: async () => {
        prompted = true;
        return true;
      },
    });
    expect(prompted).toBe(false);
    expect(results[0].applied[0].action).toBe('skipped');
    expect(results[0].applied[0].reason).toBe('would prompt to overwrite');
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).toBe('# real\n');
  });
});

describe('computeSetStatus survives an unreadable variant', () => {
  it('reports a directory at the variant path as foreign instead of throwing', async () => {
    const id = await trackHome('# R\n', { tools: ['claude'] });
    // A directory where a materialized file is expected → readFile would EISDIR.
    vol.mkdirSync(join(TEST_HOME, 'CLAUDE.md'), { recursive: true });
    const manifest = await loadRulesManifest(TEST_TUCK_DIR);
    const status = await computeSetStatus(manifest.sets[id], ctx);
    expect(status.tools[0].status).toBe('foreign');
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
