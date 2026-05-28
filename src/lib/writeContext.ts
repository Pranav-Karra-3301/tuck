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

export const setWriteContext = (next: WriteContext): void => {
  ctx = { root: resolve(next.root), isSandbox: next.isSandbox };
};

/** Test-only: clear the context back to the default (real home). */
export const resetWriteContext = (): void => {
  ctx = null;
};

/** The directory all writes are confined to (real home unless sandboxed). */
export const getWriteRoot = (): string => (ctx ? ctx.root : homedir());

export const isSandbox = (): boolean => (ctx ? ctx.isSandbox : false);

/** Allowed roots for `validateSafeDestinationPath(dest, allowedRoots())`. */
export const allowedRoots = (): string[] => [getWriteRoot()];

/**
 * Resolve a write destination, confining it within the active root.
 *   - `~/x` and `$HOME/x` map to `<root>/x`.
 *   - an absolute path UNDER the real home is re-based into `<root>` when
 *     sandboxed (handles call sites that pass an already-expanded path).
 *   - relative paths resolve against `<root>`.
 * Always validated to be inside the root; throws on any escape.
 */
export const resolveWriteTarget = (source: string): string => {
  const root = resolve(getWriteRoot());
  const home = resolve(homedir());

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
