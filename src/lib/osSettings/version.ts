/**
 * OS-version comparison for apply-mode guards.
 *
 * macOS product versions are dotted numeric strings ("15", "15.1", "13.6.1").
 * We compare them component-wise as integers so a setting captured on 15.1 can
 * declare a `minVersion`/`maxVersion` window and apply mode can decide whether
 * the current machine falls inside it. Non-numeric noise is ignored rather than
 * throwing — a malformed version must never crash apply, only fail the guard.
 */

/** Parse a dotted version into an integer tuple, ignoring non-numeric parts. */
export const parseVersion = (version: string): number[] => {
  return version
    .trim()
    .split('.')
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
};

/**
 * Compare two dotted versions.
 * @returns negative if a < b, 0 if equal, positive if a > b.
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
};

export interface VersionGuardResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

/**
 * Check whether `current` satisfies the inclusive [min, max] window. A missing
 * or empty bound means "unbounded on that side". An empty/blank `current`
 * version passes (we cannot prove it fails a guard, and blocking on an
 * undetectable OS version would be more surprising than allowing it).
 */
export const isVersionInRange = (
  current: string,
  minVersion?: string | null,
  maxVersion?: string | null
): VersionGuardResult => {
  const cur = current.trim();
  if (!cur) return { ok: true };

  const min = minVersion?.trim();
  if (min && compareVersions(cur, min) < 0) {
    return { ok: false, reason: `requires OS >= ${min} (current ${cur})` };
  }

  const max = maxVersion?.trim();
  if (max && compareVersions(cur, max) > 0) {
    return { ok: false, reason: `requires OS <= ${max} (current ${cur})` };
  }

  return { ok: true };
};
