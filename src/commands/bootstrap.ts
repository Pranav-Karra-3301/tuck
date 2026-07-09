import { Command } from 'commander';
import { rm } from 'fs/promises';
import { banner, prompts, logger } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { setJsonMode, isJsonMode, emitJsonOk, addJsonWarning } from '../lib/jsonOutput.js';
import { BootstrapError } from '../errors.js';
import type { BootstrapOptions } from '../types.js';
import {
  resolveSource,
  cloneSource,
  readClonedManifest,
  applyRepoDir,
  tryRestoreSecretsFromLocalStore,
} from './apply.js';
import { buildBootstrapPlan, formatPlan, planToJson, type BootstrapPlan } from '../lib/bootstrapPlan.js';
import {
  installRequirements,
  defaultRunner,
  type CommandRunner,
  type InstallReport,
} from '../lib/packageInstall.js';
import { runDoctorChecks, type DoctorReport } from '../lib/doctor.js';

// ============================================================================
// Dependency verification
// ============================================================================

export interface DependencyReport {
  /** git is REQUIRED — bootstrap cannot clone without it. */
  git: boolean;
  /** gh is optional (only used to resolve a bare username to a repo). */
  gh: boolean;
}

/**
 * Verify the host tools bootstrap needs. Only `git` is required; `gh` is a
 * convenience for username→repo resolution. Uses the injected runner's `which`
 * so tests never depend on the host PATH.
 */
export const checkBootstrapDependencies = async (
  runner: CommandRunner
): Promise<DependencyReport> => {
  const [git, gh] = await Promise.all([runner.which('git'), runner.which('gh')]);
  return { git, gh };
};

// ============================================================================
// Secrets backend resolution (informational)
// ============================================================================

export interface SecretsBackendInfo {
  /** Configured backend name (`auto` resolves to the local encrypted store). */
  backend: string;
  /** Human note describing how secrets will be resolved on apply. */
  note: string;
}

/**
 * Report which secret backend will resolve placeholders during apply. This is
 * intentionally read-only and network-free: it reflects local configuration so
 * bootstrap can tell the user (and the JSON envelope can record) how secrets are
 * expected to resolve, without prompting or hitting an external CLI.
 */
export const resolveSecretsBackendInfo = async (tuckDir: string): Promise<SecretsBackendInfo> => {
  let backend = 'auto';
  try {
    const config = await loadConfig(tuckDir);
    backend = config.security.secretBackend ?? 'auto';
  } catch {
    // No local config yet (fresh machine): fall back to the default.
  }
  const note =
    backend === 'auto' || backend === 'local'
      ? 'Secrets resolve from the local encrypted store; unresolved placeholders remain for you to set with `tuck secrets set`.'
      : `Secrets resolve from the "${backend}" backend on apply.`;
  return { backend, note };
};

// ============================================================================
// Orchestration
// ============================================================================

export interface BootstrapReport {
  repo: string;
  dependencies: DependencyReport;
  secretsBackend: SecretsBackendInfo;
  plan: ReturnType<typeof planToJson>;
  packages: {
    installed: number;
    alreadyInstalled: number;
    skipped: number;
    failed: number;
    wouldInstall: number;
    skippedPhase: boolean;
  };
  applied: number;
  skippedFiles: string[];
  unresolvedSecrets: number;
  restoredSecrets: number;
  doctor?: { passed: number; warnings: number; failed: number; skipped: boolean };
  dryRun: boolean;
}

export interface BootstrapDeps {
  /** Injectable process runner for dependency checks + package installs. */
  runner?: CommandRunner;
}

/**
 * One-command, idempotent machine setup (IDEAS 2.2).
 *
 * Phases: verify deps → clone repo (once) → build & show the plan → resolve
 * secrets backend → install declared packages → apply dotfiles → run doctor.
 * Every phase is convergent: packages are checked-before-installed, apply merges
 * (and snapshots first for `tuck undo`), and doctor is read-only — so re-running
 * bootstrap on an already-configured machine reports "already installed / up to
 * date" instead of erroring.
 */
export const runBootstrap = async (
  repo: string,
  options: BootstrapOptions,
  deps: BootstrapDeps = {}
): Promise<BootstrapReport> => {
  const runner = deps.runner ?? defaultRunner;
  const json = !!options.json;
  if (json) setJsonMode(true, 'tuck bootstrap');

  const dryRun = !!options.dryRun;
  const interactive =
    !options.yes && !options.force && !json && !dryRun && !!process.stdout.isTTY;

  if (!json && !dryRun) {
    banner();
    prompts.intro('tuck bootstrap');
  }

  // 1. Verify dependencies. git is required — fail fast with a helpful error.
  const dependencies = await checkBootstrapDependencies(runner);
  if (!dependencies.git) {
    throw new BootstrapError('git is required but was not found on PATH', [
      'Install git: https://git-scm.com/downloads',
      'Ensure git is on your PATH and re-run `tuck bootstrap`',
    ]);
  }
  if (!json && !dryRun) {
    logger.success('git found');
    if (!dependencies.gh) {
      logger.dim('gh (GitHub CLI) not found — a bare username may not resolve to a repo');
    }
  }

  // 2. Resolve + clone the repo ONCE. The apply step below reuses this local
  //    checkout, so a remote repo is fetched over the network exactly once.
  let repoDir: string;
  const resolved = await resolveSource(repo);
  try {
    if (!json && !dryRun) logger.info(resolved.local ? 'Reading local source...' : 'Cloning repository...');
    repoDir = await cloneSource(resolved);
  } catch (error) {
    throw new BootstrapError(
      `could not clone ${repo}: ${error instanceof Error ? error.message : String(error)}`,
      ['Verify the repository exists and is accessible', 'Check your network connection']
    );
  }

  try {
    const manifest = await readClonedManifest(repoDir);
    if (!manifest) {
      throw new BootstrapError('no tuck manifest (.tuckmanifest.json) found in the repository', [
        'This repository may not be managed by tuck',
        'Confirm you passed the correct dotfiles repository',
      ]);
    }

    // 3. Build the plan (topologically ordered: packages → files) and show it.
    const plan: BootstrapPlan = buildBootstrapPlan(manifest, { bundle: options.bundle });

    if (!json && !dryRun) {
      prompts.note(formatPlan(plan), 'Plan');
    }
    for (const spec of plan.invalidRequirements) {
      const msg = `Ignoring unrecognized requirement: ${spec}`;
      if (json) addJsonWarning(msg);
      else if (!dryRun) logger.warning(msg);
    }

    // Confirm the plan before any mutation (interactive only).
    if (interactive) {
      const confirmed = await prompts.confirm(
        `Bootstrap this machine from ${repo}?`,
        true
      );
      if (!confirmed) {
        // prompts.cancel throws OperationCancelledError (typed `never`), so the
        // finally block still runs and the temp checkout is cleaned up.
        prompts.cancel('Bootstrap cancelled');
      }
    }

    // 4. Resolve the secrets backend (informational, read-only).
    const secretsBackend = await resolveSecretsBackendInfo(getTuckDir());
    if (!json && !dryRun) {
      logger.info(`Secrets backend: ${secretsBackend.backend}`);
    }

    // 5. Install declared packages (idempotent; skipped managers are not fatal).
    let installReport: InstallReport = {
      results: [],
      installed: 0,
      alreadyInstalled: 0,
      wouldInstall: 0,
      skipped: 0,
      failed: 0,
    };
    if (!options.skipPackages && plan.packages.length > 0) {
      if (!json && !dryRun) logger.heading('Installing packages...');
      installReport = await installRequirements(plan.packages, runner, { dryRun });
      if (!json && !dryRun) {
        for (const r of installReport.results) {
          if (r.status === 'installed') logger.success(`installed ${r.requirement.raw}`);
          else if (r.status === 'already-installed') logger.dim(`already installed ${r.requirement.raw}`);
          else if (r.status === 'skipped-no-manager')
            logger.warning(`skipped ${r.requirement.raw} (${r.requirement.manager} not available)`);
          else if (r.status === 'failed')
            logger.error(`failed ${r.requirement.raw}: ${r.error ?? 'unknown error'}`);
        }
      }
      for (const r of installReport.results) {
        if (r.status === 'failed' && json)
          addJsonWarning(`failed to install ${r.requirement.raw}: ${r.error ?? 'unknown error'}`);
      }
    }

    // 6. Apply dotfiles (reusing the already-cloned checkout — no second fetch).
    if (!json && !dryRun) logger.heading(dryRun ? 'Planned files...' : 'Applying dotfiles...');
    const applyResult = await applyRepoDir(repoDir, repo, {
      merge: options.merge,
      replace: options.replace,
      dryRun,
      bundle: options.bundle,
      repoRoot: options.repoRoot,
    });
    for (const msg of applyResult.unsafe) {
      if (json) addJsonWarning(msg);
      else if (!dryRun) logger.warning(msg);
    }

    // Attempt to restore any unresolved placeholders from the local secret store
    // (non-interactive; logs via the json-gated logger so it is JSON-safe).
    let restoredSecrets = 0;
    let unresolvedSecrets = applyResult.filesWithPlaceholders.reduce(
      (n, f) => n + f.placeholders.length,
      0
    );
    if (!dryRun && applyResult.filesWithPlaceholders.length > 0) {
      const restore = await tryRestoreSecretsFromLocalStore(applyResult.filesWithPlaceholders, false);
      restoredSecrets = restore.restored;
      unresolvedSecrets = restore.unresolved.length;
    }

    // 7. Run doctor (read-only health check) unless skipped.
    let doctor: BootstrapReport['doctor'];
    if (options.skipDoctor || dryRun) {
      doctor = { passed: 0, warnings: 0, failed: 0, skipped: true };
    } else {
      const report: DoctorReport = await runDoctorChecks();
      doctor = {
        passed: report.summary.passed,
        warnings: report.summary.warnings,
        failed: report.summary.failed,
        skipped: false,
      };
      if (!json) {
        logger.info(
          `Doctor: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed`
        );
      }
    }

    const report: BootstrapReport = {
      repo,
      dependencies,
      secretsBackend,
      plan: planToJson(plan),
      packages: {
        installed: installReport.installed,
        alreadyInstalled: installReport.alreadyInstalled,
        skipped: installReport.skipped,
        failed: installReport.failed,
        wouldInstall: installReport.wouldInstall,
        skippedPhase: !!options.skipPackages,
      },
      applied: applyResult.applied,
      skippedFiles: applyResult.skipped,
      unresolvedSecrets,
      restoredSecrets,
      doctor,
      dryRun,
    };

    if (json) {
      emitJsonOk(report, 'tuck bootstrap');
    } else if (dryRun) {
      logger.blank();
      logger.heading('Bootstrap plan (dry run)');
      logger.info(formatPlan(plan));
      logger.info(
        `Would apply ${report.applied} file(s)` +
          (plan.packages.length > 0
            ? `; ${installReport.wouldInstall} package(s) to install, ${installReport.alreadyInstalled} already present`
            : '')
      );
    } else {
      logger.blank();
      logger.success(
        `Bootstrap complete: ${report.applied} file(s) applied, ` +
          `${installReport.installed} package(s) installed` +
          (installReport.alreadyInstalled > 0 ? `, ${installReport.alreadyInstalled} already present` : '')
      );
      if (unresolvedSecrets > 0) {
        logger.warning(
          `${unresolvedSecrets} secret placeholder(s) remain — set them with \`tuck secrets set\` and re-run \`tuck bootstrap\``
        );
      }
      prompts.note('Re-run `tuck bootstrap` anytime — it converges instead of erroring.', 'Idempotent');
      prompts.outro('Done!');
    }

    return report;
  } finally {
    try {
      await rm(repoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors — the temp checkout is disposable.
    }
  }
};

export const bootstrapCommand = new Command('bootstrap')
  .description('One-command, idempotent machine setup from a dotfiles repository')
  .argument(
    '<repo>',
    'username, user/repo, provider:user/repo, a full git URL, or a local directory/tarball path'
  )
  .option('-m, --merge', 'Merge with existing files (preserve local customizations, default)')
  .option('-r, --replace', 'Replace existing files completely')
  .option('--skip-packages', 'Skip installing declared packages')
  .option('--skip-doctor', 'Skip the final health check')
  .option('--dry-run', 'Show the plan and what would change without making changes')
  .option('-y, --yes', 'Assume yes to all prompts (non-interactive)')
  .option('-f, --force', 'Proceed without the plan confirmation')
  .option('--json', 'Emit a single JSON envelope to stdout')
  .option('-b, --bundle <name>', 'Only bootstrap files in the named bundle')
  .option(
    '--repo-root <dir>',
    'Bind an as-yet-unlinked repo to this checkout before applying repo-scoped files'
  )
  .action(async (repo: string, options: BootstrapOptions) => {
    await runBootstrap(repo, options);
    // In JSON mode isJsonMode() stays set; the envelope has already been emitted.
    if (isJsonMode()) return;
  });
