import { Command } from 'commander';
import { prompts, logger } from '../ui/index.js';
import { colors as c } from '../ui/theme.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import {
  getTuckDir,
  expandPath,
  pathExists,
  collapsePath,
  isDirectory,
  validateSafeSourcePath,
  getSafeRepoPathFromDestination,
} from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles, getTrackedFileBySource } from '../lib/manifest.js';
import { getDiff } from '../lib/git.js';
import {
  getFileChecksum,
  checkFileSizeThreshold,
  formatFileSize,
  getDirectoryFiles,
} from '../lib/files.js';
import { NotInitializedError, FileNotFoundError, PermissionError } from '../errors.js';
import { isBinaryExecutable } from '../lib/binary.js';
import { isIgnored } from '../lib/tuckignore.js';
import { resolveLiveTarget } from '../lib/repoScope.js';
import {
  materializeForLive,
  keystorePassphrase,
  buildMaterializeCtx,
} from '../lib/materialize.js';
import { enterReadOnlyMode, isReadOnlyMode } from '../lib/readOnlyMode.js';
import { compareLiveToCache } from '../lib/crypto/driftCache.js';
import {
  getStoredValueMap,
  getRedactedChecksum,
  redactValuesInContent,
} from '../lib/secrets/index.js';
import type { DiffOptions } from '../types.js';
import { readFile } from 'fs/promises';

export interface FileDiff {
  source: string;
  destination: string;
  hasChanges: boolean;
  isBinary?: boolean;
  isDirectory?: boolean;
  fileCount?: number;
  systemSize?: number;
  repoSize?: number;
  systemContent?: string;
  repoContent?: string;
  /**
   * Set for an ENCRYPTED file whose drift was detected in read-only mode via the
   * keyed-HMAC cache: we know it changed but deliberately did NOT decrypt the
   * repo copy, so the line-level diff is withheld (no keystore unlock, no prompt).
   */
  encryptedHidden?: boolean;
}

const isBinary = async (path: string): Promise<boolean> => {
  if (!(await pathExists(path))) {
    return false;
  }
  return await isBinaryExecutable(path);
};

export const getFileDiff = async (
  tuckDir: string,
  source: string,
  // Stored-secret value map (issue #100). Threaded from runDiff so it is built
  // ONCE per run; standalone callers may omit it and it is loaded lazily only in
  // the plain text/directory compare branches that actually need it.
  valueMap?: Map<string, string>
): Promise<FileDiff | null> => {
  const tracked = await getTrackedFileBySource(tuckDir, source);
  if (!tracked) {
    throw new FileNotFoundError(`Not tracked: ${source}`);
  }

  // Repo-scoped entries store `source` as `<repoKey>:<repoRelative>` and live
  // OUTSIDE $HOME, so home-confinement does not apply to them; resolve their
  // live path via the repo registry instead. Home-scoped entries keep the
  // home-safety guard.
  const isRepoScoped = tracked.file.scope === 'repo';
  if (!isRepoScoped) {
    validateSafeSourcePath(tracked.file.source);
  }
  const systemPath = await resolveLiveTarget(tracked.file);
  if (systemPath === null) {
    // Repo-scoped file whose repo is not bound on this machine — cannot compare,
    // so report no diff rather than fabricating a cwd-relative path.
    return null;
  }
  const repoPath = getSafeRepoPathFromDestination(tuckDir, tracked.file.destination);

  const diff: FileDiff = {
    source,
    destination: tracked.file.destination,
    hasChanges: false,
  };

  const systemExists = await pathExists(systemPath);
  const repoExists = await pathExists(repoPath);

  // Check if system file exists
  if (!systemExists) {
    diff.hasChanges = true;
    if (repoExists) {
      // Check if repo file is a directory
      if (await isDirectory(repoPath)) {
        diff.isDirectory = true;
        const files = await getDirectoryFiles(repoPath);
        diff.fileCount = files.length;
      } else {
        const repoContent = await readFile(repoPath, 'utf-8');
        diff.repoContent = repoContent;
        diff.repoSize = repoContent.length;
      }
    }
    return diff;
  }

  // Check if repo file exists
  if (!repoExists) {
    diff.hasChanges = true;
    // Check if system file is a directory
    if (await isDirectory(systemPath)) {
      diff.isDirectory = true;
      const files = await getDirectoryFiles(systemPath);
      diff.fileCount = files.length;
    } else {
      const systemContent = await readFile(systemPath, 'utf-8');
      // This branch dumps the WHOLE live file as systemContent — redact known
      // secrets before display so `tuck diff` never prints cleartext (#100).
      // systemSize stays the real (un-redacted) file length.
      const store = valueMap ?? (await getStoredValueMap(tuckDir));
      diff.systemContent =
        store.size > 0 ? redactValuesInContent(systemContent, store) : systemContent;
      diff.systemSize = systemContent.length;
    }
    return diff;
  }

  // Check if directory (both exist now)
  const systemIsDir = await isDirectory(systemPath);
  const repoIsDir = await isDirectory(repoPath);

  if (systemIsDir || repoIsDir) {
    diff.isDirectory = true;

    // Get file counts for directory summary
    if (systemIsDir) {
      const files = await getDirectoryFiles(systemPath);
      diff.fileCount = files.length;
    }
    if (repoIsDir) {
      const files = await getDirectoryFiles(repoPath);
      diff.fileCount = (diff.fileCount || 0) + files.length;
    }

    // Compare checksums for directories too
    const systemChecksum = await getFileChecksum(systemPath);
    const repoChecksum = await getFileChecksum(repoPath);
    let dirChanged = systemChecksum !== repoChecksum;
    // Placeholder-aware compare (issue #100): a tracked directory whose repo copy
    // holds redacted secrets always reads changed raw. Re-hash the live tree AS
    // IF its known secrets were redacted before deciding.
    if (dirChanged) {
      const store = valueMap ?? (await getStoredValueMap(tuckDir));
      if (store.size > 0 && (await getRedactedChecksum(systemPath, store)) === repoChecksum) {
        dirChanged = false;
      }
    }
    diff.hasChanges = dirChanged;

    return diff;
  }

  // Template/encrypted files: the repo copy holds SOURCE form (TCKE1 ciphertext
  // or un-rendered {{ }} template), so comparing raw bytes always reports a
  // change. Compare the live file against materialize(repo) instead — matching
  // the state model that `tuck verify`/`tuck status` use.
  if (tracked.file.template || tracked.file.encrypted) {
    // Read-only + ENCRYPTED: never decrypt. Decide changed/unchanged from the
    // keyed-HMAC cache (zero decryption, no keystore, no prompt) and withhold the
    // line-level diff rather than unlocking the repo copy. Pure templates touch
    // no secret and render cheaply, so they fall through to the normal path.
    if (tracked.file.encrypted && isReadOnlyMode()) {
      const liveBytes = await readFile(systemPath);
      const repoChecksum = await getFileChecksum(repoPath);
      const cmp = await compareLiveToCache(tracked.id, liveBytes, repoChecksum);
      if (cmp === 'mismatch') {
        diff.hasChanges = true;
        diff.encryptedHidden = true;
      }
      // 'match' or 'unknown' → no reportable diff in read-only mode.
      return diff;
    }

    let materialized: string;
    try {
      const ctx = await buildMaterializeCtx(tuckDir);
      const repoBytes = await readFile(repoPath);
      materialized = await materializeForLive(repoBytes, tracked.file, ctx, {
        getPassphrase: keystorePassphrase,
      });
    } catch {
      // Cannot materialize (locked keystore, missing passphrase, corrupt
      // ciphertext) — degrade to "no reportable diff" rather than emitting a
      // bogus hunk of ciphertext vs plaintext.
      return diff;
    }
    const systemContent = await readFile(systemPath, 'utf-8');
    if (systemContent !== materialized) {
      diff.hasChanges = true;
      // Both strings can carry cleartext secret values (raw live text, and the
      // materialized plaintext of an encrypted/template repo copy). Redact known
      // secrets before display so `tuck diff` never prints cleartext (#100) —
      // same lazy store load the plain-text branch below uses.
      const store = valueMap ?? (await getStoredValueMap(tuckDir));
      if (store.size > 0) {
        diff.systemContent = redactValuesInContent(systemContent, store);
        diff.repoContent = redactValuesInContent(materialized, store);
      } else {
        diff.systemContent = systemContent;
        diff.repoContent = materialized;
      }
    }
    return diff;
  }

  // Check if binary
  const systemIsBinary = await isBinary(systemPath);
  const repoIsBinary = await isBinary(repoPath);

  if (systemIsBinary || repoIsBinary) {
    diff.isBinary = true;

    // Compare binary files using checksums
    const systemChecksum = await getFileChecksum(systemPath);
    const repoChecksum = await getFileChecksum(repoPath);
    diff.hasChanges = systemChecksum !== repoChecksum;

    try {
      const systemBuffer = await readFile(systemPath);
      diff.systemSize = systemBuffer.length;
    } catch {
      // Ignore read errors for binaries
    }
    try {
      const repoBuffer = await readFile(repoPath);
      diff.repoSize = repoBuffer.length;
    } catch {
      // Ignore read errors for binaries
    }
    return diff;
  }

  // Check file size for large files
  try {
    const systemSizeCheck = await checkFileSizeThreshold(systemPath);
    const repoSizeCheck = await checkFileSizeThreshold(repoPath);

    diff.systemSize = systemSizeCheck.size;
    diff.repoSize = repoSizeCheck.size;
  } catch {
    // Size check failed, continue with diff
  }

  // Compare checksums for text files
  const systemChecksum = await getFileChecksum(systemPath);
  const repoChecksum = await getFileChecksum(repoPath);

  // Placeholder-aware compare (issue #100): the repo copy is redacted while the
  // live file keeps its real secrets, so raw checksums always differ for a
  // secret-bearing file. Compare the live file hashed AS IF its known secrets
  // were redacted, and — critically — display the REDACTED live content so
  // `tuck diff` never prints a cleartext secret to the terminal. The lazy store
  // load lives INSIDE the mismatch branch (like the directory branch above) so a
  // raw-equal file never touches the secrets store at all.
  if (systemChecksum !== repoChecksum) {
    const store = valueMap ?? (await getStoredValueMap(tuckDir));
    const redactAware = store.size > 0;
    if (redactAware && (await getRedactedChecksum(systemPath, store)) === repoChecksum) {
      return diff; // differs from repo ONLY by placeholder substitution — clean
    }

    diff.hasChanges = true;
    const rawSystemContent = await readFile(systemPath, 'utf-8');
    diff.systemContent = redactAware
      ? redactValuesInContent(rawSystemContent, store)
      : rawSystemContent;
    diff.repoContent = await readFile(repoPath, 'utf-8');
  }

  return diff;
};

const formatUnifiedDiff = (diff: FileDiff): string => {
  const lines: string[] = [];

  lines.push(c.bold(`--- a/${diff.source} (system)`));
  lines.push(c.bold(`+++ b/${diff.source} (repository)`));

  if (diff.isBinary) {
    const sysSize = diff.systemSize ? formatFileSize(diff.systemSize) : '0 B';
    const repoSize = diff.repoSize ? formatFileSize(diff.repoSize) : '0 B';
    lines.push(c.dim('Binary files differ'));
    lines.push(c.dim(`  System:  ${sysSize}`));
    lines.push(c.dim(`  Repo:    ${repoSize}`));
    return lines.join('\n');
  }

  if (diff.isDirectory) {
    const fileCount = diff.fileCount || 0;
    lines.push(c.dim('Directory content changed'));
    lines.push(c.dim(`  Contains ${fileCount} file${fileCount > 1 ? 's' : ''}`));
    return lines.join('\n');
  }

  if (diff.encryptedHidden) {
    lines.push(c.yellow('Encrypted file changed'));
    lines.push(c.dim('  Contents hidden — read-only diff never decrypts.'));
    lines.push(c.dim("  Run 'tuck verify' or 'tuck apply' for a full comparison."));
    return lines.join('\n');
  }

  const { systemContent, repoContent } = diff;

  // Check if systemContent is explicitly undefined (missing) vs empty string
  const systemMissing = systemContent === undefined;
  const repoMissing = repoContent === undefined;

  if (systemMissing && !repoMissing) {
    // File only in repo
    lines.push(c.red('File missing on system'));
    lines.push(c.dim('Repository content:'));
    repoContent!.split('\n').forEach((line) => {
      lines.push(c.green(`+ ${line}`));
    });
  } else if (!systemMissing && repoMissing) {
    // File only on system
    lines.push(c.yellow('File not yet synced to repository'));
    lines.push(c.dim('System content:'));
    systemContent!.split('\n').forEach((line) => {
      lines.push(c.red(`- ${line}`));
    });
  } else if (!systemMissing && !repoMissing) {
    // Both files exist (may be empty)
    const CONTEXT_LINES = 3;
    const systemLines = systemContent!.split('\n');
    const repoLines = repoContent!.split('\n');

    const maxLines = Math.max(systemLines.length, repoLines.length);

    let inDiff = false;
    // Count consecutive equal lines emitted as trailing context inside the
    // current hunk. Once CONTEXT_LINES equal lines have been shown we CLOSE the
    // hunk (inDiff = false) so a later change opens a fresh `@@` hunk instead of
    // dumping the entire remainder of the file as "context" (which flooded the
    // terminal for a one-line change in a large dotfile).
    let trailingContext = 0;
    // Highest source-line index already emitted as context, so a new hunk's
    // preceding-context window never re-prints lines shown by the previous hunk.
    let lastEmitted = -1;

    for (let i = 0; i < maxLines; i++) {
      const sysLine = systemLines[i];
      const repoLine = repoLines[i];

      if (sysLine !== repoLine) {
        if (!inDiff) {
          inDiff = true;
          const diffStart = i;
          const startLine = Math.max(0, diffStart - CONTEXT_LINES + 1);
          const contextLineCount = Math.min(diffStart, CONTEXT_LINES);
          const endLine = Math.min(maxLines, diffStart + CONTEXT_LINES + 1);

          lines.push(
            c.cyan(
              `@@ -${startLine + 1},${contextLineCount + 1} +${startLine + 1},${endLine - startLine} @@`
            )
          );

          // Print preceding context, skipping any line already emitted as the
          // trailing context of an earlier hunk.
          for (let j = Math.max(startLine, lastEmitted + 1); j < i; j++) {
            const ctxLine = systemLines[j];
            if (ctxLine !== undefined) {
              lines.push(c.dim(`  ${ctxLine}`));
              lastEmitted = j;
            }
          }
        }

        trailingContext = 0;
        if (sysLine !== undefined) {
          lines.push(c.red(`- ${sysLine}`));
        }
        if (repoLine !== undefined) {
          lines.push(c.green(`+ ${repoLine}`));
        }
        lastEmitted = i;
      } else if (inDiff) {
        // Equal line while inside a hunk — show a bounded amount of trailing
        // context, then close the hunk so the rest of the file isn't printed.
        if (trailingContext < CONTEXT_LINES) {
          if (sysLine !== undefined) {
            lines.push(c.dim(`  ${sysLine}`));
            lastEmitted = i;
          }
          trailingContext++;
          if (trailingContext >= CONTEXT_LINES) {
            inDiff = false;
          }
        } else {
          inDiff = false;
        }
      }
    }
  }

  return lines.join('\n');
};

const runDiff = async (paths: string[], options: DiffOptions): Promise<void> => {
  // diff is a read-only inspection command: it must never unlock the keystore or
  // touch a secret backend. This guarantees zero prompts (see lib/readOnlyMode).
  enterReadOnlyMode();
  if (options.json) setJsonMode(true, 'tuck diff');
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // If --staged, show git diff
  if (options.staged) {
    const diff = await getDiff(tuckDir, { staged: true, stat: options.stat });
    if (isJsonMode()) {
      emitJsonOk({ staged: true, diff: diff ?? '' });
      return;
    }
    if (diff) {
      console.log(diff);
    } else {
      logger.info('No staged changes');
    }
    return;
  }

  // Get all tracked files
  const allFiles = await getAllTrackedFiles(tuckDir);
  const changedFiles: FileDiff[] = [];

  // Build the stored-secret value map ONCE and thread it into every getFileDiff
  // call so placeholder-aware compare doesn't re-read the store per file (#100).
  const valueMap = await getStoredValueMap(tuckDir);

  // If no paths specified, check all files
  const filesToCheck =
    paths.length === 0
      ? Object.values(allFiles)
      : paths.map((path) => {
          const expandedPath = expandPath(path);
          const collapsedPath = collapsePath(expandedPath);
          const tracked = Object.entries(allFiles).find(([, f]) => f.source === collapsedPath);
          if (!tracked) {
            throw new FileNotFoundError(`Not tracked: ${path}`);
          }
          return tracked[1];
        });

  // Check each file for changes
  for (const file of filesToCheck) {
    // Skip if category filter is set and doesn't match
    if (options.category && file.category !== options.category) {
      continue;
    }

    // Skip if in .tuckignore
    if (await isIgnored(tuckDir, file.source)) {
      continue;
    }

    try {
      const diff = await getFileDiff(tuckDir, file.source, valueMap);
      if (diff && diff.hasChanges) {
        changedFiles.push(diff);
      }
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        logger.warning(`File not found: ${file.source}`);
      } else if (error instanceof PermissionError) {
        logger.warning(`Permission denied: ${file.source}`);
      } else {
        throw error;
      }
    }
  }

  if (isJsonMode()) {
    emitJsonOk({
      count: changedFiles.length,
      files: changedFiles.map((d) => ({
        source: d.source,
        destination: d.destination,
        isBinary: d.isBinary ?? false,
        isDirectory: d.isDirectory ?? false,
        hasChanges: d.hasChanges,
        systemSize: d.systemSize,
        repoSize: d.repoSize,
        // Content is intentionally omitted from JSON output unless --stat is
        // off and the consumer asks for it; keeping the envelope small.
      })),
    });
    if (options.exitCode && changedFiles.length > 0) process.exit(1);
    return;
  }

  if (changedFiles.length === 0) {
    if (paths.length > 0) {
      logger.success('No differences found');
    } else {
      prompts.intro('tuck diff');
      console.log();
      logger.success('No differences found');
      console.log();
    }
    return;
  }

  prompts.intro('tuck diff');
  console.log();

  // Show stats/name-only if requested
  if (options.stat || options.nameOnly) {
    const label = options.nameOnly
      ? 'Changed files:'
      : `${changedFiles.length} file${changedFiles.length > 1 ? 's' : ''} changed:`;
    console.log(c.bold(label));
    console.log();

    for (const diff of changedFiles) {
      const status = diff.isDirectory ? c.dim('[dir]') : diff.isBinary ? c.dim('[bin]') : '';
      console.log(`  ${c.yellow('~')} ${diff.source} ${status}`);
    }

    console.log();
    prompts.outro(`Found ${changedFiles.length} changed file(s)`);
    // --exit-code must still fire in the stat/name-only path (this branch is
    // only reached when changedFiles.length > 0), or CI drift checks like
    // `tuck diff --name-only --exit-code` would exit 0 despite real drift.
    if (options.exitCode) {
      process.exit(1);
    }
    return;
  }

  // Show full diff for each file
  for (const diff of changedFiles) {
    console.log(formatUnifiedDiff(diff));
    console.log();
  }

  prompts.outro(`Found ${changedFiles.length} changed file(s)`);

  // Return exit code 1 if differences found and --exit-code is set
  if (options.exitCode) {
    process.exit(1);
  }
};

export { runDiff, formatUnifiedDiff };

export const diffCommand = new Command('diff')
  .description('Show differences between system and repository')
  .argument('[paths...]', 'Specific files to diff')
  .option('--staged', 'Show staged git changes')
  .option('--stat', 'Show diffstat only')
  .option(
    '--category <category>',
    'Filter by file category (shell, git, editors, terminal, ssh, misc)'
  )
  .option('--name-only', 'Show only changed file names')
  .option('--exit-code', 'Return exit code 1 if differences found')
  .option('--json', 'Emit JSON envelope to stdout (suppresses interactive UI)')
  .action(async (paths: string[], options: DiffOptions) => {
    await runDiff(paths, options);
  });
