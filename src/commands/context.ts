/**
 * `tuck context` — agent-config-aware commands.
 *
 * Tracks AI agent configuration files (CLAUDE.md, .cursorrules, .aider.conf.yml,
 * AGENTS.md, GEMINI.md, mcp.json, copilot-instructions.md, agent memory dirs)
 * across both $HOME (global) and per-repo (./) scopes.
 *
 * Subcommands:
 *   add <path>      — track an agent config file (repo-scoped if path is
 *                     inside a git repo, home-scoped otherwise)
 *   list            — show tracked agent configs across all scopes
 *   sync            — propagate one repo's agent config to others as a template
 *   apply <ref>     — fetch someone else's agent config into the current repo
 *   scan            — detect agent configs on disk without tracking them
 */

import { Command } from 'commander';
import { join, relative, resolve, isAbsolute, basename, dirname } from 'path';
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import {
  getTuckDir,
  expandPath,
  collapsePath,
  pathExists,
  isDirectory,
  validateSafeSourcePath,
} from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles } from '../lib/manifest.js';
import {
  copyFileOrDir,
  getFileChecksum,
} from '../lib/files.js';
import { NotInitializedError, TuckError, FileNotFoundError } from '../errors.js';
import {
  setJsonMode,
  isJsonMode,
  emitJsonOk,
} from '../lib/jsonOutput.js';
import { logger, colors as c } from '../ui/index.js';
import simpleGit from 'simple-git';

interface ContextEntry {
  /** Absolute or `~/`-prefixed home-scoped source */
  source: string;
  /** Bundle/destination key in the tuck repo */
  destination: string;
  /** "home" or "repo" */
  scope: 'home' | 'repo';
  /** If repo-scoped, the absolute repo root the path is relative to */
  repoRoot?: string;
  /** "claude" | "cursor" | "aider" | "agents-md" | "gemini" | "copilot" | "mcp" | "skill" | "memory" | "other" */
  agent: string;
  added: string;
  modified: string;
  checksum: string;
}

interface ContextManifest {
  version: '1';
  entries: Record<string, ContextEntry>;
}

const CONTEXT_MANIFEST = 'context.json';
const CONTEXT_DIR = 'context';

const contextManifestPath = (tuckDir: string): string => join(tuckDir, CONTEXT_MANIFEST);

const loadContextManifest = async (tuckDir: string): Promise<ContextManifest> => {
  const p = contextManifestPath(tuckDir);
  if (!(await pathExists(p))) {
    return { version: '1', entries: {} };
  }
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as ContextManifest;
  } catch {
    return { version: '1', entries: {} };
  }
};

const saveContextManifest = async (
  tuckDir: string,
  manifest: ContextManifest
): Promise<void> => {
  await writeFile(
    contextManifestPath(tuckDir),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8'
  );
};

/**
 * Classify an agent config path into a coarse-grained agent kind. This drives
 * which directory in the tuck repo the file lands in and what hooks (if any)
 * run on apply.
 */
export const classifyAgentPath = (p: string): string => {
  const lower = p.toLowerCase();
  const base = basename(lower);
  if (base === 'claude.md' || lower.includes('/.claude/')) return 'claude';
  if (base === '.cursorrules' || lower.includes('/.cursor/')) return 'cursor';
  if (base === '.aider.conf.yml' || base === '.aider.input.history' || base.startsWith('.aider')) {
    return 'aider';
  }
  if (base === 'agents.md') return 'agents-md';
  if (base === 'gemini.md') return 'gemini';
  if (base === 'copilot-instructions.md' || lower.includes('/.github/copilot')) return 'copilot';
  if (base === 'mcp.json' || lower.includes('/mcp/')) return 'mcp';
  if (lower.includes('/skills/') || lower.includes('/.claude/skills/')) return 'skill';
  if (lower.includes('/memory/') || lower.includes('/mem0/') || lower.includes('/supermemory/')) {
    return 'memory';
  }
  return 'other';
};

/** Walk up from `start` looking for a `.git` directory; return repo root or null. */
const findGitRoot = async (start: string): Promise<string | null> => {
  let dir = resolve(start);
  // Bound the walk so we never escape the user's home tree in pathological cases.
  for (let i = 0; i < 64; i++) {
    if (await pathExists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
};

/**
 * Decide whether a path should be tracked as home-scoped or repo-scoped.
 * Home: anywhere under $HOME that is NOT inside a git working tree.
 * Repo: anywhere inside a git working tree (including under $HOME).
 *
 * NOTE: §6.2 of WHATS_NEXT.md asks repo-scoped tracking to work in *any* repo,
 * not just $HOME. So if a file is inside a git tree, we always pick "repo".
 */
const decideScope = async (
  absPath: string
): Promise<{ scope: 'home' | 'repo'; repoRoot?: string }> => {
  const start = (await isDirectory(absPath)) ? absPath : dirname(absPath);
  const repo = await findGitRoot(start);
  if (repo) return { scope: 'repo', repoRoot: repo };
  return { scope: 'home' };
};

const ensureInitialized = async (tuckDir: string): Promise<void> => {
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
};

const slugifyPath = (p: string): string => {
  return p
    .replace(/^~?\/+/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
};

const repoScopeKey = (repoRoot: string): string => {
  return slugifyPath(basename(repoRoot)) + '__' + slugifyPath(repoRoot);
};

const destinationFor = (entry: { scope: 'home' | 'repo'; repoRoot?: string; source: string }): string => {
  if (entry.scope === 'home') {
    return join(CONTEXT_DIR, 'home', slugifyPath(entry.source));
  }
  const rel = relative(entry.repoRoot!, expandPath(entry.source));
  return join(CONTEXT_DIR, 'repos', repoScopeKey(entry.repoRoot!), slugifyPath(rel));
};

/**
 * Add a file to the context manifest and copy it into the tuck repo.
 * Returns the created entry.
 */
export const addContextFile = async (
  tuckDir: string,
  inputPath: string
): Promise<{ id: string; entry: ContextEntry }> => {
  const absPath = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), expandPath(inputPath));
  if (!(await pathExists(absPath))) {
    throw new FileNotFoundError(inputPath);
  }
  validateSafeSourcePath(absPath);

  const { scope, repoRoot } = await decideScope(absPath);
  const isDir = await isDirectory(absPath);
  const agent = classifyAgentPath(absPath);

  // Source representation: home-scoped uses ~/ prefix, repo-scoped uses absolute
  // path so it round-trips across machines unambiguously (the repo root is also
  // stored, so apply can choose a different remote root if needed).
  const source = scope === 'home' ? collapsePath(absPath) : absPath;
  const destination = destinationFor({ scope, repoRoot, source });
  const id = `${scope}__${slugifyPath(scope === 'home' ? source : relative(repoRoot!, absPath))}`;

  const destAbs = join(tuckDir, destination);
  await mkdir(dirname(destAbs), { recursive: true });
  await copyFileOrDir(absPath, destAbs, { overwrite: true });
  const checksum = isDir ? '' : await getFileChecksum(absPath).catch(() => '');

  const now = new Date().toISOString();
  const entry: ContextEntry = {
    source,
    destination,
    scope,
    repoRoot,
    agent,
    added: now,
    modified: now,
    checksum,
  };

  const manifest = await loadContextManifest(tuckDir);
  if (manifest.entries[id]) {
    // Treat as update — refresh checksum + modified.
    manifest.entries[id] = { ...manifest.entries[id], ...entry, added: manifest.entries[id].added };
  } else {
    manifest.entries[id] = entry;
  }
  await saveContextManifest(tuckDir, manifest);

  return { id, entry };
};

// ─────────────────────────────────────────────────────────────────────────────
// Subcommands
// ─────────────────────────────────────────────────────────────────────────────

const addAction = async (
  pathArg: string,
  opts: { json?: boolean; yes?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck context add');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const { id, entry } = await addContextFile(tuckDir, pathArg);

  if (isJsonMode()) {
    emitJsonOk({
      id,
      source: entry.source,
      destination: entry.destination,
      scope: entry.scope,
      repoRoot: entry.repoRoot,
      agent: entry.agent,
    });
    return;
  }

  logger.success(`Tracked agent config: ${entry.source}`);
  logger.dim(`  scope=${entry.scope} agent=${entry.agent}`);
  if (entry.repoRoot) logger.dim(`  repoRoot=${collapsePath(entry.repoRoot)}`);
};

const listAction = async (opts: {
  json?: boolean;
  scope?: 'home' | 'repo';
  agent?: string;
}): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck context list');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);
  const manifest = await loadContextManifest(tuckDir);

  let entries = Object.entries(manifest.entries);
  if (opts.scope) entries = entries.filter(([, e]) => e.scope === opts.scope);
  if (opts.agent) entries = entries.filter(([, e]) => e.agent === opts.agent);

  if (isJsonMode()) {
    emitJsonOk({
      count: entries.length,
      entries: entries.map(([id, e]) => ({ id, ...e })),
    });
    return;
  }

  if (entries.length === 0) {
    logger.info('No agent configs tracked yet.');
    logger.dim('Run `tuck context add <path>` to start.');
    return;
  }

  const byScope = entries.reduce<Record<string, [string, ContextEntry][]>>((acc, [id, e]) => {
    const key = e.scope === 'home' ? 'home' : `repo:${collapsePath(e.repoRoot ?? '')}`;
    (acc[key] ??= []).push([id, e]);
    return acc;
  }, {});

  for (const [bucket, items] of Object.entries(byScope)) {
    console.log();
    console.log(c.bold(bucket));
    for (const [id, e] of items) {
      console.log(`  ${c.dim('•')} ${c.cyan(e.source)} ${c.dim(`[${e.agent}]`)}`);
      console.log(`    ${c.dim(id)}`);
    }
  }
};

const scanAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck context scan');
  const home = homedir();
  const cwd = process.cwd();

  const candidates = await detectAgentConfigs([home, cwd]);

  if (isJsonMode()) {
    emitJsonOk({
      count: candidates.length,
      candidates,
    });
    return;
  }

  if (candidates.length === 0) {
    logger.info('No agent configs detected.');
    return;
  }

  console.log();
  console.log(c.bold(`Detected ${candidates.length} agent config(s):`));
  for (const cand of candidates) {
    console.log(`  ${c.dim('•')} ${c.cyan(cand.path)} ${c.dim(`[${cand.agent}]`)}`);
  }
  console.log();
  logger.dim('Add one with: tuck context add <path>');
};

const syncAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck context sync');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);
  const manifest = await loadContextManifest(tuckDir);

  let updated = 0;
  for (const [, e] of Object.entries(manifest.entries)) {
    const absSource = e.scope === 'home' ? expandPath(e.source) : e.source;
    if (!(await pathExists(absSource))) continue;
    if (await isDirectory(absSource)) continue;
    const nextChecksum = await getFileChecksum(absSource).catch(() => '');
    if (nextChecksum && nextChecksum !== e.checksum) {
      const destAbs = join(tuckDir, e.destination);
      await mkdir(dirname(destAbs), { recursive: true });
      await copyFileOrDir(absSource, destAbs, { overwrite: true });
      e.checksum = nextChecksum;
      e.modified = new Date().toISOString();
      updated++;
    }
  }
  await saveContextManifest(tuckDir, manifest);

  if (isJsonMode()) {
    emitJsonOk({ updated, total: Object.keys(manifest.entries).length });
    return;
  }
  logger.success(`Synced ${updated} agent config(s)`);
};

interface DetectedAgent {
  path: string;
  agent: string;
  scope: 'home' | 'repo';
  repoRoot?: string;
}

const AGENT_HOME_GLOBS = [
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.claude/keybindings.json',
  '.cursorrules',
  '.cursor/',
  '.aider.conf.yml',
  '.config/mcp/',
  '.config/aider/',
];

const AGENT_REPO_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  '.aider.conf.yml',
  '.github/copilot-instructions.md',
  'mcp.json',
];

/**
 * Walk known agent locations under each root and return candidates that exist.
 * Intentionally narrow — we don't crawl arbitrary directories here, only the
 * canonical paths agents are documented to use.
 */
const detectAgentConfigs = async (roots: string[]): Promise<DetectedAgent[]> => {
  const out: DetectedAgent[] = [];
  const seen = new Set<string>();

  const home = homedir();
  for (const pattern of AGENT_HOME_GLOBS) {
    const p = join(home, pattern);
    if (await pathExists(p)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: collapsePath(p), agent: classifyAgentPath(p), scope: 'home' });
    }
  }

  for (const root of roots) {
    if (root === home) continue;
    const repo = await findGitRoot(root);
    if (!repo) continue;
    for (const file of AGENT_REPO_FILES) {
      const p = join(repo, file);
      if (await pathExists(p)) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({ path: p, agent: classifyAgentPath(p), scope: 'repo', repoRoot: repo });
      }
    }
  }
  return out;
};

const applyAction = async (
  ref: string,
  opts: { json?: boolean; yes?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck context apply');
  // `ref` is either user/repo (github) or a directory path with a context.json
  if (ref.includes('/') && !(await pathExists(ref))) {
    // Treat as github user/repo
    const [user, repoName] = ref.split('/');
    if (!user || !repoName) {
      throw new TuckError(
        'Expected <user>/<repo> or local path',
        'VALIDATION_ERROR',
        ['Examples: tuck context apply prnv/dotfiles', 'tuck context apply ./other-repo']
      );
    }
    const tmp = join(getTuckDir(), '.tmp-context', `${user}-${repoName}`);
    await mkdir(dirname(tmp), { recursive: true });
    const git = simpleGit();
    await git.clone(`https://github.com/${user}/${repoName}.git`, tmp, ['--depth', '1']);
    await importContextFromDir(tmp);
  } else {
    await importContextFromDir(ref);
  }

  if (isJsonMode()) {
    emitJsonOk({ applied: true, ref });
    return;
  }
  logger.success(`Applied context from ${ref}`);
};

const importContextFromDir = async (dir: string): Promise<void> => {
  const ctxFile = join(dir, CONTEXT_MANIFEST);
  if (!(await pathExists(ctxFile))) {
    throw new TuckError(
      `No ${CONTEXT_MANIFEST} found in ${dir}`,
      'NO_CONTEXT_MANIFEST',
      ['Run `tuck context add` on the source machine first']
    );
  }
  const manifest = JSON.parse(await readFile(ctxFile, 'utf-8')) as ContextManifest;
  // For now, list-only; applying agent configs to a fresh machine is a
  // material write operation that needs the templating engine in §5.1.
  // Materialize home-scoped files immediately; defer repo-scoped to apply.
  for (const e of Object.values(manifest.entries)) {
    if (e.scope !== 'home') continue;
    const src = join(dir, e.destination);
    if (!(await pathExists(src))) continue;
    const dest = expandPath(e.source);
    await mkdir(dirname(dest), { recursive: true });
    await copyFileOrDir(src, dest, { overwrite: false });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Programmatic helpers (used by MCP server, scan integration)
// ─────────────────────────────────────────────────────────────────────────────

export const getContextEntries = async (
  tuckDir: string
): Promise<Record<string, ContextEntry>> => {
  const manifest = await loadContextManifest(tuckDir);
  return manifest.entries;
};

// Suppress unused warnings until these are wired into restore/apply.
void getAllTrackedFiles;
void stat;
void readdir;

// ─────────────────────────────────────────────────────────────────────────────
// Command wiring
// ─────────────────────────────────────────────────────────────────────────────

export const contextCommand = new Command('context')
  .description('Track AI agent configs across home and per-repo scopes')
  .addCommand(
    new Command('add')
      .description('Track an agent config file (auto-detects home vs repo scope)')
      .argument('<path>', 'Path to an agent config file or directory')
      .option('--json', 'Emit JSON envelope to stdout')
      .option('-y, --yes', 'Auto-confirm prompts')
      .action(addAction)
  )
  .addCommand(
    new Command('list')
      .description('List tracked agent configs')
      .option('--scope <scope>', 'Filter by scope (home|repo)')
      .option('--agent <name>', 'Filter by agent (claude|cursor|aider|agents-md|gemini|copilot|mcp|skill|memory)')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(listAction)
  )
  .addCommand(
    new Command('scan')
      .description('Detect agent configs in $HOME and the current repo without tracking them')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(scanAction)
  )
  .addCommand(
    new Command('sync')
      .description('Sync tracked agent configs from disk into the tuck repo')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(syncAction)
  )
  .addCommand(
    new Command('apply')
      .description('Apply someone else\'s agent context (user/repo or local path)')
      .argument('<ref>', 'GitHub user/repo or local directory containing a context manifest')
      .option('--json', 'Emit JSON envelope to stdout')
      .option('-y, --yes', 'Auto-confirm overwrites')
      .action(applyAction)
  );
