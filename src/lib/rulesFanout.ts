/**
 * Rules fan-out — one canonical rules/instructions file, many tool variants.
 *
 * A single tracked source (e.g. `AGENTS.md`) is fanned out on demand into every
 * tool-specific file the user's agents look for — CLAUDE.md, .cursorrules,
 * .windsurfrules, copilot-instructions.md, GEMINI.md — either globally ($HOME)
 * or per-repo, with per-tool overrides expressed through tuck's existing
 * template engine (`{{#if tool == "cursor"}}…{{/if}}`).
 *
 * This module owns the data model (`rules.json`), the tool → destination
 * registry, and the pure planning/materialization logic. The `tuck rules`
 * command is a thin wrapper over these functions; the MCP server and tests call
 * them directly.
 *
 * Writes are safe: every destination routes through {@link resolveWriteTarget}
 * so `--root` sandboxing and home/repo confinement are enforced, and existing
 * files that would change are snapshotted (Time Machine) before being touched.
 */

import { join, dirname, basename, relative, resolve, posix } from 'path';
import { readFile, writeFile, lstat, readlink, rm } from 'fs/promises';
import {
  expandPath,
  collapsePath,
  pathExists,
  isDirectory,
  validateSafeSourcePath,
} from './paths.js';
import {
  atomicWriteFile,
  createSymlink,
  ensureDirectory,
  deleteFileOrDir,
} from './files.js';
import { resolveWriteTarget, addKnownRepoRoots, type RepoWriteTarget } from './writeContext.js';
import { renderTemplate, defaultTemplateContext, type TemplateContext } from './template.js';
import { createSnapshot } from './timemachine.js';
import { TuckError, FileNotFoundError } from '../errors.js';
import {
  rulesManifestSchema,
  type RulesManifest,
  type RuleSet,
  type RuleTool,
  type RuleToolName,
} from '../schemas/rules.schema.js';

const RULES_MANIFEST = 'rules.json';

/**
 * Canonical relative destination for each supported tool. Home-scoped sets
 * resolve these against `$HOME`; repo-scoped sets against the repo root. All are
 * POSIX so the stored manifest stays portable across machines.
 */
export const TOOL_TARGETS: Record<RuleToolName, string> = {
  claude: 'CLAUDE.md',
  cursor: '.cursorrules',
  'cursor-dir': '.cursor/rules/tuck.mdc',
  windsurf: '.windsurfrules',
  copilot: '.github/copilot-instructions.md',
  gemini: 'GEMINI.md',
  agents: 'AGENTS.md',
};

/** Human-friendly label per tool, for list/status output. */
export const TOOL_LABELS: Record<RuleToolName, string> = {
  claude: 'Claude Code / Claude Desktop',
  cursor: 'Cursor (.cursorrules)',
  'cursor-dir': 'Cursor (.cursor/rules)',
  windsurf: 'Windsurf',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  agents: 'AGENTS.md',
};

export const ALL_TOOLS = Object.keys(TOOL_TARGETS) as RuleToolName[];

export const isKnownTool = (name: string): name is RuleToolName =>
  Object.prototype.hasOwnProperty.call(TOOL_TARGETS, name);

const rulesManifestPath = (tuckDir: string): string => join(tuckDir, RULES_MANIFEST);

/** Empty (but valid) manifest used when rules.json is absent or unreadable. */
const emptyManifest = (): RulesManifest => ({ version: '1', sets: {} });

/**
 * Load and validate rules.json. A missing file yields an empty manifest; a
 * present-but-invalid file throws so the user is told rather than silently
 * losing their configured sets.
 */
export const loadRulesManifest = async (tuckDir: string): Promise<RulesManifest> => {
  const p = rulesManifestPath(tuckDir);
  if (!(await pathExists(p))) return emptyManifest();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(p, 'utf-8'));
  } catch {
    throw new TuckError(`Corrupt ${RULES_MANIFEST}: not valid JSON`, 'RULES_MANIFEST_CORRUPT', [
      `Fix or delete ${p} and re-run \`tuck rules track\`.`,
    ]);
  }
  const parsed = rulesManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TuckError(`Invalid ${RULES_MANIFEST}`, 'RULES_MANIFEST_INVALID', [
      parsed.error.issues[0]?.message ?? 'schema validation failed',
    ]);
  }
  return parsed.data;
};

export const saveRulesManifest = async (
  tuckDir: string,
  manifest: RulesManifest
): Promise<void> => {
  await writeFile(rulesManifestPath(tuckDir), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
};

const slugifyPath = (p: string): string =>
  p
    .replace(/^~?\/+/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

const repoScopeKey = (repoRoot: string): string =>
  slugifyPath(basename(repoRoot)) + '__' + slugifyPath(repoRoot);

/** Walk up from `start` looking for a `.git` entry; return the repo root or null. */
const findGitRoot = async (start: string): Promise<string | null> => {
  // expandPath, not resolve(): win32 resolve() stamps the host drive letter
  // onto drive-less absolute paths, corrupting the returned repo root.
  let dir = expandPath(start);
  for (let i = 0; i < 64; i++) {
    if (await pathExists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
};

/** Stable id for a rule set (home vs repo, collision-safe across repos). */
export const ruleSetId = (set: Pick<RuleSet, 'scope' | 'source' | 'repoRoot'>): string => {
  if (set.scope === 'home') return `home__${slugifyPath(set.source)}`;
  const rel = relative(set.repoRoot!, expandPath(set.source));
  return `repo__${repoScopeKey(set.repoRoot!)}__${slugifyPath(rel)}`;
};

/** The POSIX relative destination a tool writes to (override or default). */
export const toolRelativePath = (tool: RuleTool): string => {
  const rel = tool.path ?? TOOL_TARGETS[tool.tool];
  return rel.replace(/\\/g, '/');
};

/**
 * The LIVE absolute destination for a tool variant (before sandbox rebasing).
 * Home scope → under `$HOME`; repo scope → under the repo root. Used for status
 * comparisons and display, NOT for writing (writes go through
 * {@link resolveWriteTarget} to honor `--root`).
 */
export const toolLiveTarget = (set: RuleSet, tool: RuleTool): string => {
  const rel = toolRelativePath(tool);
  const root = set.scope === 'home' ? expandPath('~') : set.repoRoot!;
  return join(root, rel);
};

/** Resolve the sandbox-safe write destination for a tool variant. */
const toolWriteTarget = (set: RuleSet, tool: RuleTool): string => {
  const rel = toolRelativePath(tool);
  if (set.scope === 'home') {
    return resolveWriteTarget(posix.join('~', rel));
  }
  const repo: RepoWriteTarget = {
    repoKey: repoScopeKey(set.repoRoot!),
    repoRelative: rel,
    repoRoot: set.repoRoot!,
  };
  return resolveWriteTarget('', repo);
};

/** Absolute path of a set's canonical source (reads always use the real path). */
export const sourceAbsolute = (set: Pick<RuleSet, 'scope' | 'source'>): string =>
  set.scope === 'home' ? expandPath(set.source) : set.source;

/**
 * Choose the default tool set for a newly tracked source: every known tool,
 * except one whose default destination IS the canonical source itself (tracking
 * AGENTS.md should not fan out `agents` → AGENTS.md onto itself).
 */
export const defaultToolsForSource = (
  sourceAbs: string,
  root: string
): RuleToolName[] => {
  const srcResolved = resolve(sourceAbs);
  return ALL_TOOLS.filter((tool) => {
    const targetAbs = resolve(join(root, TOOL_TARGETS[tool]));
    return targetAbs !== srcResolved;
  });
};

export interface TrackOptions {
  /** Tools to fan out to; defaults to every applicable tool. */
  tools?: RuleToolName[];
  /** `symlink` to link instead of render; defaults to `materialize`. */
  strategy?: 'materialize' | 'symlink';
  /** Render the source as a template on materialize (default true). */
  template?: boolean;
  /** Extra template variables. */
  variables?: Record<string, string>;
}

/**
 * Track (or update) a canonical rules file. Records the set in rules.json but
 * writes NO tool variants — that is `tuck rules apply`, which has its own
 * consent + snapshot flow.
 */
export const trackRuleSet = async (
  tuckDir: string,
  inputPath: string,
  opts: TrackOptions = {}
): Promise<{ id: string; set: RuleSet }> => {
  // expandPath handles ~, absolute, and relative inputs WITHOUT stamping the
  // host drive letter onto drive-less absolute paths the way win32 resolve()
  // does (D:\test-home\... breaking home confinement checks on Windows).
  const absPath = expandPath(inputPath);
  if (!(await pathExists(absPath))) throw new FileNotFoundError(inputPath);
  validateSafeSourcePath(absPath);
  if (await isDirectory(absPath)) {
    throw new TuckError(
      'A rules source must be a single file, not a directory',
      'RULES_SOURCE_NOT_FILE',
      ['Point `tuck rules track` at a file like AGENTS.md.']
    );
  }

  const gitRoot = await findGitRoot(dirname(absPath));
  const scope: 'home' | 'repo' = gitRoot ? 'repo' : 'home';
  const repoRoot = gitRoot ?? undefined;
  const root = scope === 'home' ? expandPath('~') : repoRoot!;
  const source = scope === 'home' ? collapsePath(absPath) : absPath;

  const strategy = opts.strategy ?? 'materialize';
  const toolNames =
    opts.tools && opts.tools.length > 0
      ? opts.tools
      : defaultToolsForSource(absPath, root);
  if (toolNames.length === 0) {
    throw new TuckError('No fan-out tools selected', 'RULES_NO_TOOLS', [
      'Pass --tool <name> with at least one target.',
    ]);
  }
  const tools: RuleTool[] = toolNames.map((tool) => ({ tool, strategy }));

  const now = new Date().toISOString();
  const set: RuleSet = {
    source,
    scope,
    repoRoot,
    template: opts.template ?? true,
    tools,
    variables: opts.variables ?? {},
    added: now,
    modified: now,
  };
  const id = ruleSetId(set);

  const manifest = await loadRulesManifest(tuckDir);
  const existing = manifest.sets[id];
  manifest.sets[id] = existing ? { ...set, added: existing.added } : set;
  await saveRulesManifest(tuckDir, manifest);
  return { id, set: manifest.sets[id] };
};

/** Remove a tracked set. Returns the removed set (or null if absent). */
export const untrackRuleSet = async (
  tuckDir: string,
  id: string
): Promise<RuleSet | null> => {
  const manifest = await loadRulesManifest(tuckDir);
  const set = manifest.sets[id];
  if (!set) return null;
  delete manifest.sets[id];
  await saveRulesManifest(tuckDir, manifest);
  return set;
};

// ─────────────────────────────────────────────────────────────────────────────
// Rendering / planning
// ─────────────────────────────────────────────────────────────────────────────

/** Build the per-tool render context: machine vars + set vars + `tool`. */
const renderContextFor = (
  base: TemplateContext,
  set: RuleSet,
  tool: RuleToolName
): TemplateContext => ({ ...base, ...set.variables, tool });

/**
 * The exact content a `materialize` tool variant should hold: the canonical
 * source, rendered through the template engine (when `set.template`) with
 * `tool` bound so per-tool `{{#if tool == …}}` blocks resolve.
 */
export const renderToolContent = (
  sourceText: string,
  set: RuleSet,
  tool: RuleToolName,
  base: TemplateContext
): string => {
  if (!set.template) return sourceText;
  return renderTemplate(sourceText, renderContextFor(base, set, tool));
};

export type ToolStatus = 'missing' | 'in-sync' | 'drift' | 'foreign';

export interface ToolPlan {
  tool: RuleToolName;
  strategy: 'materialize' | 'symlink';
  /** Live (non-sandboxed) destination, for display. */
  target: string;
  status: ToolStatus;
}

export interface SetStatus {
  id: string;
  set: RuleSet;
  /** Whether the canonical source exists on disk. */
  sourceExists: boolean;
  tools: ToolPlan[];
}

/**
 * Compute, without writing anything, the current state of every tool variant in
 * a set: missing / in-sync / drift (materialize) or foreign (a symlink target
 * that is a real file, or vice-versa).
 */
export const computeSetStatus = async (
  set: RuleSet,
  base: TemplateContext
): Promise<Omit<SetStatus, 'id'>> => {
  const srcAbs = sourceAbsolute(set);
  const sourceExists = await pathExists(srcAbs);
  const sourceText = sourceExists ? await readFile(srcAbs, 'utf-8') : '';

  const tools: ToolPlan[] = [];
  for (const tool of set.tools) {
    const target = toolLiveTarget(set, tool);
    const status = await toolStatus(set, tool, target, srcAbs, sourceText, sourceExists, base);
    tools.push({ tool: tool.tool, strategy: tool.strategy, target, status });
  }
  return { set, sourceExists, tools };
};

const toolStatus = async (
  set: RuleSet,
  tool: RuleTool,
  target: string,
  srcAbs: string,
  sourceText: string,
  sourceExists: boolean,
  base: TemplateContext
): Promise<ToolStatus> => {
  const exists = await lstatExists(target);
  if (!exists) return 'missing';

  let link: string | null = null;
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) link = await readlink(target);
  } catch {
    link = null;
  }

  if (tool.strategy === 'symlink') {
    if (link === null) return 'foreign'; // a real file where a symlink is expected
    return resolve(dirname(target), link) === resolve(srcAbs) ? 'in-sync' : 'drift';
  }

  // materialize
  if (link !== null) return 'foreign'; // a symlink where a real file is expected
  if (!sourceExists) return 'drift';
  const expected = renderToolContent(sourceText, set, tool.tool, base);
  const actual = await readFile(target, 'utf-8');
  return actual === expected ? 'in-sync' : 'drift';
};

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyToolResult {
  tool: RuleToolName;
  target: string;
  action: 'created' | 'updated' | 'skipped' | 'symlinked';
  reason?: string;
}

export interface ApplySetResult {
  id: string;
  applied: ApplyToolResult[];
}

export interface ApplyRulesOptions {
  /** Restrict to a single set id. */
  id?: string;
  /** Plan only; write nothing. */
  dryRun?: boolean;
  /** Base template context (built once by the caller). */
  context: TemplateContext;
  /**
   * Confirm overwriting an existing, differing variant. Return true to proceed.
   * Omit for non-interactive: differing files are skipped unless `force`.
   */
  confirmOverwrite?: (target: string) => Promise<boolean>;
  /** Overwrite differing variants without confirming (`--force`). */
  force?: boolean;
}

/**
 * Fan a set (or all sets) out to disk. Existing files that would change are
 * first captured in a Time Machine snapshot; a variant that already matches is
 * left untouched. Foreign/differing files are only overwritten with consent
 * (interactive confirm) or `--force`; otherwise they are skipped and reported.
 */
export const applyRuleSets = async (
  tuckDir: string,
  opts: ApplyRulesOptions
): Promise<ApplySetResult[]> => {
  const manifest = await loadRulesManifest(tuckDir);
  let entries = Object.entries(manifest.sets);
  if (opts.id) {
    entries = entries.filter(([id]) => id === opts.id);
    if (entries.length === 0) {
      throw new TuckError(`No tracked rule set with id "${opts.id}"`, 'RULES_SET_NOT_FOUND', [
        'Run `tuck rules list` to see tracked sets.',
      ]);
    }
  }

  // Register repo roots so repo-scoped writes pass destination validation.
  const repoRoots = entries
    .map(([, s]) => s.repoRoot)
    .filter((r): r is string => typeof r === 'string');
  if (repoRoots.length > 0) addKnownRepoRoots(repoRoots);

  const results: ApplySetResult[] = [];
  for (const [id, set] of entries) {
    results.push(await applyOneSet(id, set, opts));
  }
  return results;
};

const applyOneSet = async (
  id: string,
  set: RuleSet,
  opts: ApplyRulesOptions
): Promise<ApplySetResult> => {
  const srcAbs = sourceAbsolute(set);
  if (!(await pathExists(srcAbs))) {
    throw new FileNotFoundError(set.source);
  }
  const sourceText = await readFile(srcAbs, 'utf-8');

  // Pre-plan so we can snapshot everything that will change in one shot.
  interface Planned {
    tool: RuleTool;
    writeTarget: string;
    liveTarget: string;
    expected: string | null; // materialize only
  }
  const planned: Planned[] = [];
  const toSnapshot: string[] = [];

  for (const tool of set.tools) {
    const writeTarget = toolWriteTarget(set, tool);
    const liveTarget = toolLiveTarget(set, tool);
    const expected =
      tool.strategy === 'materialize'
        ? renderToolContent(sourceText, set, tool.tool, opts.context)
        : null;
    planned.push({ tool, writeTarget, liveTarget, expected });
    // Snapshot EVERY planned destination — createSnapshot records missing
    // paths as existed:false, which is what lets `tuck undo` REMOVE variants
    // a create-only apply produced (a pre-existing-only snapshot made the
    // printed undo breadcrumb a lie).
    toSnapshot.push(writeTarget);
  }

  if (!opts.dryRun && toSnapshot.length > 0) {
    // A failed snapshot aborts the apply (same policy as sync/apply): never
    // mutate files without a recovery point.
    await createSnapshot(toSnapshot, `Pre rules-apply backup for ${id}`);
  }

  const applied: ApplyToolResult[] = [];
  for (const p of planned) {
    applied.push(await applyOneTool(p.tool, p.writeTarget, p.liveTarget, p.expected, srcAbs, opts));
  }
  return { id, applied };
};

const applyOneTool = async (
  tool: RuleTool,
  writeTarget: string,
  liveTarget: string,
  expected: string | null,
  srcAbs: string,
  opts: ApplyRulesOptions
): Promise<ApplyToolResult> => {
  const exists = await lstatExists(writeTarget);

  // Inspect the existing entry's link-ness once.
  let isLink = false;
  let linkDest: string | null = null;
  if (exists) {
    try {
      const st = await lstat(writeTarget);
      if (st.isSymbolicLink()) {
        isLink = true;
        linkDest = await readlink(writeTarget);
      }
    } catch {
      isLink = false;
    }
  }

  if (tool.strategy === 'symlink') {
    const desired = resolve(srcAbs);
    if (exists && isLink && linkDest !== null && resolve(dirname(writeTarget), linkDest) === desired) {
      return { tool: tool.tool, target: liveTarget, action: 'skipped', reason: 'already linked' };
    }
    if (exists && !(await allowOverwrite(liveTarget, opts))) {
      return { tool: tool.tool, target: liveTarget, action: 'skipped', reason: 'exists (declined)' };
    }
    if (opts.dryRun) return { tool: tool.tool, target: liveTarget, action: 'symlinked', reason: 'dry-run' };
    await createSymlink(collapsePath(srcAbs), writeTarget, { overwrite: true });
    return { tool: tool.tool, target: liveTarget, action: 'symlinked' };
  }

  // materialize
  const content = expected ?? '';
  if (exists && !isLink) {
    const actual = await readFile(writeTarget, 'utf-8').catch(() => null);
    if (actual === content) {
      return { tool: tool.tool, target: liveTarget, action: 'skipped', reason: 'up to date' };
    }
    if (!(await allowOverwrite(liveTarget, opts))) {
      return { tool: tool.tool, target: liveTarget, action: 'skipped', reason: 'differs (declined)' };
    }
  } else if (exists && isLink) {
    // A symlink where we want a real file — replacing it is a change; gate it.
    if (!(await allowOverwrite(liveTarget, opts))) {
      return { tool: tool.tool, target: liveTarget, action: 'skipped', reason: 'symlink (declined)' };
    }
    if (!opts.dryRun) await deleteFileOrDir(writeTarget);
  }

  if (opts.dryRun) {
    return { tool: tool.tool, target: liveTarget, action: exists ? 'updated' : 'created', reason: 'dry-run' };
  }
  await ensureDirectory(dirname(writeTarget));
  await atomicWriteFile(writeTarget, content);
  return { tool: tool.tool, target: liveTarget, action: exists ? 'updated' : 'created' };
};

/** Consent gate for overwriting an existing variant. */
const allowOverwrite = async (
  target: string,
  opts: ApplyRulesOptions
): Promise<boolean> => {
  if (opts.force) return true;
  if (opts.confirmOverwrite) return opts.confirmOverwrite(target);
  return false;
};

/** Delete every generated variant for a set (used by `untrack --clean`). */
/**
 * Link-aware existence: a DANGLING symlink still counts as existing (exactly
 * the state a symlink-strategy apply leaves behind if the canonical source is
 * later moved) — pathExists follows links and would report it missing, making
 * overwrite/cleanup logic crash or skip.
 */
const lstatExists = async (p: string): Promise<boolean> => {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
};

/** Write targets of a set's variants that currently exist on disk (link-aware). */
export const listExistingToolVariants = async (set: RuleSet): Promise<string[]> => {
  const out: string[] = [];
  for (const tool of set.tools) {
    const writeTarget = toolWriteTarget(set, tool);
    if (await lstatExists(writeTarget)) out.push(writeTarget);
  }
  return out;
};

export const removeToolVariants = async (
  set: RuleSet,
  opts: { dryRun?: boolean } = {}
): Promise<string[]> => {
  const removed: string[] = [];
  for (const tool of set.tools) {
    const writeTarget = toolWriteTarget(set, tool);
    if (!(await lstatExists(writeTarget))) continue;
    removed.push(toolLiveTarget(set, tool));
    if (!opts.dryRun) await rm(writeTarget, { force: true }).catch(() => undefined);
  }
  return removed;
};

/** Build the render context once per command (machine vars + config vars). */
export const buildRulesContext = async (tuckDir: string): Promise<TemplateContext> => {
  try {
    const { loadConfig } = await import('./config.js');
    const config = await loadConfig(tuckDir);
    return defaultTemplateContext(config?.templates?.variables ?? {});
  } catch {
    return defaultTemplateContext({});
  }
};
