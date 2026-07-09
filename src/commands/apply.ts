import { Command } from 'commander';
import { join, dirname, basename, resolve, isAbsolute } from 'path';
import { readFile, writeFile, rm, chmod, stat, realpath, lstat, readlink } from 'fs/promises';
import { ensureDir, pathExists as fsPathExists, copy } from 'fs-extra';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { banner, prompts, logger, colors as c } from '../ui/index.js';
import {
  expandPath,
  pathExists,
  collapsePath,
  validateSafeSourcePath,
  validateSafeManifestDestination,
  validatePathWithinRoot,
  validateSafeRepoSourcePath,
  getTuckDir,
} from '../lib/paths.js';
import { resolveWriteTarget, setKnownRepoRoots, allowedRoots, type RepoWriteTarget } from '../lib/writeContext.js';
import { setFilePermissions, copyFileOrDir } from '../lib/files.js';
import { resolveLiveTarget, resolveRepoRoot, bindRepo } from '../lib/repoScope.js';
import { cloneRepo } from '../lib/git.js';
import { isGhInstalled, ghCloneRepo, repoExists } from '../lib/github.js';
import { createPreApplySnapshot } from '../lib/timemachine.js';
import { smartMerge, isShellFile, generateMergePreview } from '../lib/merge.js';
import { CATEGORIES } from '../constants.js';
import { type TuckManifestOutput } from '../schemas/manifest.schema.js';
import { loadManifestFile } from '../lib/manifestFile.js';
import { clearManifestCache } from '../lib/manifest.js';
import { findPlaceholders, restoreContent, restoreFiles as restoreSecrets, getAllSecrets, getSecretCount } from '../lib/secrets/index.js';
import { createResolver } from '../lib/secretBackends/index.js';
import { loadConfig } from '../lib/config.js';
import { IS_WINDOWS } from '../lib/platform.js';
import { RepositoryNotFoundError, MaterializeError, JsonKeyError } from '../errors.js';
import { getProvider, type ProviderMode, type RemoteConfig as ProviderRemoteConfig } from '../lib/providers/index.js';
import { setJsonMode, isJsonMode, emitJsonOk, addJsonWarning } from '../lib/jsonOutput.js';
import { materializeForLive, keystorePassphrase, buildMaterializeCtx } from '../lib/materialize.js';
import { mergeSubtreeIntoLive } from '../lib/jsonKey.js';

// Track if Windows permission warning has been shown this session
let windowsPermissionWarningShown = false;

/**
 * Fix permissions for SSH/GPG files after apply
 * On Windows, Unix-style permissions don't apply, so we log a warning instead
 */
const fixSecurePermissions = async (path: string): Promise<void> => {
  const collapsedPath = collapsePath(path);

  // Only fix permissions for SSH and GPG files
  if (!collapsedPath.includes('.ssh/') && !collapsedPath.includes('.gnupg/')) {
    return;
  }

  // On Windows, chmod is limited and Unix-style permissions don't apply
  if (IS_WINDOWS) {
    if (!windowsPermissionWarningShown) {
      logger.warning(
        'Note: On Windows, file permissions cannot be restricted like on Unix systems. ' +
        'Ensure your SSH/GPG files are stored in a secure location.'
      );
      windowsPermissionWarningShown = true;
    }
    return;
  }

  try {
    const stats = await stat(path);

    if (stats.isDirectory()) {
      await chmod(path, 0o700);
    } else {
      await chmod(path, 0o600);
    }
  } catch {
    // Ignore permission errors
  }
};

/**
 * Reapply the permissions recorded in the manifest to a freshly-written file.
 * writeFile uses the umask default, so without this a 0755 script lands
 * non-executable and a 0600 file lands world-readable. No-op on Windows (handled
 * inside setFilePermissions) and when no permissions were recorded.
 */
const applyRecordedPermissions = async (
  writeTarget: string,
  permissions?: string
): Promise<void> => {
  if (!permissions) return;
  try {
    await setFilePermissions(writeTarget, permissions);
  } catch {
    // Never fail an apply over a chmod that the filesystem rejects.
  }
};

/**
 * Defense against symlink TOCTOU during apply.
 *
 * Every other destination check in the apply path is purely LEXICAL (string
 * validation of the intended path) and never resolves symlinks. A malicious repo
 * can plant a symlinked path segment on the live tree (e.g. a directory entry
 * that recreates `~/.config/app -> /etc`), after which a later write to a
 * lexically-in-home path would follow that link and escape $HOME. Before every
 * write we resolve the REAL path of the deepest existing ancestor of the target
 * (following any symlinks, including the target itself when it already exists as
 * a link) and assert the real destination still lands inside an allowed root —
 * refusing to write THROUGH a symlinked segment. Throwing here aborts the write
 * before any bytes or parent directories are created outside the sandbox/home.
 */
export const assertRealTargetWithinRoots = async (
  writeTarget: string,
  roots: string[]
): Promise<void> => {
  const resolved = resolve(writeTarget);

  // Existence via lstat, NOT access(): a DANGLING symlink (target missing) still
  // "exists" as a link and must be resolved — otherwise `writeFile` would create
  // its target at the escaped location. access() follows the link and reports
  // "missing", hiding the escape.
  const linkExists = async (p: string): Promise<boolean> => {
    try {
      await lstat(p);
      return true;
    } catch {
      return false;
    }
  };

  // Walk up to the deepest ancestor that exists (as a file, dir, or symlink).
  let existing = resolved;
  const tail: string[] = [];
  while (!(await linkExists(existing))) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }

  // This guard exists to catch symlink REDIRECTION: a repo/manifest that plants a
  // symlinked segment so a lexically-in-bounds write follows the link and escapes
  // the allowed roots. A write can only be redirected if some EXISTING component
  // of its path is a symlink — a not-yet-created component cannot redirect
  // anything. So scan the existing ancestors: if none is a symlink, no redirection
  // is possible and the earlier lexical validators (validateSafeDestinationPath /
  // repo-scope checks) are authoritative — allow the write. Detecting a symlink
  // via lstat().isSymbolicLink() is reliable across real filesystems and the
  // memfs-backed tests, unlike reconciling realpath() string forms (which diverge
  // by separator/drive under memfs on Windows and caused out-of-home repo and
  // sandbox writes to false-positive).
  let symlinkedSegment = false;
  let probe = existing;
  let reachedRoot = false;
  while (!reachedRoot) {
    try {
      if ((await lstat(probe)).isSymbolicLink()) {
        symlinkedSegment = true;
        break;
      }
    } catch {
      // Non-existent/unreadable component: it cannot be a redirecting symlink.
    }
    const parent = dirname(probe);
    if (parent === probe) reachedRoot = true; // reached the filesystem root
    else probe = parent;
  }
  if (!symlinkedSegment) {
    return;
  }

  // A symlinked segment is present — resolve `existing` to its real on-disk
  // location, following symlinks, and confirm the real destination still lands
  // inside an allowed root. realpath throws on a dangling symlink; fall back to
  // readlink + the real parent so a broken-but-escaping link is still detected.
  let realExisting: string;
  try {
    realExisting = await realpath(existing);
  } catch {
    const linkTarget = await readlink(existing).catch(() => null);
    const realParent = await realpath(dirname(existing)).catch(() => resolve(dirname(existing)));
    realExisting = linkTarget
      ? isAbsolute(linkTarget)
        ? resolve(linkTarget)
        : resolve(realParent, linkTarget)
      : join(realParent, basename(existing));
  }
  const realTarget = tail.length > 0 ? join(realExisting, ...tail) : realExisting;

  // Normalize both sides the SAME way before comparing: realpath()/lstat() and
  // node:path (sep/join) can disagree on separators, and lowercase on Windows
  // (NTFS is case-insensitive) with the leading drive letter dropped.
  const canonical = (p: string): string => {
    let unified = p.replace(/\\/g, '/');
    if (IS_WINDOWS) {
      unified = unified.toLowerCase().replace(/^[a-z]:/, '');
    }
    return unified;
  };

  const realRoots = await Promise.all(
    roots.map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return resolve(r);
      }
    })
  );

  const canonTarget = canonical(realTarget);
  const contained = realRoots.some((root) => {
    const canonRoot = canonical(root);
    return canonTarget === canonRoot || canonTarget.startsWith(canonRoot + '/');
  });
  if (!contained) {
    throw new Error(
      `Refusing to write through a symlinked path: ${collapsePath(writeTarget)} ` +
        `resolves to ${realTarget}, outside the allowed roots`
    );
  }
};

/**
 * Resolve-symlink guard + ensure the parent directory exists, in that order:
 * the containment check MUST run before ensureDir so we never materialize
 * directories under an escaped (symlinked) location.
 */
const prepareWriteTarget = async (writeTarget: string): Promise<void> => {
  await assertRealTargetWithinRoots(writeTarget, allowedRoots());
  await ensureDir(dirname(writeTarget));
};

/**
 * Apply a tracked DIRECTORY entry by copying the whole tree into place.
 *
 * The per-file apply loops read `repoPath` as text (for secret resolution /
 * smart-merge), which throws EISDIR on a directory. Directory entries (e.g.
 * `~/.config/nvim`, `~/.ssh`) are copied verbatim instead; secret/merge handling
 * is per-file and does not apply to a directory tree.
 */
const applyDirectoryEntry = async (file: ApplyFile, dryRun: boolean): Promise<void> => {
  const exists = await pathExists(file.destination);
  if (dryRun) {
    logger.file(exists ? 'modify' : 'add', `${collapsePath(file.destination)} (directory)`);
    return;
  }
  const writeTarget = resolveWriteTarget(file.destination, file.repoTarget);
  await prepareWriteTarget(writeTarget);
  await copyFileOrDir(file.repoPath, writeTarget, { overwrite: true });
  await applyRecordedPermissions(writeTarget, file.permissions);
  await fixSecurePermissions(writeTarget);
  logger.file(exists ? 'modify' : 'add', `${collapsePath(file.destination)} (directory)`);
};

/**
 * True when the buffer is valid UTF-8. Used to detect binary files so they are
 * copied verbatim rather than pushed through the text pipeline
 * (materialize/secret-resolution/merge), whose `bytes.toString('utf8')` would
 * replace invalid sequences with U+FFFD and silently corrupt the file.
 */
export const isValidUtf8 = (buf: Buffer): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
};

/**
 * Apply a tracked BINARY (non-UTF-8) file by copying its repo bytes verbatim.
 *
 * Binary files are trackable as single entries (e.g. a font, a *.db, a keyring),
 * and template/secret/merge processing is text-only. Copying the bytes preserves
 * them exactly; routing them through the string pipeline would corrupt them.
 * Only reached for non-template, non-encrypted files (those are always text once
 * materialized).
 */
const applyBinaryEntry = async (file: ApplyFile, dryRun: boolean): Promise<void> => {
  const exists = await pathExists(file.destination);
  if (dryRun) {
    logger.file(exists ? 'modify' : 'add', collapsePath(file.destination));
    return;
  }
  const writeTarget = resolveWriteTarget(file.destination, file.repoTarget);
  await prepareWriteTarget(writeTarget);
  await copyFileOrDir(file.repoPath, writeTarget, { overwrite: true });
  await applyRecordedPermissions(writeTarget, file.permissions);
  await fixSecurePermissions(writeTarget);
  logger.file(exists ? 'modify' : 'add', collapsePath(file.destination));
};

export interface ApplyOptions {
  merge?: boolean;
  replace?: boolean;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  /** Emit a single structured JSON envelope on stdout instead of human UI. */
  json?: boolean;
  /** Scope applied files to a single bundle. */
  bundle?: string;
  /** Bind an as-yet-unknown repo to this root before applying repo-scoped files. */
  repoRoot?: string;
}

export interface ApplyFile {
  source: string;
  /** Absolute LIVE write target on this machine (home path or repo checkout path). */
  destination: string;
  category: string;
  /** Path to the file's committed copy inside the cloned tuck repo (READ side). */
  repoPath: string;
  /**
   * Repo-write descriptor for resolveWriteTarget. Present only for repo-scoped
   * files; absent for home-scoped files (which route through the home logic).
   */
  repoTarget?: RepoWriteTarget;
  /** Recorded octal permissions (e.g. "755"), reapplied to the written file. */
  permissions?: string;
  /** Render the repo source as a template before writing to the live system. */
  template: boolean;
  /** Decrypt the repo source (TCKE1) before writing to the live system. */
  encrypted: boolean;
  /**
   * Dot-delimited JSON key path when the repo copy is only a subtree. On apply
   * it is deep-merged back into the live file, preserving all other keys.
   */
  jsonKey?: string;
}

interface ApplyResult {
  appliedCount: number;
  filesWithPlaceholders: Array<{
    /** Display path (collapsed live destination) for warnings. */
    path: string;
    placeholders: string[];
    /**
     * The ACTUAL file apply wrote (resolveWriteTarget output). Local-store secret
     * restoration must target this file — under --root it is the sandbox copy, not
     * the operator's real ~ path (`path`). Using `path` would read/rewrite the real
     * home file, escaping the sandbox.
     */
    writeTarget: string;
  }>;
  /** repo-scoped sources skipped because their repo is unbound on this machine. */
  skippedUnboundRepos: string[];
}

const execFileAsync = promisify(execFile);

export type ApplySourceKind = 'provider-prefixed' | 'git-url' | 'local' | 'repo-id' | 'username';

/** True for tar archives we know how to extract. */
export const isTarballPath = (p: string): boolean => /\.(tar\.gz|tgz|tar)$/i.test(p);

/**
 * Classify an `apply <source>` argument. An existing LOCAL path wins over the
 * URL/owner-repo/username interpretations (after the explicit provider: prefix),
 * so tuck can apply from a directory or tarball with no remote — and no GitHub.
 */
export const classifyApplySource = (source: string, localExists: boolean): ApplySourceKind => {
  if (/^(github|gitlab|custom):/u.test(source)) return 'provider-prefixed';
  if (localExists) return 'local';
  if (source.includes('://') || source.startsWith('git@')) return 'git-url';
  if (source.includes('/')) return 'repo-id';
  return 'username';
};

const buildProviderCloneUrl = (
  providerMode: Extract<ProviderMode, 'github' | 'gitlab'>,
  repoId: string,
  remoteConfig?: ProviderRemoteConfig
): string => {
  const slashIndex = repoId.indexOf('/');
  if (slashIndex <= 0 || slashIndex === repoId.length - 1) {
    throw new RepositoryNotFoundError(repoId);
  }

  const owner = repoId.slice(0, slashIndex);
  const repoName = repoId.slice(slashIndex + 1);
  const provider = getProvider(providerMode, remoteConfig?.mode === providerMode ? remoteConfig : undefined);
  return provider.buildRepoUrl(owner, repoName, 'https');
};

/**
 * How {@link cloneSource} should materialize a resolved source.
 *
 * - `custom`  → clone through the CUSTOM provider's cloneRepo (file:// / full
 *   git URLs / explicit `custom:` prefix). Carries the provider's clone
 *   timeout/maxBuffer and never touches any github code path.
 * - `git`     → clone a provider-BUILT URL (gitlab/github) through the capped
 *   git.ts cloneRepo.
 * - `github-repo-id` → a bare owner/repo resolved against github: gh-clone when
 *   the CLI is present, otherwise a github URL BUILT via provider.buildRepoUrl
 *   (never a hard-coded literal) cloned through git.ts.
 */
type CloneTransport = 'custom' | 'git' | 'github-repo-id';

interface ResolvedSource {
  repoId: string;
  isUrl: boolean;
  local?: 'dir' | 'tarball';
  /** Clone transport for non-local sources (ignored when `local` is set). */
  cloneVia?: CloneTransport;
}

/**
 * Resolve a source (username or repo URL) to a full repository identifier
 */
const resolveSource = async (source: string): Promise<ResolvedSource> => {
  const configuredRemote = (await loadConfig(getTuckDir()))?.remote ?? { mode: 'local' as const };
  const providerPrefixMatch = source.match(/^(github|gitlab|custom):(.*)$/u);

  if (providerPrefixMatch) {
    const providerMode = providerPrefixMatch[1] as Extract<ProviderMode, 'github' | 'gitlab' | 'custom'>;
    const repoId = providerPrefixMatch[2];

    // custom:<URL> → provider-neutral clone (custom provider). github/gitlab →
    // a provider-BUILT URL cloned through the capped git.ts path.
    if (providerMode === 'custom') {
      return { repoId, isUrl: true, cloneVia: 'custom' };
    }
    return {
      repoId: buildProviderCloneUrl(providerMode, repoId, configuredRemote),
      isUrl: true,
      cloneVia: 'git',
    };
  }

  // A LOCAL directory or tarball — fully provider-free, no remote/GitHub needed.
  const expandedSource = expandPath(source);
  if (await pathExists(expandedSource)) {
    return {
      repoId: expandedSource,
      isUrl: false,
      local: isTarballPath(expandedSource) ? 'tarball' : 'dir',
    };
  }

  // A file:// URL or full git URL (https/git@). These are provider-neutral and
  // route through the CUSTOM provider's capped clone — never github.
  if (source.includes('://') || source.startsWith('git@')) {
    return { repoId: source, isUrl: true, cloneVia: 'custom' };
  }

  // Check if it's a repo identifier (owner/repo or group/subgroup/repo).
  // Resolve against the CONFIGURED provider first, building the URL via that
  // provider's buildRepoUrl — never an unconditional github.com.
  if (source.includes('/')) {
    if (configuredRemote.mode === 'gitlab') {
      return {
        repoId: buildProviderCloneUrl('gitlab', source, configuredRemote),
        isUrl: true,
        cloneVia: 'git',
      };
    }
    if (configuredRemote.mode === 'github') {
      return {
        repoId: buildProviderCloneUrl('github', source, configuredRemote),
        isUrl: true,
        cloneVia: 'git',
      };
    }

    // No (or local) configured provider → fall back to github resolution, but
    // still build the URL via the provider, never a hard-coded literal.
    return { repoId: source, isUrl: false, cloneVia: 'github-repo-id' };
  }

  // Assume it's a username, try to find their dotfiles repo
  logger.info(`Looking for dotfiles repository for ${source}...`);

  const providerModes: Array<Extract<ProviderMode, 'github' | 'gitlab'>> =
    configuredRemote.mode === 'gitlab' ? ['gitlab', 'github'] : ['github', 'gitlab'];

  for (const mode of providerModes) {
    if (mode === 'github' && !(await isGhInstalled())) {
      continue;
    }

    try {
      const provider = getProvider(mode, configuredRemote.mode === mode ? configuredRemote : undefined);
      const dotfilesRepo = await provider.findDotfilesRepo(source);
      if (dotfilesRepo) {
        logger.success(`Found repository: ${dotfilesRepo}`);
        return mode === 'github'
          ? { repoId: dotfilesRepo, isUrl: false, cloneVia: 'github-repo-id' }
          : {
              repoId: buildProviderCloneUrl(mode, dotfilesRepo, configuredRemote),
              isUrl: true,
              cloneVia: 'git',
            };
      }
    } catch {
      continue;
    }
  }

  // Try common repo names
  const commonNames = ['dotfiles', 'tuck', '.dotfiles'];
  for (const mode of providerModes) {
    for (const name of commonNames) {
      const repoId = `${source}/${name}`;

      try {
        if (
          mode === 'github'
            ? await repoExists(repoId)
            : await getProvider(
                mode,
                configuredRemote.mode === mode ? configuredRemote : undefined
              ).repoExists(repoId)
        ) {
          logger.success(`Found repository: ${repoId}`);
          return mode === 'github'
            ? { repoId, isUrl: false, cloneVia: 'github-repo-id' }
            : {
                repoId: buildProviderCloneUrl(mode, repoId, configuredRemote),
                isUrl: true,
                cloneVia: 'git',
              };
        }
      } catch {
        continue;
      }
    }
  }

  throw new RepositoryNotFoundError(source);
};

/**
 * Clone the source repository to a temporary directory.
 *
 * The clone is routed by {@link ResolvedSource.cloneVia} so a provider-neutral
 * source (file:// / full git URL / `custom:`) goes through the CUSTOM provider's
 * capped clone instead of any github code path, and a bare owner/repo never
 * builds a hard-coded `https://github.com/...` literal.
 */
const cloneSource = async (resolved: ResolvedSource): Promise<string> => {
  const { repoId, isUrl, local, cloneVia } = resolved;
  const tempDir = join(tmpdir(), `tuck-apply-${Date.now()}`);
  await ensureDir(tempDir);

  if (local === 'dir') {
    // Materialize the local source into a temp working copy (no remote).
    await copy(repoId, tempDir, { overwrite: true });
    return tempDir;
  }

  if (local === 'tarball') {
    // Extract the archive into the temp dir (tar ships on macOS/Linux/Win10+).
    await execFileAsync('tar', ['-xzf', repoId, '-C', tempDir]);
    return tempDir;
  }

  if (cloneVia === 'custom') {
    // file:// / full git URL / explicit custom: — clone through the custom
    // provider (its timeout/maxBuffer), provider-neutral, never github.
    await getProvider('custom').cloneRepo(repoId, tempDir);
    return tempDir;
  }

  if (cloneVia === 'github-repo-id' || (!cloneVia && !isUrl)) {
    // Bare owner/repo resolved against github: gh-clone when the CLI is present,
    // otherwise a github URL BUILT via the provider (never a hard-coded literal)
    // cloned through the capped git.ts path.
    if (await isGhInstalled()) {
      await ghCloneRepo(repoId, tempDir);
    } else {
      const slashIndex = repoId.indexOf('/');
      const owner = repoId.slice(0, slashIndex);
      const repoName = repoId.slice(slashIndex + 1);
      const url = getProvider('github').buildRepoUrl(owner, repoName, 'https');
      await cloneRepo(url, tempDir);
    }
    return tempDir;
  }

  // cloneVia === 'git' (or a legacy isUrl source): a provider-built URL cloned
  // through the capped git.ts path.
  await cloneRepo(repoId, tempDir);
  return tempDir;
};

/**
 * Read the manifest from a cloned repository
 */
const readClonedManifest = async (repoDir: string): Promise<TuckManifestOutput | null> => {
  const manifestPath = join(repoDir, '.tuckmanifest.json');

  if (!(await fsPathExists(manifestPath))) {
    return null;
  }

  try {
    // A cloned/remote manifest is untrusted: load it through the shared,
    // schema-validating loader so a hostile manifest is rejected before use.
    return await loadManifestFile(manifestPath);
  } catch {
    return null;
  }
};

/**
 * On a fresh machine the repo-scoped entries in the cloned manifest are not yet
 * bound to any local checkout. `--repo-root <dir>` binds the repoKey(s) present
 * in the manifest to that directory so the apply can place the files there.
 *
 * The single-repo case (the common one) binds the lone unbound repoKey to the
 * given root. When several distinct unbound repoKeys are present we bind them
 * all to the same root only if there is exactly one — otherwise we cannot safely
 * guess which key the root belongs to and leave the rest unbound (skipped).
 */
const bindReposFromOption = async (
  manifest: TuckManifestOutput,
  repoRoot: string
): Promise<void> => {
  const unboundKeys = new Set<string>();
  for (const file of Object.values(manifest.files)) {
    if (file.scope === 'repo' && file.repoKey) {
      if ((await resolveRepoRoot(file.repoKey)) === null) {
        unboundKeys.add(file.repoKey);
      }
    }
  }
  // Only bind when the target is unambiguous (a single unbound repo).
  if (unboundKeys.size === 1) {
    const [key] = [...unboundKeys];
    await bindRepo(key, repoRoot);
  }
};

/**
 * Register every bound repo root with the write context so out-of-home repo
 * writes pass the copy/symlink guard (`allowedRoots()`).
 */
const registerKnownRepoRoots = async (manifest: TuckManifestOutput): Promise<void> => {
  const roots: string[] = [];
  for (const file of Object.values(manifest.files)) {
    if (file.scope === 'repo' && file.repoKey) {
      const root = await resolveRepoRoot(file.repoKey);
      if (root) roots.push(root);
    }
  }
  if (roots.length > 0) setKnownRepoRoots(roots);
};

/**
 * Prepare the list of files to apply. Repo-scoped files are resolved to their
 * LIVE checkout location on this machine; an unbound repo (no local checkout) is
 * skipped — never guessed, never written to a wrong path — and reported back so
 * callers can surface it.
 *
 * Unsafe manifest entries (traversal source/destination, out-of-repo path) are
 * collected into `unsafe` and RETURNED rather than logged here: this function
 * runs inside the MCP `apply_plan` tool where stdout is the JSON-RPC transport,
 * so a stray `logger.warning` would corrupt the protocol stream. Each caller
 * decides how to surface them (human logger vs addJsonWarning vs silent).
 */
export const prepareFilesToApply = async (
  repoDir: string,
  manifest: TuckManifestOutput,
  bundle?: string
): Promise<{ files: ApplyFile[]; skipped: string[]; unsafe: string[] }> => {
  const files: ApplyFile[] = [];
  const skipped: string[] = [];
  const unsafe: string[] = [];

  for (const [_id, file] of Object.entries(manifest.files)) {
    // Scope to a single bundle when requested. Treat missing/legacy bundle
    // values as "default" so legacy manifests stay applicable.
    if (bundle && (file.bundle ?? 'default') !== bundle) {
      continue;
    }

    const isRepoScoped = file.scope === 'repo';

    try {
      if (isRepoScoped) {
        // Repo-scoped: source is a "<repoKey>:<repoRelative>" pseudo-path that is
        // NOT home-confined. Validate the repoRelative is a safe in-repo path.
        if (!file.repoKey || !file.repoRelative) {
          throw new Error('repo-scoped entry missing repoKey/repoRelative');
        }
        const root = await resolveRepoRoot(file.repoKey);
        if (root) {
          // Bound: confine the joined target within the actual repo root.
          validateSafeRepoSourcePath(root, file.repoRelative);
        } else {
          // Unbound: only the structural shape of repoRelative is verifiable
          // (no absolute, no "..") — there is no root to confine against yet.
          const norm = file.repoRelative.replace(/\\/g, '/');
          if (
            norm.startsWith('/') ||
            /^[A-Za-z]:[\\/]/.test(file.repoRelative) ||
            norm.split('/').includes('..')
          ) {
            throw new Error(`Unsafe repo-relative path detected: ${file.repoRelative}`);
          }
        }
      } else {
        validateSafeSourcePath(file.source);
      }
      validateSafeManifestDestination(file.destination);
    } catch {
      unsafe.push(`Skipping unsafe manifest entry: ${file.source}`);
      continue;
    }

    const repoFilePath = join(repoDir, file.destination);

    try {
      validatePathWithinRoot(repoFilePath, repoDir, 'repository file');
    } catch {
      unsafe.push(`Skipping unsafe repository path from manifest: ${file.destination}`);
      continue;
    }

    if (!(await fsPathExists(repoFilePath))) {
      continue;
    }

    // Resolve the LIVE write location. Home files → expandPath(source). Repo files
    // → the bound checkout path, or null when the repo is unbound on this machine.
    const liveTarget = await resolveLiveTarget(file);

    if (liveTarget === null) {
      // Unbound repo — skip and report it. Never guess a destination.
      skipped.push(file.source);
      continue;
    }

    let repoTarget: RepoWriteTarget | undefined;
    if (isRepoScoped) {
      const root = await resolveRepoRoot(file.repoKey!);
      // resolveLiveTarget already returned non-null → the repo is bound.
      repoTarget = {
        repoKey: file.repoKey!,
        repoRelative: file.repoRelative!,
        repoRoot: root!,
      };
    }

    files.push({
      source: file.source,
      destination: liveTarget,
      category: file.category,
      repoPath: repoFilePath,
      repoTarget,
      permissions: file.permissions,
      template: file.template,
      encrypted: file.encrypted,
      jsonKey: file.jsonKey,
    });
  }

  return { files, skipped, unsafe };
};

/**
 * Resolve placeholders in file content using the configured backend
 * @returns Object with resolved content and any unresolved placeholder names
 */
const resolveFileSecrets = async (
  content: string,
  tuckDir: string
): Promise<{ content: string; unresolved: string[] }> => {
  const placeholders = findPlaceholders(content);

  if (placeholders.length === 0) {
    return { content, unresolved: [] };
  }

  try {
    const config = await loadConfig(tuckDir);
    const resolver = createResolver(tuckDir, config.security);

    // Resolve all placeholders
    // Use failOnAuthRequired to prevent interactive prompts during apply
    const secrets = await resolver.resolveToMap(placeholders, { failOnAuthRequired: true });

    // Replace placeholders with resolved values
    const result = restoreContent(content, secrets);

    return {
      content: result.restoredContent,
      unresolved: result.unresolved,
    };
  } catch (error) {
    // If resolver fails, log the error and return original content with all placeholders as unresolved
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.debug?.(`Secret resolution failed: ${errorMsg}`);
    logger.warning?.(
      `Failed to resolve secrets for file content. ${placeholders.length} placeholder(s) will remain unresolved. ` +
        `Reason: ${errorMsg}`
    );
    return { content, unresolved: placeholders };
  }
};

/**
 * Apply a JSON-key entry: deep-merge the repo's stored subtree back into the
 * live file, leaving every other key untouched. Used by BOTH the merge and
 * replace strategies — a JSON subtree is never allowed to clobber the whole
 * file, so "replace" still means "replace only the tracked key". Secret
 * placeholders inside the subtree are resolved on the merged content, exactly
 * like whole-file entries.
 */
const applyJsonKeyEntry = async (
  file: ApplyFile,
  rawBytes: Buffer,
  tuckDir: string,
  dryRun: boolean,
  result: ApplyResult
): Promise<void> => {
  const repoSubtree = rawBytes.toString('utf8');
  const exists = await pathExists(file.destination);
  const liveContent = exists ? await readFile(file.destination, 'utf8') : null;
  let merged = mergeSubtreeIntoLive(liveContent, repoSubtree, file.jsonKey as string);

  const secretsResult = await resolveFileSecrets(merged, tuckDir);
  merged = secretsResult.content;
  if (secretsResult.unresolved.length > 0) {
    result.filesWithPlaceholders.push({
      path: collapsePath(file.destination),
      placeholders: secretsResult.unresolved,
      writeTarget: resolveWriteTarget(file.destination, file.repoTarget),
    });
  }

  if (dryRun) {
    logger.file(exists ? 'modify' : 'add', `${collapsePath(file.destination)} (--key ${file.jsonKey})`);
    return;
  }

  const writeTarget = resolveWriteTarget(file.destination, file.repoTarget);
  await prepareWriteTarget(writeTarget);
  await writeFile(writeTarget, merged, 'utf-8');
  await applyRecordedPermissions(writeTarget, file.permissions);
  logger.file(exists ? 'modify' : 'add', `${collapsePath(file.destination)} (--key ${file.jsonKey})`);
};

/**
 * Apply files with merge strategy
 */
const applyWithMerge = async (files: ApplyFile[], dryRun: boolean): Promise<ApplyResult> => {
  const result: ApplyResult = {
    appliedCount: 0,
    filesWithPlaceholders: [],
    skippedUnboundRepos: [],
  };

  // Get tuck directory for secret resolution
  const tuckDir = getTuckDir();
  // Template context (built-in vars + config.templates.variables), built once per apply.
  const ctx = await buildMaterializeCtx(tuckDir);

  for (const file of files) {
    // Directory entries are copied as a tree; readFile / secret-resolution /
    // smart-merge are text-file operations that throw EISDIR on a directory.
    if ((await stat(file.repoPath)).isDirectory()) {
      await applyDirectoryEntry(file, dryRun);
      result.appliedCount++;
      continue;
    }
    const rawBytes = await readFile(file.repoPath);

    // JSON-key entries write their stored subtree into the live file at the
    // tracked path, preserving every other key (never routed through
    // materialize/smart-merge/binary). A corrupt/JSONC live file must skip
    // THIS entry loudly and keep the rest of the run going, like
    // MaterializeError below.
    if (file.jsonKey) {
      try {
        await applyJsonKeyEntry(file, rawBytes, tuckDir, dryRun, result);
        result.appliedCount++;
      } catch (err) {
        if (err instanceof JsonKeyError) {
          const msg = `Skipped ${collapsePath(file.destination)}: ${err.message}`;
          logger.warning(msg);
          if (isJsonMode()) addJsonWarning(msg);
        } else {
          throw err;
        }
      }
      continue;
    }

    // Binary (non-UTF-8) files that are neither templated nor encrypted must be
    // copied byte-for-byte — the text pipeline below would UTF-8 round-trip them
    // and replace invalid sequences with U+FFFD, silently corrupting the file.
    if (!file.template && !file.encrypted && !isValidUtf8(rawBytes)) {
      await applyBinaryEntry(file, dryRun);
      result.appliedCount++;
      continue;
    }

    let fileContent: string;
    try {
      fileContent = await materializeForLive(rawBytes, file, ctx, { getPassphrase: keystorePassphrase });
    } catch (err) {
      // A failed / absent-passphrase decryption must NEVER write ciphertext or
      // partial output to the live system: skip this file loudly, keep the rest.
      if (err instanceof MaterializeError) {
        // Skip the file loudly and write NOTHING. This is NOT an unresolved secret
        // placeholder — pushing it into filesWithPlaceholders would misreport it
        // (as "unresolved placeholder, run tuck secrets set") AND trigger a
        // spurious local-secret restore against a file we never wrote.
        logger.warning(err.message);
        if (isJsonMode()) addJsonWarning(err.message);
        continue;
      }
      throw err;
    }

    // Resolve placeholders using configured backend (1Password, Bitwarden, pass, or local)
    const secretsResult = await resolveFileSecrets(fileContent, tuckDir);
    fileContent = secretsResult.content;

    // Track only unresolved placeholders. Record the resolved write target so a
    // later local-store secret restore rewrites the file apply ACTUALLY wrote
    // (the sandbox copy under --root), never the operator's real ~ path.
    if (secretsResult.unresolved.length > 0) {
      result.filesWithPlaceholders.push({
        path: collapsePath(file.destination),
        placeholders: secretsResult.unresolved,
        writeTarget: resolveWriteTarget(file.destination, file.repoTarget),
      });
    }

    if (isShellFile(file.source) && (await pathExists(file.destination))) {
      // Use smart merge for shell files
      const mergeResult = await smartMerge(file.destination, fileContent);

      if (dryRun) {
        logger.file(
          'merge',
          `${collapsePath(file.destination)} (${mergeResult.preservedBlocks} blocks preserved)`
        );
      } else {
        // Confine the write under --root (no-op when not sandboxed). Repo files
        // route through their repo descriptor so the target is the local checkout.
        const writeTarget = resolveWriteTarget(file.destination, file.repoTarget);
        await prepareWriteTarget(writeTarget);
        await writeFile(writeTarget, mergeResult.content, 'utf-8');
        await applyRecordedPermissions(writeTarget, file.permissions);
        logger.file('merge', collapsePath(file.destination));
      }
    } else {
      // Copy non-shell files directly
      if (dryRun) {
        if (await pathExists(file.destination)) {
          logger.file('modify', collapsePath(file.destination));
        } else {
          logger.file('add', collapsePath(file.destination));
        }
      } else {
        const fileExists = await pathExists(file.destination);
        const writeTarget = resolveWriteTarget(file.destination, file.repoTarget);
        // Write file content directly instead of copying (to preserve resolved secrets)
        await prepareWriteTarget(writeTarget);
        await writeFile(writeTarget, fileContent, 'utf-8');
        // Reapply recorded permissions first (so a 0755 script lands executable),
        // then the SSH/GPG fixup enforces its stricter floor for those dirs.
        await applyRecordedPermissions(writeTarget, file.permissions);
        await fixSecurePermissions(writeTarget);
        logger.file(fileExists ? 'modify' : 'add', collapsePath(file.destination));
      }
    }

    result.appliedCount++;
  }

  return result;
};

/**
 * Apply files with replace strategy
 */
const applyWithReplace = async (files: ApplyFile[], dryRun: boolean): Promise<ApplyResult> => {
  const result: ApplyResult = {
    appliedCount: 0,
    filesWithPlaceholders: [],
    skippedUnboundRepos: [],
  };

  // Get tuck directory for secret resolution
  const tuckDir = getTuckDir();
  // Template context (built-in vars + config.templates.variables), built once per apply.
  const ctx = await buildMaterializeCtx(tuckDir);

  for (const file of files) {
    // Directory entries are copied as a tree; readFile / secret-resolution /
    // smart-merge are text-file operations that throw EISDIR on a directory.
    if ((await stat(file.repoPath)).isDirectory()) {
      await applyDirectoryEntry(file, dryRun);
      result.appliedCount++;
      continue;
    }
    const rawBytes = await readFile(file.repoPath);

    // JSON-key entries write their stored subtree into the live file at the
    // tracked path, preserving every other key (never routed through
    // materialize/smart-merge/binary). A corrupt/JSONC live file must skip
    // THIS entry loudly and keep the rest of the run going, like
    // MaterializeError below.
    if (file.jsonKey) {
      try {
        await applyJsonKeyEntry(file, rawBytes, tuckDir, dryRun, result);
        result.appliedCount++;
      } catch (err) {
        if (err instanceof JsonKeyError) {
          const msg = `Skipped ${collapsePath(file.destination)}: ${err.message}`;
          logger.warning(msg);
          if (isJsonMode()) addJsonWarning(msg);
        } else {
          throw err;
        }
      }
      continue;
    }

    // Binary (non-UTF-8) files that are neither templated nor encrypted must be
    // copied byte-for-byte — the text pipeline below would UTF-8 round-trip them
    // and replace invalid sequences with U+FFFD, silently corrupting the file.
    if (!file.template && !file.encrypted && !isValidUtf8(rawBytes)) {
      await applyBinaryEntry(file, dryRun);
      result.appliedCount++;
      continue;
    }

    let fileContent: string;
    try {
      fileContent = await materializeForLive(rawBytes, file, ctx, { getPassphrase: keystorePassphrase });
    } catch (err) {
      // A failed / absent-passphrase decryption must NEVER write ciphertext or
      // partial output to the live system: skip this file loudly, keep the rest.
      if (err instanceof MaterializeError) {
        // Skip the file loudly and write NOTHING. This is NOT an unresolved secret
        // placeholder — pushing it into filesWithPlaceholders would misreport it
        // (as "unresolved placeholder, run tuck secrets set") AND trigger a
        // spurious local-secret restore against a file we never wrote.
        logger.warning(err.message);
        if (isJsonMode()) addJsonWarning(err.message);
        continue;
      }
      throw err;
    }

    // Resolve placeholders using configured backend (1Password, Bitwarden, pass, or local)
    const secretsResult = await resolveFileSecrets(fileContent, tuckDir);
    fileContent = secretsResult.content;

    // Track only unresolved placeholders. Record the resolved write target so a
    // later local-store secret restore rewrites the file apply ACTUALLY wrote
    // (the sandbox copy under --root), never the operator's real ~ path.
    if (secretsResult.unresolved.length > 0) {
      result.filesWithPlaceholders.push({
        path: collapsePath(file.destination),
        placeholders: secretsResult.unresolved,
        writeTarget: resolveWriteTarget(file.destination, file.repoTarget),
      });
    }

    if (dryRun) {
      if (await pathExists(file.destination)) {
        logger.file('modify', `${collapsePath(file.destination)} (replace)`);
      } else {
        logger.file('add', collapsePath(file.destination));
      }
    } else {
      const fileExists = await pathExists(file.destination);
      const writeTarget = resolveWriteTarget(file.destination, file.repoTarget);
      // Write file content directly instead of copying (to preserve resolved secrets)
      await prepareWriteTarget(writeTarget);
      await writeFile(writeTarget, fileContent, 'utf-8');
      // Reapply recorded permissions first (so a 0755 script lands executable),
      // then the SSH/GPG fixup enforces its stricter floor for those dirs.
      await applyRecordedPermissions(writeTarget, file.permissions);
      await fixSecurePermissions(writeTarget);
      logger.file(fileExists ? 'modify' : 'add', collapsePath(file.destination));
    }

    result.appliedCount++;
  }

  return result;
};

/**
 * Display warnings for files with unresolved placeholders
 */
const displayPlaceholderWarnings = (
  filesWithPlaceholders: ApplyResult['filesWithPlaceholders']
): void => {
  if (filesWithPlaceholders.length === 0) return;

  console.log();
  console.log(c.yellow('⚠ Warning: Some files contain unresolved placeholders:'));
  console.log();

  for (const { path, placeholders } of filesWithPlaceholders) {
    console.log(c.dim(`  ${path}:`));

    const maxToShow = 5;
    if (placeholders.length <= maxToShow) {
      // For small numbers, show all placeholders
      for (const placeholder of placeholders) {
        console.log(c.yellow(`    {{${placeholder}}}`));
      }
    } else {
      // For larger numbers, show a sampling: first 3 and last 2
      const firstCount = 3;
      const lastCount = 2;
      const firstPlaceholders = placeholders.slice(0, firstCount);
      const lastPlaceholders = placeholders.slice(-lastCount);

      for (const placeholder of firstPlaceholders) {
        console.log(c.yellow(`    {{${placeholder}}}`));
      }

      // Indicate that some placeholders are omitted in the middle
      console.log(c.dim('    ...'));

      for (const placeholder of lastPlaceholders) {
        console.log(c.yellow(`    {{${placeholder}}}`));
      }

      const shownCount = firstPlaceholders.length + lastPlaceholders.length;
      const hiddenCount = placeholders.length - shownCount;
      if (hiddenCount > 0) {
        console.log(c.dim(`    ... and ${hiddenCount} more not shown`));
      }
    }
  }

  console.log();
  console.log(c.dim('  These placeholders need to be replaced with actual values.'));
  console.log(c.dim('  Use `tuck secrets set <NAME> <value>` to configure secrets,'));
  console.log(c.dim('  then re-apply to populate them.'));
};

/**
 * Attempt to restore secrets from local store for files with placeholders
 * Returns info about what was restored
 */
const tryRestoreSecretsFromLocalStore = async (
  filesWithPlaceholders: ApplyResult['filesWithPlaceholders'],
  interactive: boolean
): Promise<{ restored: number; unresolved: string[] }> => {
  if (filesWithPlaceholders.length === 0) {
    return { restored: 0, unresolved: [] };
  }

  const allPlaceholders = filesWithPlaceholders.flatMap(f => f.placeholders);

  // Check if local tuck is initialized and has secrets
  let tuckDir: string;
  try {
    tuckDir = getTuckDir();
  } catch {
    // Tuck not initialized locally - can't restore secrets
    return { restored: 0, unresolved: allPlaceholders };
  }

  try {
    // Check if we have any secrets stored locally
    const secretCount = await getSecretCount(tuckDir);
    if (secretCount === 0) {
      return { restored: 0, unresolved: allPlaceholders };
    }

    // Get all stored secrets
    const secrets = await getAllSecrets(tuckDir);
    const secretNames = new Set(Object.keys(secrets));

    // Check which placeholders can be resolved
    const uniquePlaceholders = new Set(allPlaceholders);
    const resolvable = [...uniquePlaceholders].filter(p => secretNames.has(p));

    if (resolvable.length === 0) {
      return { restored: 0, unresolved: [...uniquePlaceholders] };
    }

    // In interactive mode, ask if user wants to restore
    if (interactive) {
      console.log();
      prompts.log.info(`Found ${resolvable.length} placeholder${resolvable.length !== 1 ? 's' : ''} that can be restored from local secrets store.`);

      const shouldRestore = await prompts.confirm(
        'Would you like to restore secrets from your local store?',
        true
      );

      if (!shouldRestore) {
        return { restored: 0, unresolved: [...uniquePlaceholders] };
      }
    }

    // Restore secrets in the files apply ACTUALLY wrote. Use the recorded write
    // target (already absolute and sandbox-confined under --root), never
    // expandPath(f.path) — that would resolve the operator's REAL ~ file and
    // rewrite it with plaintext secrets, escaping the sandbox.
    const pathsToRestore = filesWithPlaceholders.map(f => f.writeTarget);
    const result = await restoreSecrets(pathsToRestore, tuckDir);

    if (interactive && result.totalRestored > 0) {
      prompts.log.success(`Restored ${result.totalRestored} secret${result.totalRestored !== 1 ? 's' : ''} from local store`);
    }

    return {
      restored: result.totalRestored,
      unresolved: result.allUnresolved,
    };
  } catch (error) {
    // Secret restoration failed - log warning but don't fail the apply
    if (interactive) {
      prompts.log.warning('Failed to restore secrets from local store');
    } else {
      logger.warning('Failed to restore secrets from local store');
    }
    return { restored: 0, unresolved: allPlaceholders };
  }
};

/**
 * Run interactive apply flow
 */
const runInteractiveApply = async (source: string, options: ApplyOptions): Promise<void> => {
  banner();
  prompts.intro('tuck apply');

  // Resolve the source
  let resolved: ResolvedSource;
  const repoId = source; // Snapshot label: the original source the user typed.

  try {
    resolved = await resolveSource(source);
  } catch (error) {
    prompts.log.error(error instanceof Error ? error.message : String(error));
    return;
  }

  const { local } = resolved;

  // Clone the repository
  let repoDir: string;
  try {
    const spinner = prompts.spinner();
    spinner.start(local ? 'Reading local source...' : 'Cloning repository...');
    repoDir = await cloneSource(resolved);
    spinner.stop(local ? 'Source ready' : 'Repository cloned');
  } catch (error) {
    prompts.log.error(`Failed to clone: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // cloneSource just rewrote a repo out-of-band. Drop any in-memory manifest
  // cache so the rest of this run reads fresh state, never a stale manifest.
  clearManifestCache();

  try {
    // Read the manifest
    const manifest = await readClonedManifest(repoDir);

    if (!manifest) {
      prompts.log.error('No tuck manifest found in repository');
      prompts.note(
        'This repository may not be managed by tuck.\nLook for a .tuckmanifest.json file.',
        'Tip'
      );
      return;
    }

    // --repo-root: bind the (single) unbound repo present before resolving files.
    if (options.repoRoot) {
      await bindReposFromOption(manifest, options.repoRoot);
    }
    await registerKnownRepoRoots(manifest);

    // Prepare files to apply
    const { files, skipped, unsafe } = await prepareFilesToApply(repoDir, manifest, options.bundle);

    // Surface unsafe/skipped manifest entries here (prepareFilesToApply no longer
    // logs them itself, so it stays silent when reused by the MCP apply_plan tool).
    for (const msg of unsafe) {
      prompts.log.warning(msg);
    }

    if (skipped.length > 0) {
      prompts.log.warning(
        `Skipping ${skipped.length} repo-scoped file(s) for repos not linked on this machine:\n  ${skipped.join('\n  ')}`
      );
    }

    if (files.length === 0) {
      const scope = options.bundle ? ` in bundle "${options.bundle}"` : '';
      prompts.log.warning(`No files to apply${scope}`);
      return;
    }

    // Show what will be applied
    prompts.log.info(`Found ${files.length} file(s) to apply:`);
    console.log();

    // Group by category
    const byCategory: Record<string, ApplyFile[]> = {};
    for (const file of files) {
      if (!byCategory[file.category]) {
        byCategory[file.category] = [];
      }
      byCategory[file.category].push(file);
    }

    for (const [category, categoryFiles] of Object.entries(byCategory)) {
      const categoryConfig = CATEGORIES[category] || { icon: '📄' };
      console.log(c.bold(`  ${categoryConfig.icon} ${category}`));
      for (const file of categoryFiles) {
        const exists = await pathExists(file.destination);
        const status = exists ? c.yellow('(will update)') : c.green('(new)');
        console.log(c.dim(`    ${collapsePath(file.destination)} ${status}`));
      }
    }
    console.log();

    // Ask for merge strategy
    let strategy: 'merge' | 'replace';

    if (options.merge) {
      strategy = 'merge';
    } else if (options.replace) {
      strategy = 'replace';
    } else {
      strategy = await prompts.select('How should conflicts be handled?', [
        {
          value: 'merge',
          label: 'Merge (recommended)',
          hint: 'Preserve local customizations marked with # local or # tuck:preserve',
        },
        {
          value: 'replace',
          label: 'Replace',
          hint: 'Overwrite all files completely',
        },
      ]);
    }

    // Show merge preview for shell files if using merge strategy
    if (strategy === 'merge') {
      const shellFiles = files.filter((f) => isShellFile(f.source));
      if (shellFiles.length > 0) {
        console.log();
        for (const file of shellFiles.slice(0, 3)) {
          if (await pathExists(file.destination)) {
            const fileContent = await readFile(file.repoPath, 'utf-8');
            const preview = await generateMergePreview(file.destination, fileContent);
            prompts.note(preview, collapsePath(file.destination));
          }
        }
        if (shellFiles.length > 3) {
          prompts.log.info(`... and ${shellFiles.length - 3} more shell files`);
        }
      }
    }

    // Confirm
    if (!options.yes && !options.force) {
      console.log();
      const confirmed = await prompts.confirm(
        `Apply ${files.length} files using ${strategy} strategy?`,
        true
      );

      if (!confirmed) {
        prompts.cancel('Apply cancelled');
        return;
      }
    }

    // Create Time Machine backup before applying. Snapshot EVERY destination,
    // not just the ones that already exist: createSnapshot records missing paths
    // as existed:false, and restoreSnapshot (undo) deletes those on rollback — so
    // a `tuck undo` after this apply also removes files this apply newly created,
    // returning the system to its true pre-apply state.
    const snapshotPaths = files.map((f) => f.destination);

    if (snapshotPaths.length > 0 && !options.dryRun) {
      const spinner = prompts.spinner();
      spinner.start('Creating backup snapshot...');
      const snapshot = await createPreApplySnapshot(snapshotPaths, repoId);
      spinner.stop(`Backup created: ${snapshot.id}`);
      console.log();
    }

    // Apply files
    if (options.dryRun) {
      prompts.log.info('Dry run - no changes will be made:');
    } else {
      prompts.log.info('Applying files...');
    }
    console.log();

    let applyResult: ApplyResult;
    if (strategy === 'merge') {
      applyResult = await applyWithMerge(files, options.dryRun || false);
    } else {
      applyResult = await applyWithReplace(files, options.dryRun || false);
    }

    console.log();

    if (options.dryRun) {
      prompts.log.info(`Would apply ${applyResult.appliedCount} files`);
    } else {
      prompts.log.success(`Applied ${applyResult.appliedCount} files`);
    }

    // Show placeholder warnings
    displayPlaceholderWarnings(applyResult.filesWithPlaceholders);

    // Try to restore secrets from local store (only in non-dry-run mode)
    if (!options.dryRun && applyResult.filesWithPlaceholders.length > 0) {
      await tryRestoreSecretsFromLocalStore(applyResult.filesWithPlaceholders, true);
    }

    if (!options.dryRun) {
      console.log();
      prompts.note(
        'To undo this apply, run:\n  tuck undo --latest\n\nTo see all backups:\n  tuck undo --list',
        'Undo'
      );
    }

    prompts.outro('Done!');
  } finally {
    // Clean up temp directory
    try {
      await rm(repoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
};

/**
 * Run non-interactive apply
 */
export const runApply = async (source: string, options: ApplyOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck apply');

  // Resolve the source
  const resolved = await resolveSource(source);
  const { local } = resolved;

  // Clone (or materialize a local source).
  logger.info(local ? 'Reading local source...' : 'Cloning repository...');
  const repoDir = await cloneSource(resolved);

  // cloneSource just rewrote a repo out-of-band. Drop any in-memory manifest
  // cache so the rest of this run reads fresh state, never a stale manifest.
  clearManifestCache();

  try {
    // Read the manifest
    const manifest = await readClonedManifest(repoDir);

    if (!manifest) {
      throw new Error('No tuck manifest found in repository');
    }

    // --repo-root: bind the (single) unbound repo present in the manifest so its
    // files can be placed in the freshly-linked checkout on this machine.
    if (options.repoRoot) {
      await bindReposFromOption(manifest, options.repoRoot);
    }
    // Register bound repo roots so out-of-home repo writes pass the copy guard.
    await registerKnownRepoRoots(manifest);

    // Prepare files to apply
    const { files, skipped, unsafe } = await prepareFilesToApply(repoDir, manifest, options.bundle);

    // Surface unsafe manifest entries: into the JSON envelope in --json mode, or
    // as a human warning otherwise (logger is JSON-gated, so it never corrupts
    // the envelope). prepareFilesToApply intentionally stays silent itself.
    for (const msg of unsafe) {
      if (isJsonMode()) addJsonWarning(msg);
      else logger.warning(msg);
    }

    if (files.length === 0) {
      if (isJsonMode()) {
        emitJsonOk({ applied: 0, source, skipped });
        return;
      }
      const scope = options.bundle ? ` in bundle "${options.bundle}"` : '';
      logger.warning(`No files to apply${scope}`);
      if (skipped.length > 0) {
        logger.warning(
          `Skipped ${skipped.length} repo-scoped file(s) for unlinked repos: ${skipped.join(', ')}`
        );
      }
      return;
    }

    // Determine strategy
    const strategy = options.replace ? 'replace' : 'merge';

    // Create backup if not dry run. Snapshot EVERY destination (not just existing
    // ones) so `tuck undo` can also delete files this apply newly created —
    // createSnapshot records missing paths as existed:false and restoreSnapshot
    // removes them on undo.
    if (!options.dryRun) {
      const snapshotPaths = files.map((f) => f.destination);

      if (snapshotPaths.length > 0) {
        if (!isJsonMode()) logger.info('Creating backup snapshot...');
        const snapshot = await createPreApplySnapshot(snapshotPaths, source);
        if (!isJsonMode()) logger.success(`Backup created: ${snapshot.id}`);
      }
    }

    // Apply files
    if (options.dryRun) {
      logger.heading('Dry run - would apply:');
    } else {
      logger.heading('Applying:');
    }

    let applyResult: ApplyResult;
    if (strategy === 'merge') {
      applyResult = await applyWithMerge(files, options.dryRun || false);
    } else {
      applyResult = await applyWithReplace(files, options.dryRun || false);
    }

    const allSkipped = [...skipped, ...applyResult.skippedUnboundRepos];

    if (isJsonMode()) {
      emitJsonOk({
        applied: applyResult.appliedCount,
        source,
        dryRun: !!options.dryRun,
        skipped: allSkipped,
      });
      return;
    }

    logger.blank();

    if (options.dryRun) {
      logger.info(`Would apply ${applyResult.appliedCount} files`);
    } else {
      logger.success(`Applied ${applyResult.appliedCount} files`);
    }

    if (allSkipped.length > 0) {
      logger.warning(
        `Skipped ${allSkipped.length} repo-scoped file(s) for unlinked repos: ${allSkipped.join(', ')}`
      );
    }

    // Show placeholder warnings
    displayPlaceholderWarnings(applyResult.filesWithPlaceholders);

    // Try to restore secrets from local store (automatically in non-interactive mode)
    if (!options.dryRun && applyResult.filesWithPlaceholders.length > 0) {
      const secretResult = await tryRestoreSecretsFromLocalStore(applyResult.filesWithPlaceholders, false);
      if (secretResult.restored > 0) {
        logger.success(`Restored ${secretResult.restored} secret${secretResult.restored !== 1 ? 's' : ''} from local store`);
      }
      if (secretResult.unresolved.length > 0) {
        logger.warning(`${secretResult.unresolved.length} placeholder${secretResult.unresolved.length !== 1 ? 's remain' : ' remains'} unresolved`);
      }
    }

    if (!options.dryRun) {
      logger.info('To undo: tuck undo --latest');
    }
  } finally {
    // Clean up temp directory
    try {
      await rm(repoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
};

export const applyCommand = new Command('apply')
  .description('Apply dotfiles from a repository to this machine')
  .argument(
    '<source>',
    'username, user/repo, provider:user/repo, a full git URL, or a local directory/tarball path'
  )
  .option('-m, --merge', 'Merge with existing files (preserve local customizations)')
  .option('-r, --replace', 'Replace existing files completely')
  .option('--dry-run', 'Show what would be applied without making changes')
  .option('-f, --force', 'Apply without confirmation prompts')
  .option('-y, --yes', 'Assume yes to all prompts')
  .option('--json', 'Emit JSON envelope to stdout')
  .option('-b, --bundle <name>', 'Only apply files in the named bundle')
  .option(
    '--repo-root <dir>',
    'Bind an as-yet-unlinked repo to this checkout before applying repo-scoped files'
  )
  .action(async (source: string, options: ApplyOptions) => {
    // Determine if we should run interactive mode
    const isInteractive = !options.force && !options.yes && !options.json && process.stdout.isTTY;

    if (isInteractive) {
      await runInteractiveApply(source, options);
    } else {
      await runApply(source, options);
    }
  });
