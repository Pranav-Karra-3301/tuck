/**
 * Declarative bootstrap plan (IDEAS 2.3).
 *
 * Turns a manifest's `requires:` declarations into an ordered, phase-structured
 * plan — packages → files → post-hooks — that `tuck bootstrap` shows the user
 * BEFORE touching the machine (and that the JSON envelope exposes for agents).
 *
 * The ordering is a genuine topological sort of a graph where each tracked file
 * that declares requirements DEPENDS ON its required packages. That guarantees
 * every package precedes the files that need it and surfaces an impossible cycle
 * as a {@link CyclicDependencyError} instead of a broken first login.
 */

import type { TuckManifestOutput } from '../schemas/manifest.schema.js';
import { collectRequirements, topologicalSort, type Requirement, type DepNode } from './requires.js';

export type PhaseId = 'packages' | 'files' | 'hooks';

export interface PlanStep {
  /** Short label shown in the plan (e.g. "brew:starship" or "~/.zshrc"). */
  label: string;
  /** Optional secondary detail (e.g. which package manager). */
  detail?: string;
}

export interface PlanPhase {
  id: PhaseId;
  title: string;
  steps: PlanStep[];
}

export interface BootstrapPlan {
  /** Package requirements in topological (install) order, deduplicated. */
  packages: Requirement[];
  /** Number of tracked files that will be applied (respects the bundle filter). */
  fileCount: number;
  /** Post-apply hook commands, in declared order. */
  hooks: string[];
  /** Requirement specs that failed to parse (unknown manager, bad shape). */
  invalidRequirements: string[];
  /** Ordered phases for display. Empty phases are omitted. */
  phases: PlanPhase[];
}

export interface BuildPlanOptions {
  /** Restrict the file count to a single bundle (mirrors `apply --bundle`). */
  bundle?: string;
  /** Post-apply hook commands to include in the hooks phase. */
  hooks?: string[];
}

/**
 * Count the files that a plan/apply would act on, honoring the bundle filter.
 * A missing/legacy `bundle` is treated as "default" so old manifests count
 * correctly under `--bundle default`.
 */
const countFiles = (manifest: TuckManifestOutput, bundle?: string): number => {
  if (!bundle) return Object.keys(manifest.files).length;
  return Object.values(manifest.files).filter((f) => (f.bundle ?? 'default') === bundle).length;
};

/**
 * Build the ordered bootstrap plan for a manifest.
 *
 * @throws {CyclicDependencyError} if the `requires:` graph contains a cycle.
 */
export const buildBootstrapPlan = (
  manifest: TuckManifestOutput,
  options: BuildPlanOptions = {}
): BootstrapPlan => {
  const { requirements, invalid } = collectRequirements(manifest);

  // Build a dependency graph: every package is a node, and every file that
  // declares requirements is a node depending on those packages. Topologically
  // sorting the whole graph orders each package strictly before the files that
  // need it (and throws on a cycle). We then keep just the package nodes in that
  // order for the install phase.
  const pkgId = (raw: string): string => `pkg:${raw}`;
  const nodes: DepNode[] = [];
  const byRaw = new Map<string, Requirement>();
  for (const req of requirements) {
    byRaw.set(req.raw, req);
    nodes.push({ id: pkgId(req.raw), deps: [] });
  }
  for (const [id, file] of Object.entries(manifest.files)) {
    const deps = (file.requires ?? [])
      .map((spec) => byRaw.get(parseRawSafe(spec))?.raw)
      .filter((raw): raw is string => raw !== undefined)
      .map(pkgId);
    if (deps.length > 0) {
      nodes.push({ id: `file:${id}`, deps });
    }
  }

  const ordered = topologicalSort(nodes);
  const packages: Requirement[] = [];
  for (const nodeId of ordered) {
    if (nodeId.startsWith('pkg:')) {
      const req = byRaw.get(nodeId.slice('pkg:'.length));
      if (req) packages.push(req);
    }
  }

  const fileCount = countFiles(manifest, options.bundle);
  const hooks = options.hooks ?? [];

  const phases: PlanPhase[] = [];
  if (packages.length > 0) {
    phases.push({
      id: 'packages',
      title: 'Install packages',
      steps: packages.map((p) => ({ label: p.raw, detail: p.manager })),
    });
  }
  if (fileCount > 0) {
    phases.push({
      id: 'files',
      title: 'Apply dotfiles',
      steps: [{ label: `${fileCount} file${fileCount === 1 ? '' : 's'}` }],
    });
  }
  if (hooks.length > 0) {
    phases.push({
      id: 'hooks',
      title: 'Run post-apply hooks',
      steps: hooks.map((h) => ({ label: h })),
    });
  }

  return { packages, fileCount, hooks, invalidRequirements: invalid, phases };
};

/**
 * Best-effort raw normalization used only to key a spec against the already
 * parsed requirement map. Invalid specs (already captured in `invalid`) return
 * the original string, which simply won't match any package node.
 */
const parseRawSafe = (spec: string): string => {
  const sep = spec.indexOf(':');
  if (sep <= 0) return spec;
  return `${spec.slice(0, sep).trim().toLowerCase()}:${spec.slice(sep + 1).trim()}`;
};

/**
 * Render a plan as human-readable text (numbered phases with indented steps).
 * Returns an empty-plan sentinel when there is nothing to do.
 */
export const formatPlan = (plan: BootstrapPlan): string => {
  if (plan.phases.length === 0) {
    return 'Nothing to do — no packages, files, or hooks in this repository.';
  }
  const lines: string[] = [];
  plan.phases.forEach((phase, i) => {
    lines.push(`${i + 1}. ${phase.title}`);
    for (const step of phase.steps) {
      const detail = step.detail ? `  (${step.detail})` : '';
      lines.push(`   - ${step.label}${detail}`);
    }
  });
  if (plan.invalidRequirements.length > 0) {
    lines.push('');
    lines.push(`⚠ Ignoring ${plan.invalidRequirements.length} unrecognized requirement(s):`);
    for (const spec of plan.invalidRequirements) {
      lines.push(`   - ${spec}`);
    }
  }
  return lines.join('\n');
};

/** Stable JSON projection of a plan for the `--json` envelope. */
export const planToJson = (
  plan: BootstrapPlan
): {
  packages: Array<{ raw: string; manager: string; name: string }>;
  fileCount: number;
  hooks: string[];
  invalidRequirements: string[];
  phases: Array<{ id: PhaseId; title: string; steps: PlanStep[] }>;
} => ({
  packages: plan.packages.map((p) => ({ raw: p.raw, manager: p.manager, name: p.name })),
  fileCount: plan.fileCount,
  hooks: plan.hooks,
  invalidRequirements: plan.invalidRequirements,
  phases: plan.phases,
});
