/**
 * Write context — the process-wide sandbox boundary for tuck.
 *
 * Normally tuck writes to home-relative paths resolved against the real
 * `os.homedir()`. When invoked with `--root <dir>` (or `TUCK_TARGET_ROOT`),
 * EVERY write destination is instead confined under that root — a "dry home" —
 * and any attempt to escape it (a `..` traversal or an absolute path outside the
 * root) is rejected. This lets an agent run `tuck apply/restore/preset` against
 * a throwaway directory with no possibility of mutating the operator's real `~`.
 *
 * Reads still use `expandPath` (the real home); only WRITE destinations route
 * through `resolveWriteTarget`.
 */

import { homedir } from 'os';
import { resolve, isAbsolute, relative, sep } from 'path';
import { validatePathWithinRoot } from './paths.js';

interface WriteContext {
  root: string;
  isSandbox: boolean;
}

let ctx: WriteContext | null = null;
// Absolute roots of repos bound on THIS machine (from the repo registry). They
// are allowed write destinations in addition to $HOME when not sandboxed.
let knownRepoRoots: string[] = [];

export const setWriteContext = (next: WriteContext): void => {
  ctx = { root: resolve(next.root), isSandbox: next.isSandbox };
};

/** Register the machine's known repo roots (loaded from the repo registry). */
export const setKnownRepoRoots = (roots: string[]): void => {
  knownRepoRoots = roots.map((r) => resolve(r));
};

/**
 * Merge additional repo roots into the allowed-write set WITHOUT dropping the
 * ones the CLI preAction already registered. Used by operations that write into
 * a repo the user is currently sitting in but which is not (yet) in the machine
 * repo registry — e.g. rules fan-out materializing per-tool variants into the
 * current checkout. A no-op in sandbox mode, where `allowedRoots()` is only the
 * sandbox root regardless.
 */
export const addKnownRepoRoots = (roots: string[]): void => {
  const merged = new Set(knownRepoRoots);
  for (const r of roots) merged.add(resolve(r));
  knownRepoRoots = Array.from(merged);
};

/** Test-only: clear the context back to the default (real home). */
export const resetWriteContext = (): void => {
  ctx = null;
  knownRepoRoots = [];
};

/** A captured write-context state for save/restore around a transient override. */
export interface WriteContextSnapshot {
  ctx: WriteContext | null;
  repoRoots: string[];
}

/**
 * Capture the full write-context state so a transient override (e.g. a sandboxed
 * dry-apply) can restore the PRIOR state afterward instead of nuking it —
 * preserving any global `--root` boundary set by the CLI preAction hook. A
 * blind resetWriteContext() in a long-running process (MCP) would otherwise drop
 * the sandbox and let subsequent commands write to the real home.
 */
export const snapshotWriteContext = (): WriteContextSnapshot => ({
  ctx: ctx ? { ...ctx } : null,
  repoRoots: [...knownRepoRoots],
});

/** Restore a previously captured write-context state. */
export const restoreWriteContext = (snap: WriteContextSnapshot): void => {
  ctx = snap.ctx ? { ...snap.ctx } : null;
  knownRepoRoots = [...snap.repoRoots];
};

/** The directory all writes are confined to (real home unless sandboxed). */
export const getWriteRoot = (): string => (ctx ? ctx.root : homedir());

export const isSandbox = (): boolean => (ctx ? ctx.isSandbox : false);

/**
 * Allowed roots for `validateSafeDestinationPath(dest, allowedRoots())`.
 *   - sandbox: ONLY the sandbox root (repo writes are rebased under it).
 *   - normal: $HOME plus every bound repo root (so repo-scoped writes to a
 *     genuine out-of-home checkout are permitted, but only for bound repos).
 */
export const allowedRoots = (): string[] => {
  if (isSandbox()) return [getWriteRoot()];
  return Array.from(new Set([resolve(homedir()), ...knownRepoRoots]));
};

/** A repo-scoped write target descriptor. */
export interface RepoWriteTarget {
  repoKey: string;
  repoRelative: string;
  repoRoot: string;
}

/**
 * Resolve a write destination, confining it within the active root.
 *
 * Repo-scoped writes (when `repo` is given):
 *   - sandbox: rebased by STABLE IDENTITY to `<root>/repos/<repoKey>/<rel>` — the
 *     real (possibly out-of-home) repoRoot is NEVER used to place the file, so a
 *     hostile repoRoot can't escape the sandbox.
 *   - normal: the genuine `<repoRoot>/<rel>`, confined to `repoRoot`.
 *
 * Home-scoped writes (no `repo`):
 *   - `~/x` and `$HOME/x` map to `<root>/x`.
 *   - an absolute path UNDER the real home is re-based into `<root>` when
 *     sandboxed (handles call sites that pass an already-expanded path).
 *   - relative paths resolve against `<root>`.
 * Always validated to be inside the confining root; throws on any escape.
 */
export const resolveWriteTarget = (source: string, repo?: RepoWriteTarget): string => {
  const root = resolve(getWriteRoot());
  const home = resolve(homedir());

  if (repo) {
    const relNorm = repo.repoRelative.replace(/\\/g, '/');
    if (isSandbox()) {
      const keySlug = repo.repoKey.replace(/[^a-zA-Z0-9._-]/g, '_');
      const target = resolve(root, 'repos', keySlug, relNorm);
      validatePathWithinRoot(target, root, 'repo write target (sandbox)');
      return target;
    }
    const repoRootAbs = resolve(repo.repoRoot);
    const target = resolve(repoRootAbs, relNorm);
    validatePathWithinRoot(target, repoRootAbs, 'repo write target');
    return target;
  }

  let target: string;
  if (source === '~' || source.startsWith('~/') || source.startsWith('~\\')) {
    const rel = source === '~' ? '' : source.slice(2);
    target = resolve(root, rel);
  } else if (source.startsWith('$HOME')) {
    const rel = source.slice('$HOME'.length).replace(/^[/\\]+/, '');
    target = resolve(root, rel);
  } else if (isAbsolute(source)) {
    const abs = resolve(source);
    if (isSandbox() && (abs === home || abs.startsWith(home + sep))) {
      // An absolute path under the real home → re-base into the sandbox root.
      target = resolve(root, relative(home, abs));
    } else {
      target = abs;
    }
  } else {
    target = resolve(root, source);
  }

  validatePathWithinRoot(target, root, 'write target');
  return target;
};
