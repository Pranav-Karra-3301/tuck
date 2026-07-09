import { Command } from 'commander';
import { join, dirname } from 'path';
import { colors as c } from '../ui/theme.js';
import { chmod, stat, readFile, writeFile } from 'fs/promises';
import { prompts, logger, withSpinner } from '../ui/index.js';
import {
  getTuckDir,
  expandPath,
  pathExists,
  collapsePath,
  validateSafeSourcePath,
  validateSafeManifestDestination,
  validatePathWithinRoot,
  validateSafeRepoSourcePath,
} from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles, getTrackedFileBySource } from '../lib/manifest.js';
import { resolveWriteTarget, setKnownRepoRoots, isSandbox } from '../lib/writeContext.js';
import {
  resolveLiveTarget,
  resolveRepoRoot,
  bindRepo,
  loadReposRegistry,
} from '../lib/repoScope.js';
import { loadConfig } from '../lib/config.js';
import { copyFileOrDir, createSymlink, setFilePermissions } from '../lib/files.js';
import { ensureDir } from 'fs-extra';
import { materializeForLive, keystorePassphrase, buildMaterializeCtx } from '../lib/materialize.js';
import { mergeSubtreeIntoLive } from '../lib/jsonKey.js';
import { createBackup } from '../lib/backup.js';
import { runPreRestoreHook, runPostRestoreHook, type HookOptions } from '../lib/hooks.js';
import { NotInitializedError, FileNotFoundError, TuckError, MaterializeError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { RestoreOptions } from '../types.js';
import { setJsonMode, isJsonMode, emitJsonOk, addJsonWarning } from '../lib/jsonOutput.js';
import { restoreFiles as restoreSecrets, getSecretCount } from '../lib/secrets/index.js';

/**
 * Fix permissions for SSH files after restore
 * SSH requires strict permissions: 700 for directories, 600 for private files
 */
const fixSSHPermissions = async (path: string): Promise<void> => {
  const expandedPath = expandPath(path);

  // Only fix permissions for SSH files
  // Check for files inside .ssh/ directory or the .ssh directory itself
  if (!path.includes('.ssh/') && !path.endsWith('.ssh')) {
    return;
  }

  try {
    const stats = await stat(expandedPath);

    if (stats.isDirectory()) {
      // Directories should be 700
      await chmod(expandedPath, 0o700);
    } else {
      // Files should be 600
      await chmod(expandedPath, 0o600);
    }
  } catch {
    // Ignore permission errors (might be on Windows)
  }
};

/**
 * Fix GPG permissions after restore
 */
const fixGPGPermissions = async (path: string): Promise<void> => {
  const expandedPath = expandPath(path);

  // Only fix permissions for GPG files
  // Check for files inside .gnupg/ directory or the .gnupg directory itself
  if (!path.includes('.gnupg/') && !path.endsWith('.gnupg')) {
    return;
  }

  try {
    const stats = await stat(expandedPath);

    if (stats.isDirectory()) {
      await chmod(expandedPath, 0o700);
    } else {
      await chmod(expandedPath, 0o600);
    }
  } catch {
    // Ignore permission errors
  }
};

interface FileToRestore {
  id: string;
  source: string;
  destination: string;
  category: string;
  existsAtTarget: boolean;
  /** Tracking scope — absent/'home' resolves against $HOME; 'repo' against a bound repo root. */
  scope?: 'home' | 'repo';
  /** Stable cross-machine repo identity (repo-scoped files only). */
  repoKey?: string;
  /** POSIX path relative to the repo root (repo-scoped files only). */
  repoRelative?: string;
  /** Recorded octal permissions (e.g. "755"), reapplied to the restored file. */
  permissions?: string;
  /** Render the repo source as a template before writing to the live system. */
  template: boolean;
  /** Decrypt the repo source (TCKE1) before writing to the live system. */
  encrypted: boolean;
  /**
   * Dot-delimited JSON key path when the repo copy is only a subtree. On restore
   * it is deep-merged back into the live file rather than overwriting it.
   */
  jsonKey?: string;
}

interface RestoreResult {
  restoredCount: number;
  secretsRestored: number;
  unresolvedPlaceholders: string[];
  /** Sources of repo-scoped files skipped because their repoKey is unbound on this machine. */
  skipped: string[];
}

const prepareFilesToRestore = async (
  tuckDir: string,
  paths?: string[]
): Promise<FileToRestore[]> => {
  const allFiles = await getAllTrackedFiles(tuckDir);
  const filesToRestore: FileToRestore[] = [];

  if (paths && paths.length > 0) {
    // Restore specific files
    for (const path of paths) {
      const expandedPath = expandPath(path);
      const collapsedPath = collapsePath(expandedPath);

      const tracked = await getTrackedFileBySource(tuckDir, collapsedPath);
      if (!tracked) {
        throw new FileNotFoundError(`Not tracked: ${path}`);
      }

      // Repo-scoped files live under a (per-machine) repo root that may be
      // outside $HOME, so home-confinement does not apply; their live location
      // is resolved later via the repo registry. Home files keep the existing
      // home-confinement guard. The manifest destination is always confined.
      const isRepo = tracked.file.scope === 'repo';
      if (!isRepo) {
        validateSafeSourcePath(tracked.file.source);
      }
      validateSafeManifestDestination(tracked.file.destination);
      const repositoryPath = join(tuckDir, tracked.file.destination);
      validatePathWithinRoot(repositoryPath, tuckDir, 'restore source');

      const liveTarget = await resolveLiveTarget(tracked.file);
      filesToRestore.push({
        id: tracked.id,
        source: tracked.file.source,
        destination: repositoryPath,
        category: tracked.file.category,
        existsAtTarget: liveTarget ? await pathExists(liveTarget) : false,
        scope: tracked.file.scope,
        repoKey: tracked.file.repoKey,
        repoRelative: tracked.file.repoRelative,
        permissions: tracked.file.permissions,
        template: tracked.file.template,
        encrypted: tracked.file.encrypted,
        jsonKey: tracked.file.jsonKey,
      });
    }
  } else {
    // Restore all files
    for (const [id, file] of Object.entries(allFiles)) {
      const isRepo = file.scope === 'repo';
      if (!isRepo) {
        validateSafeSourcePath(file.source);
      }
      validateSafeManifestDestination(file.destination);
      const repositoryPath = join(tuckDir, file.destination);
      validatePathWithinRoot(repositoryPath, tuckDir, 'restore source');
      const liveTarget = await resolveLiveTarget(file);
      filesToRestore.push({
        id,
        source: file.source,
        destination: repositoryPath,
        category: file.category,
        existsAtTarget: liveTarget ? await pathExists(liveTarget) : false,
        scope: file.scope,
        repoKey: file.repoKey,
        repoRelative: file.repoRelative,
        permissions: file.permissions,
        template: file.template,
        encrypted: file.encrypted,
        jsonKey: file.jsonKey,
      });
    }
  }

  return filesToRestore;
};

const restoreFilesInternal = async (
  tuckDir: string,
  files: FileToRestore[],
  options: RestoreOptions
): Promise<RestoreResult> => {
  const config = await loadConfig(tuckDir);
  const useSymlink = options.symlink || config.files.strategy === 'symlink';
  // Template context (built-in vars + config.templates.variables), built once per restore.
  const ctx = await buildMaterializeCtx(tuckDir);
  const shouldBackup = options.backup ?? config.files.backupOnRestore;

  // Prepare hook options
  const hookOptions: HookOptions = {
    skipHooks: options.noHooks,
    trustHooks: options.trustHooks,
  };

  // Run pre-restore hook
  await runPreRestoreHook(tuckDir, hookOptions);

  // Register the machine's bound repo roots so copyFileOrDir/createSymlink will
  // accept out-of-home repo write destinations (validated against allowedRoots).
  // `extra` lets us guarantee a just-bound root is registered even before the
  // registry round-trip is observable.
  const refreshKnownRepoRoots = async (...extra: string[]): Promise<void> => {
    const reg = await loadReposRegistry();
    const roots = Object.values(reg.repos).map((r) => r.root);
    setKnownRepoRoots([...roots, ...extra]);
  };
  await refreshKnownRepoRoots();

  let restoredCount = 0;
  const restoredPaths: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    validatePathWithinRoot(file.destination, tuckDir, 'restore source');

    // Resolve + confine the write target. Home files (scope absent/'home')
    // resolve against $HOME (redirected under --root in sandbox mode). Repo
    // files resolve against their per-machine bound root via the repo registry.
    let targetPath: string;
    if (file.scope === 'repo') {
      // Resolve the repo's live root. If unbound, either bind it to an explicit
      // --repo-root, or skip (never guess where the repo lives on this machine).
      let repoRoot = file.repoKey ? await resolveRepoRoot(file.repoKey) : null;
      if (!repoRoot && options.repoRoot && file.repoKey) {
        await bindRepo(file.repoKey, options.repoRoot);
        await refreshKnownRepoRoots(options.repoRoot);
        repoRoot = (await resolveRepoRoot(file.repoKey)) ?? options.repoRoot;
      }
      if (!repoRoot || !file.repoKey || !file.repoRelative) {
        const msg = `Skipping repo-scoped file (repo not bound on this machine): ${file.source}`;
        logger.warning(msg);
        if (isJsonMode()) addJsonWarning(msg);
        skipped.push(file.source);
        continue;
      }
      // Repo files live under a root that may be outside $HOME; confine to the
      // repo root and reject unsafe repoRelative paths (absolute / traversal).
      validateSafeRepoSourcePath(repoRoot, file.repoRelative);
      // Compose through resolveWriteTarget so it still rebases under --root.
      targetPath = resolveWriteTarget(file.source, {
        repoKey: file.repoKey,
        repoRelative: file.repoRelative,
        repoRoot,
      });
    } else {
      validateSafeSourcePath(file.source);
      targetPath = resolveWriteTarget(file.source);
    }

    // Check if source exists in repository
    if (!(await pathExists(file.destination))) {
      const msg = `Source not found in repository: ${file.source}`;
      logger.warning(msg);
      if (isJsonMode()) addJsonWarning(msg);
      continue;
    }

    // Dry run - just show what would happen
    if (options.dryRun) {
      if (file.existsAtTarget) {
        logger.file('modify', `${file.source} (would overwrite)`);
      } else {
        logger.file('add', `${file.source} (would create)`);
      }
      continue;
    }

    // Create backup if needed. Gate on the ACTUAL write target's existence
    // (targetPath), not file.existsAtTarget — the latter is computed against the
    // REAL home, but in sandbox (--root) mode targetPath is the rebased sandbox
    // path, so a missing sandbox file would make createBackup throw and abort the
    // whole restore. Skip backups entirely under --root: the sandbox is a
    // throwaway dry home and createBackup would otherwise write into the real
    // home's backup dir.
    if (shouldBackup && !isSandbox() && (await pathExists(targetPath))) {
      await withSpinner(`Backing up ${file.source}...`, async () => {
        await createBackup(targetPath, config.files.backupDir, tuckDir);
      });
    }

    // Template/encrypted files are COPY-ONLY: they must be decrypted/rendered into
    // place, never SYMLINKED — a symlink would expose raw TCKE1 ciphertext or the
    // {{ }} template source at the live path. Force copy+materialize for them even
    // when the symlink strategy is otherwise in effect (--symlink / config).
    // JSON-key files are ALSO copy/merge-only: symlinking would expose the
    // subtree AS the whole live file and drop every other key.
    const linkThisFile = useSymlink && !file.template && !file.encrypted && !file.jsonKey;

    // Pre-materialize template/encrypted files (decrypt/render) BEFORE any write,
    // so a failed / absent-passphrase decryption skips this file and never ships
    // ciphertext or partial output. Directories fall through to a verbatim copy.
    let materialized: string | null = null;
    if (file.template || file.encrypted) {
      try {
        const isDir = (await stat(file.destination)).isDirectory();
        if (!isDir) {
          const raw = await readFile(file.destination);
          materialized = await materializeForLive(raw, file, ctx, { getPassphrase: keystorePassphrase });
        }
      } catch (err) {
        if (err instanceof MaterializeError) {
          logger.warning(err.message);
          if (isJsonMode()) addJsonWarning(err.message);
          skipped.push(file.source);
          continue;
        }
        throw err;
      }
    }

    // Restore file
    await withSpinner(`Restoring ${file.source}...`, async () => {
      if (file.jsonKey) {
        // Deep-merge the tracked subtree back into the live file, preserving
        // every other key (tokens, caches, machine state). A backup was already
        // taken above when the live file existed.
        const repoSubtree = await readFile(file.destination, 'utf8');
        const liveContent = (await pathExists(targetPath)) ? await readFile(targetPath, 'utf8') : null;
        const merged = mergeSubtreeIntoLive(liveContent, repoSubtree, file.jsonKey);
        await ensureDir(dirname(targetPath));
        await writeFile(targetPath, merged, 'utf-8');
      } else if (linkThisFile) {
        await createSymlink(file.destination, targetPath, { overwrite: true });
      } else if (materialized !== null) {
        // Decrypted/rendered content written directly (not a raw repo copy).
        await ensureDir(dirname(targetPath));
        await writeFile(targetPath, materialized, 'utf-8');
      } else {
        await copyFileOrDir(file.destination, targetPath, { overwrite: true });
      }

      // Reapply the recorded permissions so a 0755 script restores executable
      // and a 0600 file is not left world-readable. Symlinks have no own mode,
      // so only copies are adjusted. The SSH/GPG fixups below still run and act
      // as a stricter safety floor for those directories.
      if (file.permissions && !linkThisFile) {
        try {
          await setFilePermissions(targetPath, file.permissions);
        } catch {
          // Permission set may fail on exotic filesystems / Windows — never fail
          // the restore over it.
        }
      }

      // Fix permissions on the RESOLVED target (the sandbox copy in --root
      // mode), never the real-home path.
      await fixSSHPermissions(targetPath);
      await fixGPGPermissions(targetPath);
    });

    restoredCount++;
    restoredPaths.push(targetPath);
  }

  // Restore secrets (replace placeholders with actual values)
  let secretsRestored = 0;
  let unresolvedPlaceholders: string[] = [];

  if (!options.noSecrets && !options.dryRun && restoredPaths.length > 0) {
    const secretCount = await getSecretCount(tuckDir);
    if (secretCount > 0) {
      const secretResult = await restoreSecrets(restoredPaths, tuckDir);
      secretsRestored = secretResult.totalRestored;
      unresolvedPlaceholders = secretResult.allUnresolved;
    }
  }

  // Run post-restore hook
  await runPostRestoreHook(tuckDir, hookOptions);

  return {
    restoredCount,
    secretsRestored,
    unresolvedPlaceholders,
    skipped,
  };
};

const runInteractiveRestore = async (tuckDir: string, options: RestoreOptions = {}): Promise<void> => {
  prompts.intro('tuck restore');

  // Get all tracked files
  const files = await prepareFilesToRestore(tuckDir);

  if (files.length === 0) {
    prompts.log.warning('No files to restore');
    prompts.note("Run 'tuck add <path>' to track files first", 'Tip');
    return;
  }

  // Let user select files to restore
  const fileOptions = files.map((file) => {
    const categoryConfig = CATEGORIES[file.category] || { icon: '📄' };
    const status = file.existsAtTarget ? c.yellow('(exists, will backup)') : '';

    return {
      value: file.id,
      label: `${categoryConfig.icon} ${file.source} ${status}`,
      hint: file.category,
    };
  });

  const selectedIds = await prompts.multiselect('Select files to restore:', fileOptions, {
    required: true,
  });

  if (selectedIds.length === 0) {
    prompts.cancel('No files selected');
    return;
  }

  const selectedFiles = files.filter((f) => selectedIds.includes(f.id));

  // Check for files that exist
  const existingFiles = selectedFiles.filter((f) => f.existsAtTarget);
  if (existingFiles.length > 0) {
    console.log();
    prompts.log.warning(
      `${existingFiles.length} file${existingFiles.length > 1 ? 's' : ''} will be backed up:`
    );
    existingFiles.forEach((f) => console.log(c.dim(`  ${f.source}`)));
    console.log();
  }

  // Ask about strategy
  const useSymlink = await prompts.select('Restore method:', [
    { value: false, label: 'Copy files', hint: 'Recommended' },
    { value: true, label: 'Create symlinks', hint: 'Files stay in tuck repo' },
  ]);

  // Confirm
  const confirm = await prompts.confirm(
    `Restore ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}?`,
    true
  );

  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Restore. Carry the ORIGINAL options through so flags the user set on the
  // command line (--dry-run, --no-hooks, --trust-hooks, --repo-root) are honored
  // in the interactive path too — the interactive picker only chooses the file
  // set, the symlink strategy, and forces a backup. Without the spread a
  // `tuck restore --dry-run` on a TTY would silently perform a REAL restore.
  const result = await restoreFilesInternal(tuckDir, selectedFiles, {
    ...options,
    symlink: useSymlink as boolean,
    backup: true,
  });

  console.log();

  // Display secret restoration info
  if (result.secretsRestored > 0) {
    prompts.log.success(`Restored ${result.secretsRestored} secret${result.secretsRestored !== 1 ? 's' : ''}`);
  }
  if (result.unresolvedPlaceholders.length > 0) {
    prompts.log.warning(
      `${result.unresolvedPlaceholders.length} unresolved placeholder${result.unresolvedPlaceholders.length !== 1 ? 's' : ''}:`
    );
    result.unresolvedPlaceholders.slice(0, 5).forEach((p) => console.log(c.dim(`  {{${p}}}`)));
    if (result.unresolvedPlaceholders.length > 5) {
      console.log(c.dim(`  ... and ${result.unresolvedPlaceholders.length - 5} more`));
    }
    prompts.note("Use 'tuck secrets set <NAME>' to add missing secrets", 'Tip');
  }

  prompts.outro(`Restored ${result.restoredCount} file${result.restoredCount !== 1 ? 's' : ''}`);
};

/**
 * Display secret restoration summary
 */
const displaySecretSummary = (result: RestoreResult): void => {
  if (result.secretsRestored > 0) {
    logger.success(`Restored ${result.secretsRestored} secret${result.secretsRestored !== 1 ? 's' : ''}`);
  }
  if (result.unresolvedPlaceholders.length > 0) {
    logger.warning(
      `${result.unresolvedPlaceholders.length} unresolved placeholder${result.unresolvedPlaceholders.length !== 1 ? 's' : ''}:`
    );
    result.unresolvedPlaceholders.slice(0, 5).forEach((p) => console.log(c.dim(`  {{${p}}}`)));
    if (result.unresolvedPlaceholders.length > 5) {
      console.log(c.dim(`  ... and ${result.unresolvedPlaceholders.length - 5} more`));
    }
    logger.info("Use 'tuck secrets set <NAME>' to add missing secrets");
  }
};

/**
 * Run restore programmatically (exported for use by other commands)
 */
export const runRestore = async (options: RestoreOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Run interactive restore when called programmatically with --all
  if (options.all) {
    // Prepare files to restore
    const files = await prepareFilesToRestore(tuckDir, undefined);

    if (files.length === 0) {
      // In JSON mode the caller owns the envelope; never write loose stdout.
      if (!isJsonMode()) logger.warning('No files to restore');
      return;
    }

    // Restore files with progress
    const result = await restoreFilesInternal(tuckDir, files, options);

    // runRestore is called from other commands' JSON paths (e.g. `tuck pull
    // --json --restore`). Human output here would corrupt the single-JSON-object
    // contract, so route it into the shared warnings buffer instead of stdout.
    if (isJsonMode()) {
      for (const placeholder of result.unresolvedPlaceholders) {
        addJsonWarning(`Unresolved placeholder: {{${placeholder}}}`);
      }
    } else {
      logger.blank();
      displaySecretSummary(result);
      logger.success(
        `Restored ${result.restoredCount} file${result.restoredCount !== 1 ? 's' : ''}`
      );
    }
  } else {
    await runInteractiveRestore(tuckDir, options);
  }
};

/**
 * Refuse to restore "everything" implicitly in non-interactive mode. `--yes`
 * means "skip the confirmation prompt", NOT "expand scope to all tracked
 * files". Without this, `tuck restore --yes` (no paths, no --all) would
 * silently overwrite every tracked dotfile on the live system. The caller must
 * pass explicit paths or `--all`.
 */
export const assertRestoreScopeExplicit = (
  pathCount: number,
  options: { all?: boolean; yes?: boolean; json?: boolean }
): void => {
  if (pathCount === 0 && !options.all && (options.json || options.yes)) {
    throw new TuckError(
      'Refusing to restore: no paths given and --all not set. ' +
        'In non-interactive mode you must specify paths or pass --all explicitly.',
      'RESTORE_SCOPE_REQUIRED',
      ['tuck restore ~/.zshrc', 'tuck restore --all']
    );
  }
};

export const runRestoreCommand = async (paths: string[], options: RestoreOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck restore');
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Non-interactive callers must scope the restore explicitly (--yes is not
  // a license to overwrite every tracked file).
  assertRestoreScopeExplicit(paths.length, options);

  // If no paths and no --all and not in JSON/auto mode, run interactive
  if (paths.length === 0 && !options.all && !isJsonMode() && !options.yes) {
    await runInteractiveRestore(tuckDir, options);
    return;
  }

  // Prepare files to restore
  const files = await prepareFilesToRestore(tuckDir, options.all || paths.length === 0 ? undefined : paths);

  if (files.length === 0) {
    if (isJsonMode()) {
      emitJsonOk({ restored: 0, files: [] });
      return;
    }
    logger.warning('No files to restore');
    return;
  }

  // --plan: emit the operation plan without executing.
  if (options.plan) {
    if (isJsonMode()) {
      emitJsonOk({
        plan: files.map((f) => ({
          source: f.source,
          existsAtTarget: f.existsAtTarget,
          category: f.category,
        })),
      });
      return;
    }
    logger.heading('Plan — would restore:');
    for (const f of files) logger.file('add', f.source);
    return;
  }

  // Show what will be restored
  if (!isJsonMode()) {
    if (options.dryRun) logger.heading('Dry run - would restore:');
    else logger.heading('Restoring:');
  }

  // Restore files
  const result = await restoreFilesInternal(tuckDir, files, options);

  if (isJsonMode()) {
    emitJsonOk({
      restored: result.restoredCount,
      secretsRestored: result.secretsRestored,
      unresolvedPlaceholders: result.unresolvedPlaceholders,
      skipped: result.skipped,
      total: files.length,
      dryRun: !!options.dryRun,
    });
    return;
  }

  logger.blank();

  if (options.dryRun) {
    logger.info(`Would restore ${files.length} file${files.length > 1 ? 's' : ''}`);
  } else {
    displaySecretSummary(result);
    logger.success(`Restored ${result.restoredCount} file${result.restoredCount !== 1 ? 's' : ''}`);
  }
  if (result.skipped.length > 0) {
    logger.warning(
      `Skipped ${result.skipped.length} repo-scoped file${result.skipped.length !== 1 ? 's' : ''} (repo not bound on this machine)`
    );
  }
};

export const restoreCommand = new Command('restore')
  .description('Restore dotfiles to the system')
  .argument('[paths...]', 'Paths to restore (or use --all)')
  .option('-a, --all', 'Restore all tracked files')
  .option('--symlink', 'Create symlinks from source paths to tuck repo files')
  .option('--backup', 'Backup existing files before restore')
  .option('--no-backup', 'Skip backup of existing files')
  .option('--dry-run', 'Show what would be done')
  .option('--no-hooks', 'Skip execution of pre/post restore hooks')
  .option('--trust-hooks', 'Trust and run hooks without confirmation (use with caution)')
  .option('--no-secrets', 'Skip restoring secrets (keep placeholders as-is)')
  .option(
    '--repo-root <dir>',
    'Bind an as-yet-unknown repo-scoped repo to this directory before restoring its files'
  )
  .option('--json', 'Emit JSON envelope to stdout (suppresses interactive UI)')
  .option('-y, --yes', 'Auto-confirm prompts (required with --json for full automation)')
  .option('--plan', 'Print the operation plan and exit without restoring')
  .action(async (paths: string[], options: RestoreOptions) => {
    await runRestoreCommand(paths, options);
  });
