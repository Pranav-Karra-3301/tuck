/**
 * `tuck merge` — manage per-file structured (JSON) three-way merge policies.
 *
 * A merge policy tells `tuck sync` to reconcile a tracked JSON file key-by-key
 * (union allowlists, deep-merge objects, surface real conflicts) instead of
 * silently overwriting it when local and remote have both diverged. High-churn
 * agent configs (Claude `settings.json`, `.mcp.json`, …) get a safe default
 * policy automatically; everything else is opt-in here.
 *
 * Subcommands:
 *   list                     show every file's effective merge policy
 *   show <path-or-id>        show one file's effective policy (and its source)
 *   set  <path-or-id>        set/override the policy on a file
 *   unset <path-or-id>       remove an explicit policy (reverts to auto/none)
 */

import { Command } from 'commander';
import { logger, colors as c } from '../ui/index.js';
import { getTuckDir, collapsePath, expandPath } from '../lib/paths.js';
import { loadManifest, updateFileInManifest } from '../lib/manifest.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { resolveMergePolicy, DEFAULT_JSON_MERGE_POLICY } from '../lib/jsonMerge.js';
import type {
  ArrayMergeStrategy,
  ConflictResolution,
  MergePolicy,
} from '../lib/jsonMerge.js';
import { NotInitializedError, TuckError } from '../errors.js';
import type { TrackedFileOutput } from '../schemas/manifest.schema.js';

const ARRAY_STRATEGIES: ReadonlySet<string> = new Set(['union', 'concat', 'replace']);
const CONFLICT_STRATEGIES: ReadonlySet<string> = new Set(['ours', 'theirs', 'manual']);

const ensureInitialized = async (): Promise<string> => {
  const tuckDir = getTuckDir();
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
  return tuckDir;
};

/** Resolve a tracked file by manifest id first, then by source path. */
const resolveTrackedFile = (
  files: Record<string, TrackedFileOutput>,
  target: string
): { id: string; file: TrackedFileOutput } => {
  if (files[target]) return { id: target, file: files[target] };
  // Manifest sources are stored collapsed (~/...); the shell expands unquoted
  // ~ arguments to absolute paths, so normalize before comparing (same as
  // `tuck remove`).
  const collapsed = collapsePath(expandPath(target));
  for (const [id, file] of Object.entries(files)) {
    if (file.source === target || file.source === collapsed) return { id, file };
  }
  throw new TuckError(`No tracked file matches: ${target}`, 'FILE_NOT_TRACKED', [
    'Pass either a manifest id or the original source path (e.g. ~/.claude/settings.json).',
    'Run `tuck list` to see tracked files.',
  ]);
};

interface EffectivePolicy {
  source: string;
  explicit: boolean;
  policy: MergePolicy | null;
}

const describeEffective = (file: TrackedFileOutput): EffectivePolicy => ({
  source: file.source,
  explicit: file.merge !== undefined,
  policy: resolveMergePolicy(file.source, file.merge),
});

const policyLabel = (eff: EffectivePolicy): string => {
  if (!eff.policy) return c.dim('none (plain copy)');
  const origin = eff.explicit ? c.cyan('explicit') : c.dim('auto');
  return `${origin} ${c.dim(`json · arrays=${eff.policy.arrays} · conflict=${eff.policy.conflict}`)}`;
};

export const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck merge list');
  const tuckDir = await ensureInitialized();
  const manifest = await loadManifest(tuckDir);

  const rows = Object.values(manifest.files)
    .map(describeEffective)
    .filter((e) => e.policy !== null)
    .sort((a, b) => a.source.localeCompare(b.source));

  if (isJsonMode()) {
    emitJsonOk({
      count: rows.length,
      files: rows.map((e) => ({
        source: e.source,
        explicit: e.explicit,
        policy: e.policy,
      })),
    });
    return;
  }

  if (rows.length === 0) {
    logger.info('No files have a structured merge policy.');
    logger.dim('Set one with: tuck merge set <path> --arrays union --conflict manual');
    return;
  }

  console.log();
  console.log(c.bold('Structured merge policies:'));
  for (const e of rows) {
    console.log(`  ${c.cyan(collapsePath(e.source).padEnd(34))} ${policyLabel(e)}`);
  }
  console.log();
};

export const showAction = async (target: string, opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck merge show');
  const tuckDir = await ensureInitialized();
  const manifest = await loadManifest(tuckDir);
  const { file } = resolveTrackedFile(manifest.files, target);
  const eff = describeEffective(file);

  if (isJsonMode()) {
    emitJsonOk({ source: eff.source, explicit: eff.explicit, policy: eff.policy });
    return;
  }

  console.log();
  console.log(`${c.bold('File:')}   ${c.cyan(collapsePath(eff.source))}`);
  console.log(`${c.bold('Policy:')} ${policyLabel(eff)}`);
  if (!eff.explicit && eff.policy) {
    logger.dim('This policy is auto-applied to a known agent config. Use `tuck merge set` to override.');
  }
  console.log();
};

export const setAction = async (
  target: string,
  opts: { json?: boolean; arrays?: string; conflict?: string }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck merge set');
  const tuckDir = await ensureInitialized();
  const manifest = await loadManifest(tuckDir);
  const { id, file } = resolveTrackedFile(manifest.files, target);

  if (opts.arrays && !ARRAY_STRATEGIES.has(opts.arrays)) {
    throw new TuckError(`Invalid --arrays value: ${opts.arrays}`, 'MERGE_POLICY_INVALID', [
      'Valid values: union, concat, replace.',
    ]);
  }
  if (opts.conflict && !CONFLICT_STRATEGIES.has(opts.conflict)) {
    throw new TuckError(`Invalid --conflict value: ${opts.conflict}`, 'MERGE_POLICY_INVALID', [
      'Valid values: ours, theirs, manual.',
    ]);
  }

  // Start from the existing explicit policy (if any) so a partial update keeps
  // the other field; otherwise fall back to the safe defaults.
  const previous = file.merge ?? DEFAULT_JSON_MERGE_POLICY;
  const policy: MergePolicy = {
    format: 'json',
    arrays: (opts.arrays as ArrayMergeStrategy | undefined) ?? previous.arrays,
    conflict: (opts.conflict as ConflictResolution | undefined) ?? previous.conflict,
  };

  await updateFileInManifest(tuckDir, id, { merge: policy });

  if (isJsonMode()) {
    emitJsonOk({ source: file.source, policy });
    return;
  }

  logger.success(`Set merge policy for ${collapsePath(file.source)}`);
  logger.dim(`json · arrays=${policy.arrays} · conflict=${policy.conflict}`);
};

export const unsetAction = async (target: string, opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck merge unset');
  const tuckDir = await ensureInitialized();
  const manifest = await loadManifest(tuckDir);
  const { id, file } = resolveTrackedFile(manifest.files, target);

  const hadPolicy = file.merge !== undefined;
  // Setting to undefined drops the key on serialization (JSON.stringify omits it).
  await updateFileInManifest(tuckDir, id, { merge: undefined });

  const effectiveAfter = resolveMergePolicy(file.source, undefined);

  if (isJsonMode()) {
    emitJsonOk({ source: file.source, removed: hadPolicy, effectivePolicy: effectiveAfter });
    return;
  }

  if (!hadPolicy) {
    logger.info(`${collapsePath(file.source)} had no explicit merge policy.`);
  } else {
    logger.success(`Removed explicit merge policy for ${collapsePath(file.source)}`);
  }
  if (effectiveAfter) {
    logger.dim('A default policy still applies automatically (known agent config).');
  }
};

export const mergeCommand = new Command('merge')
  .description('Manage structured (JSON) three-way merge policies for tracked files')
  .addCommand(
    new Command('list')
      .description('List files with an effective structured merge policy')
      .option('--json', 'Emit JSON envelope')
      .action(listAction)
  )
  .addCommand(
    new Command('show')
      .description("Show a file's effective merge policy")
      .argument('<path-or-id>', 'Manifest id or source path of the tracked file')
      .option('--json', 'Emit JSON envelope')
      .action(showAction)
  )
  .addCommand(
    new Command('set')
      .description('Set (or override) the structured merge policy on a file')
      .argument('<path-or-id>', 'Manifest id or source path of the tracked file')
      .option('--arrays <strategy>', 'Array reconciliation: union | concat | replace')
      .option('--conflict <strategy>', 'Scalar conflict resolution: ours | theirs | manual')
      .option('--json', 'Emit JSON envelope')
      .action(setAction)
  )
  .addCommand(
    new Command('unset')
      .description('Remove an explicit merge policy (reverts to auto-detected or none)')
      .argument('<path-or-id>', 'Manifest id or source path of the tracked file')
      .option('--json', 'Emit JSON envelope')
      .action(unsetAction)
  );
