import { basename, relative } from 'path';
import { colors as c, logger, prompts } from '../ui/index.js';
import {
  collapsePath,
  detectCategory,
  getDestinationPathFromSource,
  getRepoScopedDestination,
  expandPath,
  isDirectory,
  pathExists,
  sanitizeFilename,
  validateSafeSourcePath,
  validateSafeRepoSourcePath,
} from './paths.js';
import { findGitRoot, deriveRepoKey } from './repoScope.js';
import { toPosixPath } from './platform.js';
import { isFileTracked } from './manifest.js';
import { checkFileSizeThreshold, formatFileSize, getDirectoryFileCount, getDirectoryFiles } from './files.js';
import { shouldExcludeFromBin } from './binary.js';
import { addToTuckignore, isIgnored } from './tuckignore.js';
import {
  FileAlreadyTrackedError,
  FileNotFoundError,
  JsonKeyError,
  OperationCancelledError,
  PrivateKeyError,
  SecretsDetectedError,
} from '../errors.js';
import { extractSubtree } from './jsonKey.js';
import { readFile } from 'fs/promises';
import { scanContent } from './secrets/index.js';
import { logForceSecretBypass, logSecretAllowlisted } from './audit.js';
import { isJsonMode } from './jsonOutput.js';
import {
  getSecretsPath,
  getAllowlistPath,
  isSecretScanningEnabled,
  processSecretsForRedaction,
  scanForSecrets,
  shouldBlockOnSecrets,
  addAllowlistEntryByFingerprint,
  computeFingerprint,
  type ScanSummary,
  type SecretMatch,
} from './secrets/index.js';

const PRIVATE_KEY_PATTERNS = [
  /^id_rsa$/,
  /^id_dsa$/,
  /^id_ecdsa$/,
  /^id_ed25519$/,
  /^id_.*$/,
  /\.pem$/,
  /\.key$/,
  /^.*_key$/,
];

const SENSITIVE_FILE_PATTERNS = [
  /^\.netrc$/,
  /^\.aws\/credentials$/,
  /^\.docker\/config\.json$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.kube\/config$/,
  /^\.ssh\/config$/,
  /^\.gnupg\//,
  /credentials/i,
  /secrets?/i,
  /tokens?\.json$/i,
  /\.env$/,
  /\.env\./,
];

export interface TrackPathCandidate {
  path: string;
  category?: string;
  name?: string;
}

export interface PreparedTrackFile {
  source: string;
  destination: string;
  category: string;
  filename: string;
  nameOverride?: string;
  isDir: boolean;
  fileCount: number;
  sensitive: boolean;
  /**
   * Tracking scope. Absent (or 'home') means a home-scoped file resolved
   * against $HOME exactly as before. 'repo' means the file lives inside a git
   * repo whose absolute path differs per machine; it is identified by a stable
   * (repoKey, repoRelative) pair.
   */
  scope?: 'home' | 'repo';
  /** Stable cross-machine repo identity (repo scope only). */
  repoKey?: string;
  /** POSIX path relative to the repo root (repo scope only). */
  repoRelative?: string;
  /** Absolute repo root on THIS machine (repo scope only; not committed). */
  repoRoot?: string;
  /** Canonicalized remote URL discovered while deriving the key, if any. */
  remoteUrl?: string;
  /** Absolute live path to copy FROM (repo scope only). */
  liveSource?: string;
  /**
   * Dot-delimited JSON key path when tracking only a subtree of a JSON file
   * (e.g. `mcpServers`). The repo copy holds just that subtree.
   */
  jsonKey?: string;
  /** Redaction plans for secret-bearing files: applied to the REPO copy after
   *  the copy step; the live file is never modified (issue #100 RC5). For a
   *  tracked DIRECTORY, livePath points at the inner file that holds the secret. */
  redactions?: Array<{
    livePath: string;
    matches: SecretMatch[];
    placeholderMap: Map<string, string>;
  }>;
}

export interface PreparePathsForTrackingOptions {
  category?: string;
  name?: string;
  force?: boolean;
  allowAlreadyTracked?: boolean;
  secretHandling?: 'interactive' | 'strict';
  forceBypassCommand?: string;
  /**
   * The batch is destined for at-rest encryption (`tuck add --encrypt`).
   * Redaction plans are skipped for encrypted repo copies (they store
   * ciphertext), so the redact action's messaging must not promise
   * placeholders that will never be written.
   */
  encrypt?: boolean;
  /**
   * Track candidates as REPO-scoped. `true` (or an empty string) means
   * "auto-detect the enclosing git root from each path"; a string is an
   * explicit repo root directory.
   */
  repo?: string | boolean;
  /** Explicit repoKey override (advanced; default derives from the remote). */
  repoKey?: string;
  /**
   * Track only the JSON subtree at this dot-delimited key path (e.g.
   * `mcpServers`) instead of the whole file.
   */
  jsonKey?: string;
}

const isPrivateKey = (collapsedPath: string): boolean => {
  const name = basename(collapsedPath);

  if (collapsedPath.includes('.ssh/') && !name.endsWith('.pub')) {
    return PRIVATE_KEY_PATTERNS.some((pattern) => pattern.test(name));
  }

  return name.endsWith('.pem') || name.endsWith('.key');
};

const isSensitiveFile = (collapsedPath: string): boolean => {
  const pathToTest = collapsedPath.startsWith('~/') ? collapsedPath.slice(2) : collapsedPath;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(pathToTest));
};

const displaySecretWarning = (summary: ScanSummary): void => {
  console.log();
  console.log(c.error(c.bold(`  Security Warning: Found ${summary.totalSecrets} potential secret(s)`)));
  console.log();

  for (const result of summary.results) {
    console.log(`  ${c.brand(result.collapsedPath)}`);

    for (const match of result.matches) {
      const severityColor =
        match.severity === 'critical'
          ? c.error
          : match.severity === 'high'
            ? c.warning
            : match.severity === 'medium'
              ? c.info
              : c.muted;

      console.log(
        `    ${c.muted(`Line ${match.line}:`)} ${match.redactedValue} ${severityColor(`[${match.severity}]`)}`
      );
    }
    console.log();
  }
};

const handleFileSizePolicy = async (
  collapsedPath: string,
  sizeBytes: number,
  tuckDir: string,
  secretHandling: 'interactive' | 'strict'
): Promise<boolean> => {
  const sizeLabel = formatFileSize(sizeBytes);
  const isWarn = sizeBytes >= 50 * 1024 * 1024;
  const isBlock = sizeBytes >= 100 * 1024 * 1024;

  if (!isWarn && !isBlock) {
    return true;
  }

  if (secretHandling === 'strict') {
    if (isBlock) {
      throw new OperationCancelledError('file size exceeds GitHub limit');
    }
    logger.warning(`File ${collapsedPath} is ${sizeLabel}. GitHub recommends files under 50MB.`);
    return true;
  }

  if (isBlock) {
    logger.warning(`File ${collapsedPath} is ${sizeLabel} (exceeds GitHub's 100MB limit)`);

    const action = await prompts.select('How would you like to proceed?', [
      { value: 'ignore', label: 'Add to .tuckignore and skip' },
      { value: 'cancel', label: 'Cancel operation' },
    ]);

    if (action === 'ignore') {
      await addToTuckignore(tuckDir, collapsedPath);
      logger.success(`Added ${collapsedPath} to .tuckignore`);
      return false;
    }

    throw new OperationCancelledError('file size exceeds GitHub limit');
  }

  logger.warning(`File ${collapsedPath} is ${sizeLabel}. GitHub recommends files under 50MB.`);
  const action = await prompts.select('How would you like to proceed?', [
    { value: 'continue', label: 'Track it anyway' },
    { value: 'ignore', label: 'Add to .tuckignore and skip' },
    { value: 'cancel', label: 'Cancel operation' },
  ]);

  if (action === 'ignore') {
    await addToTuckignore(tuckDir, collapsedPath);
    logger.success(`Added ${collapsedPath} to .tuckignore`);
    return false;
  }
  if (action === 'cancel') {
    throw new OperationCancelledError('file size warning');
  }

  return true;
};

const applySecretPolicy = async (
  files: PreparedTrackFile[],
  tuckDir: string,
  options: PreparePathsForTrackingOptions
): Promise<PreparedTrackFile[]> => {
  if (files.length === 0) {
    return files;
  }

  if (!(await isSecretScanningEnabled(tuckDir))) {
    return files;
  }

  const secretHandling = options.secretHandling ?? 'interactive';

  if (options.force) {
    if (secretHandling === 'interactive') {
      const confirmed = await prompts.confirmDangerous(
        'Using --force bypasses secret scanning.\n' +
          'Any secrets in these files may be committed to git and potentially exposed.',
        'force'
      );
      if (!confirmed) {
        logger.info('Operation cancelled');
        return [];
      }
    }
    logger.warning('Secret scanning bypassed with --force');
    await logForceSecretBypass(options.forceBypassCommand ?? 'tuck add --force', files.length);
    return files;
  }

  // Resolve each candidate to its LIVE path (repo-scoped entries carry a stable
  // `<repoKey>:<repoRelative>` source, so we must scan the live absolute path,
  // not the expanded identity string). DIRECTORY candidates must be expanded to
  // their contained files: the scanner skips a directory path outright
  // (skipReason 'Is a directory'), so without this a directory holding a
  // credentials file would pass the secret gate completely unscanned. We keep a
  // reverse map from each scanned file back to its owning candidate so the
  // ignore action can act on the right candidate regardless of scope.
  const scanPaths: string[] = [];
  const ownerByScanPath = new Map<string, PreparedTrackFile>();
  for (const file of files) {
    const live = file.liveSource ?? expandPath(file.source);
    if (await isDirectory(live)) {
      for (const inner of await getDirectoryFiles(live)) {
        scanPaths.push(inner);
        if (!ownerByScanPath.has(inner)) ownerByScanPath.set(inner, file);
      }
    } else {
      scanPaths.push(live);
      ownerByScanPath.set(live, file);
    }
  }

  const summary = await scanForSecrets(scanPaths, tuckDir);

  if (summary.filesWithSecrets === 0) {
    return files;
  }

  if (secretHandling === 'strict') {
    const shouldBlock = await shouldBlockOnSecrets(tuckDir);
    if (shouldBlock) {
      const filesWithSecrets = summary.results
        .filter((result) => result.hasSecrets)
        .map((result) => collapsePath(result.path));
      throw new SecretsDetectedError(summary.totalSecrets, filesWithSecrets);
    }
    logger.warning('Secrets detected but blockOnSecrets is disabled - proceeding with tracking');
    logger.warning('Make sure your repository is private!');
    return files;
  }

  displaySecretWarning(summary);

  const action = await prompts.select('How would you like to proceed?', [
    { value: 'abort', label: 'Abort operation', hint: 'Do not track these files' },
    {
      value: 'redact',
      label: 'Replace with placeholders',
      hint: 'Repo copy gets placeholders; live file untouched. Originals in secrets.local.json (never committed)',
    },
    {
      value: 'allow',
      label: 'Mark as safe (allowlist)',
      hint: 'False positive? Record in secrets.allow.json and track',
    },
    { value: 'ignore', label: 'Add files to .tuckignore', hint: 'Skip these files permanently' },
    { value: 'proceed', label: 'Proceed anyway', hint: 'Track files with secrets (dangerous!)' },
  ]);

  if (action === 'abort') {
    logger.info('Operation aborted');
    return [];
  }

  if (action === 'allow') {
    const reason = await prompts.text(
      'Why are these findings safe? (recorded in the allowlist)',
      { placeholder: 'e.g. example values from docs, not real secrets' }
    );
    if (!reason || reason.trim().length === 0) {
      logger.info('Operation aborted (a reason is required to allowlist)');
      return [];
    }
    let allowlisted = 0;
    for (const result of summary.results) {
      if (!result.hasSecrets) continue;
      for (const match of result.matches) {
        const entry = await addAllowlistEntryByFingerprint(
          tuckDir,
          computeFingerprint(match.value),
          { reason: reason.trim(), pattern: match.patternId, path: result.collapsedPath }
        );
        await logSecretAllowlisted(entry.fingerprint, entry.reason, {
          pattern: entry.pattern,
          path: entry.path,
        });
        allowlisted++;
      }
    }
    console.log();
    logger.success(`Allowlisted ${allowlisted} finding${allowlisted === 1 ? '' : 's'} as safe`);
    logger.dim(`Recorded in ${collapsePath(getAllowlistPath(tuckDir))} (commit it to share)`);
    console.log();
    return files;
  }

  if (action === 'redact') {
    // Repo-only redaction (issue #100 RC5): store the secrets and attach a
    // redaction PLAN to each owning candidate. The plan is applied to the
    // repository copy AFTER it is copied (in fileTracking) — the live file in
    // $HOME is never rewritten, so the user's shell/config keeps working.
    const redactionMaps = await processSecretsForRedaction(summary.results, tuckDir);
    let planned = 0;
    for (const result of summary.results) {
      const placeholderMap = redactionMaps.get(result.path);
      if (!placeholderMap || placeholderMap.size === 0) continue;
      const owner = ownerByScanPath.get(result.path);
      if (!owner) {
        // A dropped plan means the file would be tracked with its secrets in
        // CLEARTEXT — never let that happen silently.
        logger.warning(
          `No tracking candidate matched scan result ${collapsePath(result.path)} — its secrets will NOT be redacted`
        );
        continue;
      }
      (owner.redactions ??= []).push({
        livePath: result.path,
        matches: result.matches,
        placeholderMap,
      });
      // Count actual planned replacements, not raw matches (overlapping or
      // unmapped matches carry no placeholder and are never rewritten).
      planned += result.matches.filter((match) => placeholderMap.has(match.value)).length;
    }

    console.log();
    if (options.encrypt) {
      // Encrypted repo copies are ciphertext — redaction plans are skipped for
      // them (fileTracking), so do not promise placeholders here.
      logger.success(`Stored ${planned} secret(s) in the local secrets store`);
      logger.dim('Encrypted files store ciphertext in the repo — placeholders are not applied');
      logger.dim('Your live files are left untouched');
    } else {
      logger.success(`Will replace ${planned} secret(s) with placeholders in the repository copy`);
      logger.dim('Your live files are left untouched');
    }
    logger.dim(`Secrets stored in: ${collapsePath(getSecretsPath(tuckDir))} (never committed)`);
    console.log();
    return files;
  }

  if (action === 'ignore') {
    // Map each secret-bearing scan result back to its OWNING candidate via the
    // reverse map. Matching on collapsePath(file.source) is wrong for repo files
    // (source is the `<repoKey>:<repoRelative>` identity, never a live path) and
    // for directory candidates (the secret lives in an inner file, not the dir),
    // so those files silently escaped the filter and were tracked anyway.
    const owners = new Set<PreparedTrackFile>();
    for (const result of summary.results) {
      if (!result.hasSecrets) continue;
      const owner = ownerByScanPath.get(result.path);
      if (owner) owners.add(owner);
    }

    for (const file of owners) {
      // Home files are ignored by their home-relative identity; repo files have
      // no home-relative form, so record their collapsed live path instead.
      const ignoreKey =
        file.scope === 'repo' ? collapsePath(file.liveSource ?? file.source) : file.source;
      await addToTuckignore(tuckDir, ignoreKey);
      logger.success(`Added ${ignoreKey} to .tuckignore`);
    }

    const remaining = files.filter((file) => !owners.has(file));
    if (remaining.length === 0) {
      logger.info('No files remaining to track');
    }
    return remaining;
  }

  const confirmed = await prompts.confirm(
    c.error('Are you SURE you want to track files containing secrets?'),
    false
  );
  if (!confirmed) {
    logger.info('Operation aborted');
    return [];
  }

  logger.warning('Proceeding with secrets - be careful not to push to a public repository!');
  return files;
};

/**
 * Secret gate for JSON-key files: scans ONLY the extracted subtree (the bytes
 * that will actually land in the repo), not the whole live file. This is what
 * makes the feature usable — a `~/.claude.json` mixes `mcpServers` with OAuth
 * tokens and history, and scanning the whole file would block tracking the
 * safe subtree. Mirrors {@link applySecretPolicy}'s force/strict/interactive
 * decision structure at a subtree granularity (redact/ignore are omitted: a
 * placeholder rewrite of a temporary in-memory subtree has nothing to persist).
 */
const applyJsonKeySecretPolicy = async (
  files: PreparedTrackFile[],
  tuckDir: string,
  options: PreparePathsForTrackingOptions
): Promise<PreparedTrackFile[]> => {
  if (files.length === 0) return files;
  if (!(await isSecretScanningEnabled(tuckDir))) return files;

  const secretHandling = options.secretHandling ?? 'interactive';

  if (options.force) {
    if (secretHandling === 'interactive') {
      const confirmed = await prompts.confirmDangerous(
        'Using --force bypasses secret scanning.\n' +
          'Any secrets in the tracked JSON subtree may be committed to git and potentially exposed.',
        'force'
      );
      if (!confirmed) {
        logger.info('Operation cancelled');
        return [];
      }
    }
    logger.warning('Secret scanning bypassed with --force');
    await logForceSecretBypass(options.forceBypassCommand ?? 'tuck add --force', files.length);
    return files;
  }

  // Scan each subtree independently so a finding maps back to exactly one file.
  const withSecrets: Array<{ file: PreparedTrackFile; count: number }> = [];
  for (const file of files) {
    const live = file.liveSource ?? expandPath(file.source);
    const content = await readFile(live, 'utf8');
    const subtree = extractSubtree(content, file.jsonKey as string);
    const matches = scanContent(subtree);
    if (matches.length > 0) {
      withSecrets.push({ file, count: matches.length });
    }
  }

  if (withSecrets.length === 0) return files;

  const totalSecrets = withSecrets.reduce((sum, w) => sum + w.count, 0);
  const affected = withSecrets.map((w) => `${collapsePath(w.file.source)} (--key ${w.file.jsonKey})`);

  if (secretHandling === 'strict') {
    if (await shouldBlockOnSecrets(tuckDir)) {
      throw new SecretsDetectedError(totalSecrets, affected);
    }
    logger.warning('Secrets detected in a tracked JSON subtree but blockOnSecrets is disabled - proceeding');
    logger.warning('Make sure your repository is private!');
    return files;
  }

  console.log();
  console.log(
    c.error(c.bold(`  Security Warning: Found ${totalSecrets} potential secret(s) in the tracked JSON subtree`))
  );
  for (const entry of affected) {
    console.log(`    ${c.brand(entry)}`);
  }
  console.log();

  const proceed = await prompts.confirm(
    c.error('The tracked JSON subtree contains potential secrets. Track it anyway?'),
    false
  );
  if (!proceed) {
    logger.info('Operation aborted');
    return [];
  }
  logger.warning('Proceeding with secrets - make sure your repository is private!');
  return files;
};

export const preparePathsForTracking = async (
  candidates: TrackPathCandidate[],
  tuckDir: string,
  options: PreparePathsForTrackingOptions = {}
): Promise<PreparedTrackFile[]> => {
  const secretHandling = options.secretHandling ?? 'interactive';
  const prepared: PreparedTrackFile[] = [];
  const isRepoScoped = options.repo !== undefined && options.repo !== false;
  const jsonKey = options.jsonKey?.trim() ? options.jsonKey.trim() : undefined;

  // JSON-key tracking is a home-scoped, single-file operation in v1: it extracts
  // one JSON subtree per file. Repo-scoped or multi-path combos are rejected up
  // front so the user gets a clear message instead of a confusing partial result.
  if (jsonKey) {
    if (isRepoScoped) {
      throw new JsonKeyError('--key cannot be combined with --repo (v1 tracks JSON subtrees home-scoped only)');
    }
    if (candidates.length !== 1) {
      throw new JsonKeyError('--key tracks a single JSON file; pass exactly one path');
    }
  }

  for (const candidate of candidates) {
    const expandedPath = expandPath(candidate.path);

    // For repo-scoped tracking the live file may be OUTSIDE $HOME, so we resolve
    // a stable (repoKey, repoRelative) identity instead of a home-relative path.
    let repoMeta: {
      repoKey: string;
      repoRelative: string;
      repoRoot: string;
      remoteUrl?: string;
    } | null = null;

    if (isRepoScoped) {
      const explicitRoot =
        typeof options.repo === 'string' && options.repo.trim() ? options.repo.trim() : undefined;
      const repoRoot = explicitRoot
        ? expandPath(explicitRoot)
        : await findGitRoot(expandedPath);
      if (!repoRoot) {
        throw new FileNotFoundError(
          `${candidate.path} (no enclosing git repository found for --repo)`
        );
      }

      const repoRelative = toPosixPath(relative(repoRoot, expandedPath));
      // Confine the file to the repo root and reject `..`/absolute escapes.
      validateSafeRepoSourcePath(repoRoot, repoRelative);

      const { repoKey, remoteUrl } = await deriveRepoKey(repoRoot, { repoKey: options.repoKey });
      repoMeta = { repoKey, repoRelative, repoRoot, remoteUrl };
    }

    // The label used for already-tracked / ignored / display checks. Repo files
    // are identified by their stable identity, never a home-relative path.
    const trackingId = repoMeta
      ? `${repoMeta.repoKey}:${repoMeta.repoRelative}`
      : collapsePath(expandedPath);

    if (!repoMeta) {
      validateSafeSourcePath(trackingId);
    }

    if (!repoMeta && isPrivateKey(trackingId)) {
      throw new PrivateKeyError(candidate.path);
    }

    if (!(await pathExists(expandedPath))) {
      throw new FileNotFoundError(candidate.path);
    }

    if (!options.allowAlreadyTracked && (await isFileTracked(tuckDir, trackingId))) {
      throw new FileAlreadyTrackedError(candidate.path);
    }

    if (!repoMeta && (await isIgnored(tuckDir, trackingId))) {
      // Suppressed in --json mode so stdout stays a single JSON envelope.
      if (!isJsonMode()) logger.info(`Skipping ${trackingId} (in .tuckignore)`);
      continue;
    }

    if (await shouldExcludeFromBin(expandedPath)) {
      const sizeCheck = await checkFileSizeThreshold(expandedPath);
      if (!isJsonMode()) {
        logger.info(
          `Skipping binary executable: ${trackingId}` +
            `${sizeCheck.size > 0 ? ` (${formatFileSize(sizeCheck.size)})` : ''}` +
            ' - Add to .tuckignore to customize'
        );
      }
      continue;
    }

    const sizeCheck = await checkFileSizeThreshold(expandedPath);
    const shouldTrack = await handleFileSizePolicy(
      trackingId,
      sizeCheck.size,
      tuckDir,
      secretHandling
    );
    if (!shouldTrack) {
      continue;
    }

    const isDir = await isDirectory(expandedPath);

    // JSON-key tracking: validate the file is a single JSON file that actually
    // contains the requested key path BEFORE it enters the manifest, so a typo
    // or non-JSON file fails loudly at `tuck add` time rather than on apply.
    if (jsonKey) {
      if (isDir) {
        throw new JsonKeyError(`--key requires a single JSON file, but ${candidate.path} is a directory`);
      }
      const content = await readFile(expandedPath, 'utf8');
      // Throws JsonKeyError with a precise reason (bad JSON / missing key).
      extractSubtree(content, jsonKey);
    }

    const fileCount = isDir ? await getDirectoryFileCount(expandedPath) : 1;
    const category = candidate.category || options.category || detectCategory(expandedPath);
    const customName = candidate.name ?? options.name;
    const nameOverride = customName ? sanitizeFilename(customName) : undefined;
    const filename = nameOverride || sanitizeFilename(expandedPath);

    if (repoMeta) {
      prepared.push({
        source: trackingId,
        destination: getRepoScopedDestination(repoMeta.repoKey, repoMeta.repoRelative),
        category,
        filename,
        nameOverride,
        isDir,
        fileCount,
        sensitive: isSensitiveFile(filename),
        scope: 'repo',
        repoKey: repoMeta.repoKey,
        repoRelative: repoMeta.repoRelative,
        repoRoot: repoMeta.repoRoot,
        remoteUrl: repoMeta.remoteUrl,
        liveSource: expandedPath,
      });
      continue;
    }

    prepared.push({
      source: trackingId,
      destination: getDestinationPathFromSource(tuckDir, category, expandedPath, nameOverride),
      category,
      filename,
      nameOverride,
      isDir,
      fileCount,
      sensitive: isSensitiveFile(trackingId),
      ...(jsonKey ? { jsonKey } : {}),
    });
  }

  // JSON-key files scan only their extracted SUBTREE for secrets (not the whole
  // file): the whole point of the feature is to track e.g. `mcpServers` while
  // leaving OAuth tokens elsewhere in the file behind, so a token OUTSIDE the
  // tracked subtree must not block the add. Whole-file entries keep the existing
  // path-based secret policy untouched.
  const jsonKeyFiles = prepared.filter((f) => f.jsonKey);
  const wholeFileEntries = prepared.filter((f) => !f.jsonKey);
  const survivingJsonKey = await applyJsonKeySecretPolicy(jsonKeyFiles, tuckDir, options);
  const survivingWhole = await applySecretPolicy(wholeFileEntries, tuckDir, options);
  return [...survivingJsonKey, ...survivingWhole];
};
