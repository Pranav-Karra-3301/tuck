/**
 * Repo-scoped tracking: stable cross-machine repo identity + the machine-local
 * registry that maps that identity to a concrete absolute root.
 *
 * A repo-scoped tracked file is identified in the (committed) manifest by
 * `(repoKey, repoRelative)` only — NO absolute path. Each machine keeps its own
 * `repos.json` (under the off-repo state dir) mapping `repoKey -> { root }`, so
 * the same shared manifest resolves to `/Users/a/work/foo` on one machine and
 * `/home/b/projects/foo` on another. An unknown key resolves to `null` and is
 * skipped — never guessed.
 */

import { join, basename, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { ensureDir } from 'fs-extra';
import { getStateDir } from './state.js';
import { atomicWriteFile } from './files.js';
import { pathExists, expandPath } from './paths.js';
import { getRemoteUrl } from './git.js';
import { reposRegistrySchema, type ReposRegistry } from '../schemas/repos.schema.js';

const REGISTRY_MODE = 0o600;

export const getReposRegistryPath = (): string => join(getStateDir(), 'repos.json');

const emptyRegistry = (): ReposRegistry => ({ version: '1', repos: {} });

/** Load the machine-local repo registry; returns empty on absence or corruption. */
export const loadReposRegistry = async (): Promise<ReposRegistry> => {
  const p = getReposRegistryPath();
  if (!(await pathExists(p))) return emptyRegistry();
  try {
    const parsed = reposRegistrySchema.safeParse(JSON.parse(await readFile(p, 'utf-8')));
    return parsed.success ? parsed.data : emptyRegistry();
  } catch {
    return emptyRegistry();
  }
};

/** Bind a repoKey to an absolute root on THIS machine (idempotent upsert). */
export const bindRepo = async (
  repoKey: string,
  root: string,
  opts: { remoteUrl?: string; boundAt?: string } = {}
): Promise<void> => {
  const reg = await loadReposRegistry();
  reg.repos[repoKey] = {
    root: resolve(root),
    ...(opts.remoteUrl ? { remoteUrl: opts.remoteUrl } : {}),
    boundAt: opts.boundAt ?? new Date().toISOString(),
  };
  await ensureDir(getStateDir());
  await atomicWriteFile(getReposRegistryPath(), JSON.stringify(reg, null, 2) + '\n', {
    mode: REGISTRY_MODE,
  });
};

/** Remove a binding. */
export const unbindRepo = async (repoKey: string): Promise<boolean> => {
  const reg = await loadReposRegistry();
  if (!(repoKey in reg.repos)) return false;
  delete reg.repos[repoKey];
  await ensureDir(getStateDir());
  await atomicWriteFile(getReposRegistryPath(), JSON.stringify(reg, null, 2) + '\n', {
    mode: REGISTRY_MODE,
  });
  return true;
};

/** Resolve a repoKey to this machine's absolute root, or null if unbound. */
export const resolveRepoRoot = async (repoKey: string): Promise<string | null> => {
  const reg = await loadReposRegistry();
  return reg.repos[repoKey]?.root ?? null;
};

/** Minimal shape needed to resolve a tracked file's live location. */
export interface ResolvableFile {
  source: string;
  scope?: 'home' | 'repo';
  repoKey?: string;
  repoRelative?: string;
}

/**
 * Resolve a tracked file's LIVE location on THIS machine.
 *   - home (scope absent/'home'): expandPath(source).
 *   - repo: join(resolveRepoRoot(repoKey), repoRelative), or `null` when the
 *     repo is not bound on this machine (caller skips it — never guesses).
 */
export const resolveLiveTarget = async (file: ResolvableFile): Promise<string | null> => {
  if (file.scope !== 'repo') return expandPath(file.source);
  if (!file.repoKey || !file.repoRelative) return null;
  const root = await resolveRepoRoot(file.repoKey);
  if (!root) return null;
  return join(root, file.repoRelative);
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'repo';

/**
 * Canonicalize a git remote URL so the SSH and HTTPS forms of the same repo
 * map to ONE string — the basis for a machine-independent repoKey.
 *   git@github.com:u/r.git  ->  github.com/u/r
 *   https://github.com/u/r  ->  github.com/u/r
 *   ssh://git@github.com/u/r.git -> github.com/u/r
 */
export const canonicalRemoteUrl = (url: string): string => {
  const u = url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  const ssh = u.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const proto = u.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (proto) return `${proto[1]}/${proto[2]}`;
  return u;
};

/** Build a stable repoKey from a directory basename + a stable identity string. */
export const repoKeyFromIdentity = (dirBasename: string, identity: string): string =>
  `${slugify(dirBasename)}-${createHash('sha256').update(identity).digest('hex').slice(0, 8)}`;

/**
 * Slugify a path into a filesystem-safe id fragment used by the repo/home
 * fan-out destination scheme. Strips a leading `~/`, maps runs of unsafe
 * characters to a single `-`, trims dashes, and lowercases — preserving `._-`.
 *
 * NOTE: distinct from {@link slugify}, which is the tighter (alnum-only,
 * length-capped, `'repo'`-defaulting) slug used inside repoKey identities.
 */
export const slugifyPath = (p: string): string =>
  p
    .replace(/^~?\/+/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

/** Collision-safe scope key for a repo root: `<basename-slug>__<full-path-slug>`. */
export const repoScopeKey = (repoRoot: string): string =>
  slugifyPath(basename(repoRoot)) + '__' + slugifyPath(repoRoot);

/** Walk up from `start` to find the enclosing git repo root, or null. */
export const findGitRoot = async (start: string): Promise<string | null> => {
  // expandPath, not resolve(): win32 resolve() stamps the host drive letter
  // onto drive-less absolute paths, corrupting the returned repo root. It also
  // expands a leading `~/` that resolve() would leave verbatim.
  let dir = expandPath(start);
  for (let i = 0; i < 64; i++) {
    if (await pathExists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
};

/**
 * Derive the stable repoKey for a repo root. Identity priority:
 *   1. explicit `opts.repoKey` (slugified) — the escape hatch
 *   2. canonicalized `origin` remote URL — identical across clones/machines
 *   3. first-commit hash — stable when there is no remote
 *   4. basename + random suffix — last resort (not cross-machine stable)
 */
export const deriveRepoKey = async (
  repoRoot: string,
  opts: { repoKey?: string; remoteUrl?: string } = {}
): Promise<{ repoKey: string; remoteUrl?: string }> => {
  const name = basename(resolve(repoRoot));
  if (opts.repoKey) return { repoKey: slugify(opts.repoKey) };

  const remoteUrl = opts.remoteUrl ?? (await getRemoteUrl(repoRoot).catch(() => null)) ?? undefined;
  if (remoteUrl) {
    const canonical = canonicalRemoteUrl(remoteUrl);
    return { repoKey: repoKeyFromIdentity(name, canonical), remoteUrl: canonical };
  }

  const firstCommit = await firstCommitHash(repoRoot).catch(() => null);
  if (firstCommit) return { repoKey: repoKeyFromIdentity(name, firstCommit) };

  // Last resort: not cross-machine stable, but unique. randomBytes via crypto.
  const rand = createHash('sha256').update(`${name}:${process.pid}:${Math.random()}`).digest('hex');
  return { repoKey: repoKeyFromIdentity(name, rand) };
};

const firstCommitHash = async (repoRoot: string): Promise<string | null> => {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-list', '--max-parents=0', 'HEAD']);
    const hash = stdout.trim().split('\n')[0]?.trim();
    return hash || null;
  } catch {
    return null;
  }
};
