/**
 * Declarative dependency declarations (IDEAS 2.3).
 *
 * A tracked file may declare `requires: ["brew:starship", "apt:zsh"]` in the
 * manifest. Each value is a `<manager>:<package>` spec naming a package that
 * must be present BEFORE the file is applied. This module parses those specs,
 * collects them across a manifest, and topologically orders the resulting
 * dependency graph so `tuck bootstrap`/`tuck apply` can install packages before
 * the files that need them (and fail loudly on an impossible cycle).
 *
 * The model is intentionally decoupled from any package-installation code: this
 * file only understands the DECLARATIONS. `lib/packageInstall.ts` turns a
 * parsed {@link Requirement} into an actual install/verify command, and stays
 * optional so the plan can be shown even where no installer is available.
 */

import type { TuckManifestOutput } from '../schemas/manifest.schema.js';
import { InvalidRequirementError, CyclicDependencyError } from '../errors.js';

/**
 * Package managers tuck understands in a `requires:` spec. Adding a manager
 * here (plus an entry in {@link PACKAGE_MANAGER_SPECS}) is all that is needed to
 * support a new ecosystem — nothing else in the plan/bootstrap flow hard-codes a
 * manager name.
 */
export const PACKAGE_MANAGERS = [
  'brew',
  'apt',
  'dnf',
  'pacman',
  'winget',
  'scoop',
  'cargo',
  'npm',
  'pnpm',
  'pipx',
  'go',
  'gem',
] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** A parsed `<manager>:<package>` requirement. */
export interface Requirement {
  /** The original spec exactly as written in the manifest (e.g. "brew:starship"). */
  raw: string;
  /** The package manager segment. */
  manager: PackageManager;
  /** The package name segment (everything after the first ':'). */
  name: string;
}

const isPackageManager = (value: string): value is PackageManager =>
  (PACKAGE_MANAGERS as readonly string[]).includes(value);

/**
 * Parse a single `<manager>:<package>` requirement spec.
 *
 * @throws {InvalidRequirementError} when the spec is malformed or names a
 *   manager tuck does not understand. Failing fast here keeps a typo
 *   (`brw:starship`) from silently becoming a no-op at install time.
 */
export const parseRequirement = (spec: string): Requirement => {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new InvalidRequirementError(spec, 'empty requirement');
  }

  const sep = trimmed.indexOf(':');
  if (sep <= 0) {
    throw new InvalidRequirementError(spec, 'missing "<manager>:" prefix');
  }

  const manager = trimmed.slice(0, sep).trim().toLowerCase();
  const name = trimmed.slice(sep + 1).trim();

  if (name.length === 0) {
    throw new InvalidRequirementError(spec, 'missing package name after ":"');
  }
  if (!isPackageManager(manager)) {
    throw new InvalidRequirementError(spec, `unknown package manager "${manager}"`);
  }

  return { raw: `${manager}:${name}`, manager, name };
};

/** Non-throwing predicate: true when {@link parseRequirement} would succeed. */
export const isValidRequirement = (spec: string): boolean => {
  try {
    parseRequirement(spec);
    return true;
  } catch {
    return false;
  }
};

/**
 * Parse a comma/whitespace-separated list of requirement specs (as accepted on
 * the `tuck add --requires` flag). Empty segments are ignored; each remaining
 * segment is validated. Returns the deduped raw specs preserving first-seen
 * order so the stored manifest list is stable.
 */
export const parseRequirementList = (input: string): string[] => {
  const specs = input
    .split(/[\s,]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const spec of specs) {
    const req = parseRequirement(spec); // throws on invalid — fail fast at add time
    if (!seen.has(req.raw)) {
      seen.add(req.raw);
      out.push(req.raw);
    }
  }
  return out;
};

/**
 * Collect every requirement declared across a manifest, deduplicated by raw
 * spec and preserving first-seen order.
 *
 * Malformed specs are collected into `invalid` rather than thrown: a manifest
 * authored on another machine (or hand-edited) must still be inspectable, so the
 * caller decides whether an unknown manager is a warning (bootstrap: skip it) or
 * a hard error. Valid requirements are returned parsed.
 */
export const collectRequirements = (
  manifest: TuckManifestOutput
): { requirements: Requirement[]; invalid: string[] } => {
  const seen = new Set<string>();
  const requirements: Requirement[] = [];
  const invalid: string[] = [];

  for (const file of Object.values(manifest.files)) {
    for (const spec of file.requires ?? []) {
      let req: Requirement;
      try {
        req = parseRequirement(spec);
      } catch {
        if (!invalid.includes(spec)) invalid.push(spec);
        continue;
      }
      if (!seen.has(req.raw)) {
        seen.add(req.raw);
        requirements.push(req);
      }
    }
  }

  return { requirements, invalid };
};

// ============================================================================
// Topological ordering
// ============================================================================

/** A node in a dependency graph: `id` depends on every id in `deps`. */
export interface DepNode {
  id: string;
  /** ids this node depends on (must be ordered BEFORE this node). */
  deps: string[];
}

/**
 * Topologically sort a dependency graph so every node appears AFTER all of its
 * declared dependencies. Uses Kahn's algorithm; ties are broken by the node's
 * original position so the output is deterministic.
 *
 * Dependencies referencing ids that are not themselves nodes are ignored
 * (treated as already-satisfied) — this lets callers pass a subset of a larger
 * graph without first materializing every external id.
 *
 * @throws {CyclicDependencyError} if the graph contains a cycle. The reported
 *   cycle is a concrete chain of ids that mutually depend on each other.
 */
export const topologicalSort = (nodes: DepNode[]): string[] => {
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));

  // Build adjacency (dep → dependents) and in-degree over KNOWN ids only.
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    if (!indegree.has(node.id)) indegree.set(node.id, 0);
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!index.has(dep)) continue; // external/unknown dependency: skip
      if (dep === node.id) {
        // A self-edge is the smallest possible cycle.
        throw new CyclicDependencyError([node.id]);
      }
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
    }
  }

  // Seed the queue with zero-in-degree nodes in original order (stable output).
  const ready: string[] = nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id);

  const ordered: string[] = [];
  while (ready.length > 0) {
    // Pop the ready node with the smallest original index for determinism.
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const id = ready.shift() as string;
    ordered.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }

  if (ordered.length !== nodes.length) {
    // Remaining nodes with residual in-degree are exactly those trapped in a
    // cycle. Extract one concrete cycle for the error message.
    const remaining = new Set(nodes.filter((n) => !ordered.includes(n.id)).map((n) => n.id));
    throw new CyclicDependencyError(extractCycle(nodes, remaining));
  }

  return ordered;
};

/**
 * Walk the residual (cyclic) subgraph following the first still-present
 * dependency at each step until a node repeats, then return that loop. Best
 * effort: any concrete cycle is far more actionable than "a cycle exists".
 */
const extractCycle = (nodes: DepNode[], remaining: Set<string>): string[] => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = [...remaining][0];
  if (start === undefined) return [];

  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    const node = byId.get(current);
    current = node?.deps.find((d) => remaining.has(d));
  }
  if (current === undefined) return path;
  // Trim the tail preceding the point where the cycle closes.
  const loopStart = path.indexOf(current);
  return loopStart >= 0 ? path.slice(loopStart) : path;
};
