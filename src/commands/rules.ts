/**
 * `tuck rules` — rules fan-out (one canonical AGENTS.md, many tool files).
 *
 * Track a single canonical rules/instructions file and fan it out on demand
 * into every tool-specific variant your agents look for (CLAUDE.md, .cursorrules,
 * .windsurfrules, copilot-instructions.md, GEMINI.md, .cursor/rules), globally
 * or per-repo, with per-tool overrides via tuck's template engine. See §1.4.
 *
 * Subcommands:
 *   track <path>   — designate a canonical rules file and its fan-out targets
 *   list           — show tracked sets and per-tool sync status
 *   apply          — materialize/symlink each variant (snapshots + confirms)
 *   untrack <id>   — stop tracking a set (optionally deleting generated files)
 */

import { Command } from 'commander';
import { getTuckDir, collapsePath } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { NotInitializedError, TuckError } from '../errors.js';
import {
  setJsonMode,
  isJsonMode,
  emitJsonOk,
} from '../lib/jsonOutput.js';
import { logger, prompts, colors as c } from '../ui/index.js';
import {
  trackRuleSet,
  untrackRuleSet,
  loadRulesManifest,
  applyRuleSets,
  computeSetStatus,
  buildRulesContext,
  removeToolVariants,
  isKnownTool,
  TOOL_LABELS,
  ALL_TOOLS,
  type ToolStatus,
  listExistingToolVariants,
} from '../lib/rulesFanout.js';
import { createSnapshot } from '../lib/timemachine.js';
import type { RuleToolName } from '../schemas/rules.schema.js';

const ensureInitialized = async (tuckDir: string): Promise<void> => {
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
};

/** Parse a repeatable/comma-separated `--tool` option into known tool names. */
const parseTools = (raw: string[] | undefined): RuleToolName[] => {
  if (!raw || raw.length === 0) return [];
  const names = raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  const out: RuleToolName[] = [];
  for (const n of names) {
    if (!isKnownTool(n)) {
      throw new TuckError(`Unknown tool "${n}"`, 'RULES_UNKNOWN_TOOL', [
        `Known tools: ${ALL_TOOLS.join(', ')}`,
      ]);
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
};

/** Parse repeatable `--var k=v` into a flat record. */
const parseVars = (raw: string[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of raw ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new TuckError(`Invalid --var "${entry}" (expected key=value)`, 'RULES_BAD_VAR');
    }
    out[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// track
// ─────────────────────────────────────────────────────────────────────────────

interface TrackOpts {
  json?: boolean;
  tool?: string[];
  symlink?: boolean;
  template?: boolean; // commander `--no-template` sets this false
  var?: string[];
}

const trackAction = async (pathArg: string, opts: TrackOpts): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck rules track');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const { id, set } = await trackRuleSet(tuckDir, pathArg, {
    tools: parseTools(opts.tool),
    strategy: opts.symlink ? 'symlink' : 'materialize',
    template: opts.template,
    variables: parseVars(opts.var),
  });

  if (isJsonMode()) {
    emitJsonOk({
      id,
      source: set.source,
      scope: set.scope,
      repoRoot: set.repoRoot,
      template: set.template,
      tools: set.tools.map((t) => ({ tool: t.tool, strategy: t.strategy, path: t.path })),
    });
    return;
  }

  logger.success(`Tracking rules source: ${set.source}`);
  logger.dim(`  id=${id}  scope=${set.scope}${set.repoRoot ? `  repo=${collapsePath(set.repoRoot)}` : ''}`);
  logger.dim(`  fan-out → ${set.tools.map((t) => t.tool).join(', ')} (${set.tools[0]?.strategy})`);
  logger.blank();
  logger.info('Run `tuck rules apply` to write the tool variants.');
};

// ─────────────────────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<ToolStatus, (s: string) => string> = {
  'in-sync': c.green,
  missing: c.dim,
  drift: c.yellow,
  foreign: c.red,
};

const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck rules list');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const manifest = await loadRulesManifest(tuckDir);
  const base = await buildRulesContext(tuckDir);
  const sets = Object.entries(manifest.sets);

  const statuses = await Promise.all(
    sets.map(async ([id, set]) => ({ id, ...(await computeSetStatus(set, base)) }))
  );

  if (isJsonMode()) {
    emitJsonOk({
      count: statuses.length,
      sets: statuses.map((s) => ({
        id: s.id,
        source: s.set.source,
        scope: s.set.scope,
        repoRoot: s.set.repoRoot,
        sourceExists: s.sourceExists,
        tools: s.tools.map((t) => ({
          tool: t.tool,
          strategy: t.strategy,
          target: collapsePath(t.target),
          status: t.status,
        })),
      })),
    });
    return;
  }

  if (statuses.length === 0) {
    logger.info('No rules sources tracked yet.');
    logger.dim('Run `tuck rules track <path>` to start.');
    return;
  }

  for (const s of statuses) {
    console.log();
    console.log(`${c.bold(c.cyan(s.set.source))} ${c.dim(`[${s.set.scope}]`)}`);
    console.log(`  ${c.dim(s.id)}`);
    if (!s.sourceExists) console.log(`  ${c.red('! canonical source is missing on disk')}`);
    for (const t of s.tools) {
      const color = STATUS_COLOR[t.status];
      console.log(
        `    ${color('•')} ${t.tool.padEnd(11)} ${c.dim(collapsePath(t.target))} ${color(`(${t.status})`)}`
      );
    }
  }
  console.log();
  logger.dim('Run `tuck rules apply` to bring variants in sync.');
};

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

interface ApplyOpts {
  json?: boolean;
  id?: string;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
}

const applyAction = async (opts: ApplyOpts): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck rules apply');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const nonInteractive = isJsonMode() || opts.yes || opts.force || !process.stdout.isTTY;
  const context = await buildRulesContext(tuckDir);

  const results = await applyRuleSets(tuckDir, {
    id: opts.id,
    dryRun: opts.dryRun,
    force: opts.force,
    context,
    confirmOverwrite: nonInteractive
      ? undefined
      : async (target: string) =>
          prompts.confirm(`Overwrite existing ${collapsePath(target)}?`, false),
  });

  const flat = results.flatMap((r) => r.applied.map((a) => ({ id: r.id, ...a })));

  if (isJsonMode()) {
    emitJsonOk({
      dryRun: !!opts.dryRun,
      sets: results.length,
      applied: flat.map((a) => ({
        id: a.id,
        tool: a.tool,
        target: collapsePath(a.target),
        action: a.action,
        reason: a.reason,
      })),
    });
    return;
  }

  if (flat.length === 0) {
    logger.info('No tracked rule sets to apply.');
    logger.dim('Run `tuck rules track <path>` first.');
    return;
  }

  for (const a of flat) {
    const label =
      a.action === 'skipped'
        ? c.dim(`skipped (${a.reason})`)
        : opts.dryRun
          ? c.yellow(`would ${a.action}`)
          : c.green(a.action);
    console.log(`  ${a.tool.padEnd(11)} ${c.dim(collapsePath(a.target))} — ${label}`);
  }
  logger.blank();
  const changed = flat.filter((a) => a.action !== 'skipped').length;
  if (opts.dryRun) {
    logger.info(`Dry run: ${changed} variant${changed !== 1 ? 's' : ''} would change.`);
  } else {
    logger.success(`Fanned out ${changed} variant${changed !== 1 ? 's' : ''}.`);
    if (changed > 0) logger.dim('To undo: tuck undo --latest');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// untrack
// ─────────────────────────────────────────────────────────────────────────────

interface UntrackOpts {
  json?: boolean;
  clean?: boolean;
  yes?: boolean;
}

const untrackAction = async (idArg: string, opts: UntrackOpts): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck rules untrack');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const manifest = await loadRulesManifest(tuckDir);
  const set = manifest.sets[idArg];
  if (!set) {
    throw new TuckError(`No tracked rule set with id "${idArg}"`, 'RULES_SET_NOT_FOUND', [
      'Run `tuck rules list` to see tracked sets.',
    ]);
  }

  let cleaned: string[] = [];
  if (opts.clean) {
    // --clean permanently deletes generated files: non-interactive callers
    // must OPT IN with --yes (a redirected stdout or --json alone is not
    // consent), and every deletable path is snapshotted first so `tuck undo`
    // can bring the variants back.
    if (!opts.yes) {
      if (isJsonMode() || !process.stdout.isTTY) {
        throw new TuckError(
          '--clean deletes generated files and requires --yes when non-interactive',
          'RULES_CLEAN_REQUIRES_YES',
          ['Re-run with --yes to confirm the deletion', 'Or drop --clean to untrack only']
        );
      }
      const ok = await prompts.confirm(
        `Delete the generated tool variants for ${set.source}?`,
        false
      );
      if (!ok) {
        logger.info('Aborted — nothing removed.');
        return;
      }
    }
    const deletable = await listExistingToolVariants(set);
    if (deletable.length > 0) {
      await createSnapshot(deletable, `Pre rules-untrack clean: ${set.source}`);
    }
    cleaned = await removeToolVariants(set);
    if (cleaned.length > 0 && !isJsonMode()) {
      logger.dim('  Restore them with `tuck undo --latest`');
    }
  }

  await untrackRuleSet(tuckDir, idArg);

  if (isJsonMode()) {
    emitJsonOk({ id: idArg, removed: true, cleaned: cleaned.map((p) => collapsePath(p)) });
    return;
  }
  logger.success(`Untracked rules source: ${set.source}`);
  if (cleaned.length > 0) {
    logger.dim(`  removed ${cleaned.length} generated variant(s)`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Command wiring
// ─────────────────────────────────────────────────────────────────────────────

const toolListHelp = ALL_TOOLS.map((t) => `${t} (${TOOL_LABELS[t]})`).join(', ');

/**
 * Build a fresh `rules` command tree. A factory (rather than a shared singleton)
 * so tests can parse repeatedly without Commander's per-instance option state
 * (variadic `--tool`, booleans) leaking between invocations.
 */
export const createRulesCommand = (): Command =>
  new Command('rules')
  .description('Fan one canonical rules file out to per-tool variants (CLAUDE.md, .cursorrules, …)')
  .addCommand(
    new Command('track')
      .description('Track a canonical rules file and its fan-out targets')
      .argument('<path>', 'Path to the canonical rules/instructions file (e.g. AGENTS.md)')
      .option(
        '-t, --tool <name...>',
        `Fan-out target (space- or comma-separated). Known: ${toolListHelp}`
      )
      .option('--symlink', 'Symlink each variant to the source instead of materializing')
      .option('--no-template', 'Do not render the source as a template on apply')
      .option('--var <key=value...>', 'Extra template variable (repeatable)')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(trackAction)
  )
  .addCommand(
    new Command('list')
      .description('List tracked rules sources and per-tool sync status')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(listAction)
  )
  .addCommand(
    new Command('apply')
      .description('Materialize or symlink each tool variant from the canonical source')
      .option('--id <id>', 'Only apply the set with this id')
      .option('--dry-run', 'Show what would change without writing')
      .option('-f, --force', 'Overwrite differing variants without confirmation')
      .option('-y, --yes', 'Assume yes; run non-interactively (skips undecided overwrites)')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(applyAction)
  )
  .addCommand(
    new Command('untrack')
      .description('Stop tracking a rules source')
      .argument('<id>', 'Rule set id (see `tuck rules list`)')
      .option('--clean', 'Also delete the generated tool variants from disk')
      .option('-y, --yes', 'Auto-confirm deletion')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(untrackAction)
  );

/** Shared instance registered by the top-level CLI. */
export const rulesCommand = createRulesCommand();
