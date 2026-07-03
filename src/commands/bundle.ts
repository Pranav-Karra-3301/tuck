/**
 * `tuck bundle` — manage logical groupings of tracked files.
 *
 * Bundles sit one level above categories: every tracked file lives in exactly
 * one bundle (defaulting to `default`). They are the unit of scope for
 * `tuck add --bundle` and `tuck apply --bundle`.
 *
 * Subcommands:
 *   list                        list bundles and counts
 *   create <name>               register a new (empty) bundle
 *   rm <name>                   remove a bundle (reassigns files to default)
 *   assign <bundle> <file>      move a tracked file into a bundle
 */

import { Command } from 'commander';
import { logger, colors as c } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import {
  loadManifest,
  ensureBundle,
  removeBundle,
  assignFileToBundle,
  DEFAULT_BUNDLE,
} from '../lib/manifest.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { NotInitializedError, TuckError } from '../errors.js';

interface BundleListEntry {
  name: string;
  description?: string;
  created: string;
  fileCount: number;
}

const ensureInitialized = async (): Promise<string> => {
  const tuckDir = getTuckDir();
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
  return tuckDir;
};

const buildBundleList = async (tuckDir: string): Promise<BundleListEntry[]> => {
  const manifest = await loadManifest(tuckDir);
  const counts = new Map<string, number>();

  for (const file of Object.values(manifest.files)) {
    const bundle = file.bundle ?? DEFAULT_BUNDLE;
    counts.set(bundle, (counts.get(bundle) ?? 0) + 1);
  }

  const entries: BundleListEntry[] = Object.entries(manifest.bundles).map(([name, meta]) => ({
    name,
    description: meta.description,
    created: meta.created,
    fileCount: counts.get(name) ?? 0,
  }));

  // Stable ordering: default first, then alpha.
  entries.sort((a, b) => {
    if (a.name === DEFAULT_BUNDLE) return -1;
    if (b.name === DEFAULT_BUNDLE) return 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
};

const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck bundle list');
  const tuckDir = await ensureInitialized();
  const bundles = await buildBundleList(tuckDir);

  if (isJsonMode()) {
    emitJsonOk({ count: bundles.length, bundles });
    return;
  }

  if (bundles.length === 0) {
    logger.info('No bundles defined.');
    return;
  }

  console.log();
  console.log(c.bold('Bundles:'));
  for (const b of bundles) {
    const desc = b.description ? c.dim(` — ${b.description}`) : '';
    console.log(
      `  ${c.cyan(b.name.padEnd(20))} ${c.dim(`${b.fileCount} file${b.fileCount === 1 ? '' : 's'}`)}${desc}`
    );
  }
  console.log();
};

const createAction = async (
  name: string,
  opts: { json?: boolean; description?: string }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck bundle create');
  const tuckDir = await ensureInitialized();

  if (!name || !/^[a-zA-Z0-9_.-]+$/u.test(name)) {
    throw new TuckError(
      `Invalid bundle name: ${name}`,
      'BUNDLE_NAME_INVALID',
      ['Bundle names may only contain letters, digits, dot, dash, and underscore.']
    );
  }

  const manifest = await loadManifest(tuckDir);
  const existed = !!manifest.bundles[name];

  await ensureBundle(tuckDir, name, opts.description);

  if (isJsonMode()) {
    emitJsonOk({ bundle: name, created: !existed });
    return;
  }

  if (existed) {
    logger.info(`Bundle already exists: ${name}`);
  } else {
    logger.success(`Created bundle: ${name}`);
  }
};

const removeAction = async (
  name: string,
  opts: { json?: boolean; force?: boolean; reassignTo?: string }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck bundle rm');
  const tuckDir = await ensureInitialized();

  if (name === DEFAULT_BUNDLE) {
    throw new TuckError(
      'The default bundle cannot be removed.',
      'BUNDLE_PROTECTED'
    );
  }

  const manifest = await loadManifest(tuckDir);
  if (!manifest.bundles[name]) {
    throw new TuckError(`Bundle not found: ${name}`, 'BUNDLE_NOT_FOUND');
  }

  const memberCount = Object.values(manifest.files).filter(
    (f) => (f.bundle ?? DEFAULT_BUNDLE) === name
  ).length;

  if (memberCount > 0 && !opts.force) {
    throw new TuckError(
      `Bundle "${name}" still has ${memberCount} file${memberCount === 1 ? '' : 's'}.`,
      'BUNDLE_NOT_EMPTY',
      ['Pass --force to remove and reassign files to the default bundle.']
    );
  }

  const { reassigned } = await removeBundle(tuckDir, name, {
    reassignTo: opts.reassignTo,
  });

  if (isJsonMode()) {
    emitJsonOk({ removed: name, reassigned, reassignedTo: opts.reassignTo ?? DEFAULT_BUNDLE });
    return;
  }

  if (reassigned > 0) {
    logger.success(
      `Removed bundle "${name}" and reassigned ${reassigned} file${reassigned === 1 ? '' : 's'} to "${opts.reassignTo ?? DEFAULT_BUNDLE}".`
    );
  } else {
    logger.success(`Removed bundle: ${name}`);
  }
};

const assignAction = async (
  bundle: string,
  target: string,
  opts: { json?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck bundle assign');
  const tuckDir = await ensureInitialized();

  const manifest = await loadManifest(tuckDir);

  if (!manifest.bundles[bundle]) {
    throw new TuckError(
      `Bundle not found: ${bundle}`,
      'BUNDLE_NOT_FOUND',
      [`Run \`tuck bundle create ${bundle}\` first.`]
    );
  }

  // Resolve target: prefer exact id match, fall back to matching by source.
  let resolvedId: string | undefined = manifest.files[target] ? target : undefined;
  if (!resolvedId) {
    for (const [id, file] of Object.entries(manifest.files)) {
      if (file.source === target) {
        resolvedId = id;
        break;
      }
    }
  }

  if (!resolvedId) {
    throw new TuckError(
      `No tracked file matches: ${target}`,
      'FILE_NOT_TRACKED',
      ['Pass either a manifest id or the original source path (e.g. ~/.zshrc).']
    );
  }

  await assignFileToBundle(tuckDir, resolvedId, bundle);

  if (isJsonMode()) {
    emitJsonOk({ assigned: resolvedId, bundle });
    return;
  }

  logger.success(`Moved ${resolvedId} into bundle "${bundle}".`);
};

export const bundleCommand = new Command('bundle')
  .description('Manage bundles — logical groups of tracked files')
  .addCommand(
    new Command('list')
      .description('List bundles and their file counts')
      .option('--json', 'Emit JSON envelope')
      .action(listAction)
  )
  .addCommand(
    new Command('create')
      .description('Register a new empty bundle')
      .argument('<name>', 'Bundle name')
      .option('-d, --description <text>', 'Human-readable description')
      .option('--json', 'Emit JSON envelope')
      .action(createAction)
  )
  .addCommand(
    new Command('rm')
      .description('Remove a bundle (files are reassigned to "default" by default)')
      .argument('<name>', 'Bundle name')
      .option('-f, --force', 'Remove even if the bundle contains files')
      .option('--reassign-to <bundle>', 'Reassign files into this bundle instead of "default"')
      .option('--json', 'Emit JSON envelope')
      .action(removeAction)
  )
  .addCommand(
    new Command('assign')
      .description('Move a tracked file into a bundle')
      .argument('<bundle>', 'Target bundle name')
      .argument('<path-or-id>', 'Manifest id or source path of the tracked file')
      .option('--json', 'Emit JSON envelope')
      .action(assignAction)
  );
