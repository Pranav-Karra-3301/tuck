import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest, ensureBundle, isFileTracked } from '../lib/manifest.js';
import { ensureProfile, isValidProfileName } from '../lib/profiles.js';
import { trackFilesWithProgress, type FileToTrack } from '../lib/fileTracking.js';
import { NotInitializedError, TuckError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { AddOptions } from '../types.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { resolveAgentPreset } from '../lib/agentPresets.js';
import {
  preparePathsForTracking,
  type PreparedTrackFile,
  type TrackPathCandidate,
} from '../lib/trackPipeline.js';
import { parseRequirementList } from '../lib/requires.js';

type FileToAdd = PreparedTrackFile;

/** Whether the caller asked for repo-scoped tracking (`--repo [dir]`). */
const isRepoScopeRequested = (options: AddOptions): boolean =>
  options.repo !== undefined && options.repo !== false;

/**
 * Repo-scoped tracking is COPY-ONLY: the live file stays inside its repo
 * checkout (it can't be symlinked into the tuck repo without breaking the
 * checkout). Reject `--symlink --repo` up front with a clear message.
 */
const assertRepoScopeCompatible = (options: AddOptions): void => {
  if (isRepoScopeRequested(options) && options.symlink) {
    throw new Error('--symlink cannot be combined with --repo: repo-scoped files are copy-only');
  }
};

/**
 * Normalize and validate `--tag` values: allow comma- or space-separated
 * bundles per flag, dedupe, and reject malformed names up front so a bad tag
 * never reaches the manifest.
 */
const normalizeTags = (raw: string[] | undefined): string[] => {
  if (!raw || raw.length === 0) return [];
  const tags = new Set<string>();
  for (const entry of raw) {
    for (const part of entry.split(/[,\s]+/u).filter(Boolean)) {
      if (!isValidProfileName(part)) {
        throw new Error(
          `Invalid profile tag: ${part}. Tags may only contain letters, digits, dot, dash, and underscore.`
        );
      }
      tags.add(part);
    }
  }
  return [...tags].sort();
};

const addFiles = async (
  filesToAdd: FileToAdd[],
  tuckDir: string,
  options: AddOptions
): Promise<void> => {
  if (options.bundle) {
    await ensureBundle(tuckDir, options.bundle);
  }

  const tags = normalizeTags(options.tag);
  for (const tag of tags) {
    await ensureProfile(tuckDir, tag);
  }
  // Parse --requires ONCE (fail fast on a bad spec before any file is tracked).
  // The validated specs apply to every file added in this invocation.
  const requires =
    options.requires && options.requires.trim().length > 0
      ? parseRequirementList(options.requires)
      : undefined;

  const filesToTrack: FileToTrack[] = filesToAdd.map((f) => {
    const isRepo = f.scope === 'repo';
    const trackedFile: FileToTrack = {
      // For repo files the live absolute path is what we copy FROM; for home
      // files the (home-relative) source doubles as the path.
      path: isRepo ? (f.liveSource ?? f.source) : f.source,
      category: f.category,
    };

    if (f.nameOverride) {
      trackedFile.name = f.nameOverride;
    }

    if (f.jsonKey) {
      trackedFile.jsonKey = f.jsonKey;
    }

    if (options.bundle) {
      trackedFile.bundle = options.bundle;
    }

    if (tags.length > 0) {
      trackedFile.tags = tags;
    }

    if (requires && requires.length > 0) {
      trackedFile.requires = requires;
    }

    // Carry the repo-only redaction plan across (issue #100 RC5): applied to the
    // repository copy after the copy step; the live file is never rewritten.
    if (f.redactions) {
      trackedFile.redactions = f.redactions;
    }

    if (isRepo) {
      trackedFile.scope = 'repo';
      trackedFile.repoKey = f.repoKey;
      trackedFile.repoRelative = f.repoRelative;
      trackedFile.repoRoot = f.repoRoot;
      trackedFile.remoteUrl = f.remoteUrl;
      trackedFile.source = f.source;
      trackedFile.destination = f.destination;
    }

    return trackedFile;
  });

  await trackFilesWithProgress(filesToTrack, tuckDir, {
    showCategory: true,
    // Repo scope is always copy; --symlink is rejected upstream for repo adds.
    strategy: options.symlink ? 'symlink' : undefined,
    encrypt: options.encrypt,
    template: options.template,
    actionVerb: 'Tracking',
  });
};

const runInteractiveAdd = async (tuckDir: string, options: AddOptions = {}): Promise<void> => {
  prompts.intro('tuck add');

  const pathsInput = await prompts.text('Enter file paths to track (space-separated):', {
    placeholder: '~/.zshrc ~/.gitconfig',
    validate: (value) => {
      if (!value.trim()) return 'At least one path is required';
      return undefined;
    },
  });

  const paths = pathsInput.split(/\s+/).filter(Boolean);
  const candidates: TrackPathCandidate[] = paths.map((path) => ({
    path,
    category: options.category,
    name: options.name,
  }));

  let filesToAdd: FileToAdd[];
  try {
    // Forward the CLI flags so interactive add honors --encrypt/--force/--repo/
    // --category/--name identically to the non-interactive path (addFiles below
    // applies --encrypt/--template/--symlink/--bundle).
    filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
      category: options.category,
      name: options.name,
      force: options.force,
      secretHandling: 'interactive',
      forceBypassCommand: 'tuck add --force',
      encrypt: options.encrypt,
      repo: options.repo,
      repoKey: options.repoKey,
      jsonKey: options.key,
    });
  } catch (error) {
    if (error instanceof Error) {
      prompts.log.error(error.message);
    }
    prompts.cancel();
    return;
  }

  if (filesToAdd.length === 0) {
    logger.info('No files to add');
    return;
  }

  for (const file of filesToAdd) {
    prompts.log.step(`${file.source}`);

    const categoryOptions = Object.entries(CATEGORIES).map(([name, config]) => ({
      value: name,
      label: `${config.icon} ${name}`,
      hint: file.category === name ? '(auto-detected)' : undefined,
    }));

    categoryOptions.sort((a, b) => {
      if (a.value === file.category) return -1;
      if (b.value === file.category) return 1;
      return 0;
    });

    const selectedCategory = await prompts.select('Category:', categoryOptions);
    file.category = selectedCategory as string;
  }

  const confirm = await prompts.confirm(
    `Add ${filesToAdd.length} ${filesToAdd.length === 1 ? 'file' : 'files'}?`,
    true
  );

  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  await addFiles(filesToAdd, tuckDir, options);

  prompts.outro(`Added ${filesToAdd.length} ${filesToAdd.length === 1 ? 'file' : 'files'}`);
  logger.info("Run 'tuck sync' to commit changes");
};

/**
 * Add files programmatically (used by scan/sync flows)
 * Note: Throws SecretsDetectedError when configured to block.
 */
export const addFilesFromPaths = async (
  paths: string[],
  options: AddOptions = {}
): Promise<number> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  assertRepoScopeCompatible(options);

  const candidates: TrackPathCandidate[] = paths.map((path) => ({
    path,
    category: options.category,
    name: options.name,
  }));

  const filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
    category: options.category,
    name: options.name,
    force: options.force,
    secretHandling: 'strict',
    forceBypassCommand: 'tuck add --force',
    encrypt: options.encrypt,
    repo: options.repo,
    repoKey: options.repoKey,
    jsonKey: options.key,
  });

  if (filesToAdd.length === 0) {
    return 0;
  }

  await addFiles(filesToAdd, tuckDir, options);
  return filesToAdd.length;
};

/**
 * Track a curated AI-agent config preset (`tuck add --preset <agent>`).
 *
 * Enumerates the agent's safe-to-track allowlist, drops anything already
 * tracked (so re-runs are idempotent), and hands the survivors to the normal
 * tracking pipeline — which still runs the secret scan on every file as the
 * final backstop. Sensitive files (credentials/history/sessions) are never
 * candidates and are reported as intentionally skipped.
 */
const runAddPreset = async (presetId: string, options: AddOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck add');
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  if (options.repo !== undefined && options.repo !== false) {
    throw new TuckError('--preset cannot be combined with --repo', 'VALIDATION_ERROR', [
      'Agent presets track home-scoped config; drop --repo.',
    ]);
  }

  const { preset, tracked, missing, skippedSensitive } = await resolveAgentPreset(presetId);

  // Skip entries already in the manifest so re-running the preset is a no-op
  // rather than a FileAlreadyTrackedError abort.
  const fresh: typeof tracked = [];
  const alreadyTracked: string[] = [];
  for (const t of tracked) {
    if (await isFileTracked(tuckDir, t.collapsed)) {
      alreadyTracked.push(t.collapsed);
    } else {
      fresh.push(t);
    }
  }

  if (options.plan || options.dryRun) {
    if (isJsonMode()) {
      emitJsonOk({
        preset: preset.id,
        plan: fresh.map((t) => ({ source: t.collapsed, category: t.category, isDir: t.isDir })),
        alreadyTracked,
        skipped: skippedSensitive,
        missing,
      });
    } else {
      logger.heading(`Plan — tuck add --preset ${preset.id}:`);
      if (fresh.length === 0) logger.dim('  (nothing new to track)');
      for (const t of fresh)
        logger.file('add', `${t.collapsed}${t.isDir ? '/' : ''} [${t.category}]`);
      if (skippedSensitive.length > 0) {
        logger.blank();
        logger.warning(`Excluded ${skippedSensitive.length} sensitive file(s):`);
        for (const s of skippedSensitive) logger.dim(`  ${s}`);
      }
    }
    return;
  }

  if (fresh.length === 0) {
    if (isJsonMode()) {
      emitJsonOk({
        added: 0,
        files: [],
        preset: preset.id,
        alreadyTracked,
        skipped: skippedSensitive,
      });
    } else if (alreadyTracked.length > 0) {
      logger.info(`All ${preset.label} config files are already tracked.`);
    } else {
      logger.info(`No ${preset.label} config files found to track.`);
    }
    return;
  }

  const nonInteractive = isJsonMode() || options.yes || !process.stdout.isTTY;
  if (!nonInteractive) {
    prompts.intro(`tuck add --preset ${preset.id}`);
    for (const t of fresh) prompts.log.step(`${t.collapsed}${t.isDir ? '/' : ''} [${t.category}]`);
    if (skippedSensitive.length > 0) {
      prompts.log.warning(
        `Skipping ${skippedSensitive.length} sensitive file(s): ${skippedSensitive.join(', ')}`
      );
    }
    const ok = await prompts.confirm(`Track ${fresh.length} ${preset.label} file(s)?`, true);
    if (!ok) {
      prompts.cancel('Operation cancelled');
      return;
    }
  }

  const candidates: TrackPathCandidate[] = fresh.map((t) => ({
    path: t.collapsed,
    category: t.category,
  }));

  const filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
    force: options.force,
    secretHandling: isJsonMode() || options.yes ? 'strict' : 'interactive',
    forceBypassCommand: 'tuck add --force',
  });

  if (filesToAdd.length === 0) {
    if (isJsonMode())
      emitJsonOk({ added: 0, files: [], preset: preset.id, skipped: skippedSensitive });
    else logger.info('No files to add');
    return;
  }

  await addFiles(filesToAdd, tuckDir, options);

  if (isJsonMode()) {
    emitJsonOk({
      added: filesToAdd.length,
      files: filesToAdd.map((f) => ({ source: f.source, category: f.category })),
      preset: preset.id,
      skipped: skippedSensitive,
      bundle: options.bundle ?? 'default',
    });
    return;
  }

  logger.success(
    `Tracked ${filesToAdd.length} ${preset.label} file${filesToAdd.length === 1 ? '' : 's'}`
  );
  if (skippedSensitive.length > 0) {
    logger.dim(
      `Skipped ${skippedSensitive.length} sensitive file(s) (credentials/history/sessions)`
    );
  }
  logger.info("Run 'tuck sync' when you're ready to commit changes");
};

const runAdd = async (paths: string[], options: AddOptions): Promise<void> => {
  if (options.preset) {
    if (paths.length > 0) {
      throw new TuckError('--preset does not take path arguments', 'VALIDATION_ERROR', [
        `Run: tuck add --preset ${options.preset}`,
      ]);
    }
    await runAddPreset(options.preset, options);
    return;
  }

  if (options.json) setJsonMode(true, 'tuck add');
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  assertRepoScopeCompatible(options);

  if (paths.length === 0) {
    if (isJsonMode() || options.yes) {
      // In agent mode an empty add is a no-op rather than an interactive prompt.
      if (isJsonMode()) emitJsonOk({ added: 0, files: [] });
      else logger.info('No paths provided.');
      return;
    }
    await runInteractiveAdd(tuckDir, options);
    return;
  }

  const candidates: TrackPathCandidate[] = paths.map((path) => ({
    path,
    category: options.category,
    name: options.name,
  }));

  // --plan / --dry-run: run the FULL preparation pipeline (category detection,
  // secret scan, validation) so the plan output is what a real `tuck add` would
  // produce — not an echo of raw input. preparePathsForTracking performs no
  // manifest writes; addFiles (skipped below) is the only mutating step.
  if (options.plan || options.dryRun) {
    const plannedFiles = await preparePathsForTracking(candidates, tuckDir, {
      category: options.category,
      name: options.name,
      force: options.force,
      secretHandling: isJsonMode() || options.yes ? 'strict' : 'interactive',
      forceBypassCommand: 'tuck add --force',
      encrypt: options.encrypt,
      repo: options.repo,
      repoKey: options.repoKey,
      jsonKey: options.key,
    });

    const bundle = options.bundle ?? 'default';
    const tags = normalizeTags(options.tag);
    if (isJsonMode()) {
      emitJsonOk({
        plan: plannedFiles.map((f) => ({
          source: f.source,
          category: f.category,
          destination: f.destination,
          sensitive: f.sensitive,
          scope: f.scope ?? 'home',
          bundle,
          tags,
        })),
      });
    } else {
      logger.heading('Plan — would track:');
      for (const f of plannedFiles) logger.file('add', `${f.source} [${f.category}]`);
    }
    return;
  }

  const filesToAdd = await preparePathsForTracking(candidates, tuckDir, {
    category: options.category,
    name: options.name,
    force: options.force,
    secretHandling: isJsonMode() || options.yes ? 'strict' : 'interactive',
    forceBypassCommand: 'tuck add --force',
    encrypt: options.encrypt,
    repo: options.repo,
    repoKey: options.repoKey,
    jsonKey: options.key,
  });

  if (filesToAdd.length === 0) {
    if (isJsonMode()) emitJsonOk({ added: 0, files: [] });
    else logger.info('No files to add');
    return;
  }

  await addFiles(filesToAdd, tuckDir, options);

  if (isJsonMode()) {
    emitJsonOk({
      added: filesToAdd.length,
      files: filesToAdd.map((f) => ({ source: f.source, category: f.category })),
      bundle: options.bundle ?? 'default',
      tags: normalizeTags(options.tag),
    });
    return;
  }

  if (options.yes) {
    logger.success(`Added ${filesToAdd.length} file${filesToAdd.length > 1 ? 's' : ''}`);
    return;
  }

  console.log();
  const shouldSync = await prompts.confirm('Would you like to sync these changes now?', true);

  if (shouldSync) {
    console.log();
    const { runSync } = await import('./sync.js');
    await runSync({});
  } else {
    console.log();
    logger.info("Run 'tuck sync' when you're ready to commit changes");
  }
};

export const addCommand = new Command('add')
  .description('Track new dotfiles')
  .argument('[paths...]', 'Paths to dotfiles to track')
  .option(
    '--preset <agent>',
    'Track a curated AI-agent config preset (claude-code, cursor, codex, gemini, copilot)'
  )
  .option('-c, --category <name>', 'Category to organize under')
  .option('-n, --name <name>', 'Custom name for the file in manifest')
  .option('--symlink', 'Copy into tuck repo, then replace source path with a symlink')
  .option('--template', 'Mark as a template: rendered on apply (sync will not capture live edits)')
  .option(
    '--encrypt',
    'Encrypt the file at rest in the repo (decrypted on apply; needs an encryption password)'
  )
  .option(
    '--repo [dir]',
    'Track as repo-scoped (file lives in a git repo; auto-detects the root from the path when no dir is given)'
  )
  .option(
    '--repo-key <key>',
    'Explicit stable repo identity (advanced; default derives from the remote)'
  )
  .option(
    '--key <json.path>',
    'Track only the JSON subtree at this dot-delimited key path (e.g. mcpServers); written back into the live file at that path on apply/restore'
  )
  .option('-f, --force', 'Skip secret scanning (not recommended)')
  .option('-b, --bundle <name>', 'Bundle to assign the file to (defaults to "default")')
  .option(
    '-t, --tag <name...>',
    'Profile tag(s) to attach (work, personal, server, agent, …); repeatable or comma-separated'
  )
  .option(
    '--requires <specs>',
    'Declare package dependencies for this file, e.g. "brew:starship,apt:zsh" (installed first by `tuck bootstrap`)'
  )
  .option('--json', 'Emit JSON envelope to stdout (non-interactive)')
  .option('-y, --yes', 'Auto-confirm prompts (use with --json for full automation)')
  .option('--plan', 'Print the planned tracking operation as JSON and exit')
  .option('--dry-run', 'Print the planned tracking operation as text and exit')
  .action(async (paths: string[], options: AddOptions) => {
    await runAdd(paths, options);
  });
