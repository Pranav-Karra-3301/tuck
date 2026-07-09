/**
 * Idempotent package installation for declared `requires:` (IDEAS 2.2 / 2.3).
 *
 * Turns a parsed {@link Requirement} into a "check, then install if missing"
 * operation so re-running `tuck bootstrap` CONVERGES instead of erroring:
 *   - already installed        → reported, nothing run
 *   - manager binary absent     → skipped with a warning (never a hard failure)
 *   - missing but installable   → the manager's install command is run
 *
 * All external process execution flows through an injectable {@link CommandRunner}
 * so tests can drive the full flow without touching the real network, Homebrew,
 * apt, or any system package database.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { commandExists } from './commandPath.js';
import type { PackageManager, Requirement } from './requires.js';

const execFileAsync = promisify(execFile);

/**
 * How a package manager checks for and installs a package. `check` returning a
 * zero exit code means "already installed". Managers with no cheap idempotent
 * check (`check: null`) are treated as always-needs-install unless a check is
 * supplied — for those, `install` itself must be idempotent (brew/apt/etc. are).
 */
export interface PackageManagerSpec {
  manager: PackageManager;
  /** Executable that must be on PATH for this manager to be usable. */
  bin: string;
  /** Args to test whether `pkg` is already installed, or null if unsupported. */
  check: ((pkg: string) => string[]) | null;
  /** Args to install `pkg`. Should be non-interactive/idempotent where possible. */
  install: (pkg: string) => string[];
}

export const PACKAGE_MANAGER_SPECS: Record<PackageManager, PackageManagerSpec> = {
  brew: {
    manager: 'brew',
    bin: 'brew',
    check: (pkg) => ['list', pkg],
    install: (pkg) => ['install', pkg],
  },
  apt: {
    manager: 'apt',
    bin: 'apt-get',
    check: null,
    install: (pkg) => ['install', '-y', pkg],
  },
  dnf: {
    manager: 'dnf',
    bin: 'dnf',
    check: (pkg) => ['list', 'installed', pkg],
    install: (pkg) => ['install', '-y', pkg],
  },
  pacman: {
    manager: 'pacman',
    bin: 'pacman',
    check: (pkg) => ['-Q', pkg],
    install: (pkg) => ['-S', '--noconfirm', pkg],
  },
  winget: {
    manager: 'winget',
    bin: 'winget',
    check: (pkg) => ['list', '--id', pkg, '--exact'],
    install: (pkg) => ['install', '--id', pkg, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
  },
  scoop: {
    manager: 'scoop',
    bin: 'scoop',
    check: (pkg) => ['list', pkg],
    install: (pkg) => ['install', pkg],
  },
  cargo: {
    manager: 'cargo',
    bin: 'cargo',
    check: null,
    install: (pkg) => ['install', pkg],
  },
  npm: {
    manager: 'npm',
    bin: 'npm',
    check: (pkg) => ['ls', '-g', pkg],
    install: (pkg) => ['install', '-g', pkg],
  },
  pnpm: {
    manager: 'pnpm',
    bin: 'pnpm',
    check: (pkg) => ['ls', '-g', pkg],
    install: (pkg) => ['add', '-g', pkg],
  },
  pipx: {
    manager: 'pipx',
    bin: 'pipx',
    check: null,
    install: (pkg) => ['install', pkg],
  },
  go: {
    manager: 'go',
    bin: 'go',
    check: null,
    install: (pkg) => ['install', pkg],
  },
  gem: {
    manager: 'gem',
    bin: 'gem',
    check: (pkg) => ['list', '-i', pkg],
    install: (pkg) => ['install', pkg],
  },
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner: default uses child_process; tests supply a stub. */
export interface CommandRunner {
  /** True when `bin` is resolvable on PATH. */
  which(bin: string): Promise<boolean>;
  /** Run `bin` with `args`; resolves with the exit code and captured output. */
  run(bin: string, args: string[]): Promise<RunResult>;
}

/** Default runner backed by child_process.execFile — never used in tests. */
export const defaultRunner: CommandRunner = {
  which: (bin) => commandExists(bin),
  run: async (bin, args) => {
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: 10 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
      };
    }
  },
};

export type InstallStatus =
  | 'already-installed'
  | 'installed'
  | 'would-install'
  | 'skipped-no-manager'
  | 'failed';

export interface InstallResult {
  requirement: Requirement;
  status: InstallStatus;
  /** Populated for 'failed' (the install command's stderr/summary). */
  error?: string;
}

/** Whether a package is already present, using the manager's check command. */
export const isPackageInstalled = async (
  requirement: Requirement,
  runner: CommandRunner
): Promise<boolean> => {
  const spec = PACKAGE_MANAGER_SPECS[requirement.manager];
  if (!spec.check) return false; // no cheap check → force the (idempotent) install path
  const result = await runner.run(spec.bin, spec.check(requirement.name));
  return result.code === 0;
};

/**
 * Install a single requirement idempotently.
 *
 * - `dryRun` never runs the install command; it still probes the check command
 *   so the reported status reflects reality (already-installed vs would-install).
 * - A missing manager binary is a SKIP, not a failure: a repo that lists
 *   `winget:` packages must still bootstrap on macOS.
 */
export const installRequirement = async (
  requirement: Requirement,
  runner: CommandRunner,
  options: { dryRun?: boolean } = {}
): Promise<InstallResult> => {
  const spec = PACKAGE_MANAGER_SPECS[requirement.manager];

  if (!(await runner.which(spec.bin))) {
    return { requirement, status: 'skipped-no-manager' };
  }

  if (await isPackageInstalled(requirement, runner)) {
    return { requirement, status: 'already-installed' };
  }

  if (options.dryRun) {
    return { requirement, status: 'would-install' };
  }

  const result = await runner.run(spec.bin, spec.install(requirement.name));
  if (result.code === 0) {
    return { requirement, status: 'installed' };
  }
  return {
    requirement,
    status: 'failed',
    error: (result.stderr || result.stdout || `exit code ${result.code}`).trim(),
  };
};

export interface InstallReport {
  results: InstallResult[];
  installed: number;
  alreadyInstalled: number;
  wouldInstall: number;
  skipped: number;
  failed: number;
}

/**
 * Install a list of requirements in order, aggregating a report. Requirements
 * are already deduped/ordered by the caller (the bootstrap plan). One failure
 * does not abort the rest — the report carries every outcome so the caller can
 * decide whether a partial install is fatal.
 */
export const installRequirements = async (
  requirements: Requirement[],
  runner: CommandRunner,
  options: { dryRun?: boolean } = {}
): Promise<InstallReport> => {
  const results: InstallResult[] = [];
  for (const requirement of requirements) {
    results.push(await installRequirement(requirement, runner, options));
  }
  return {
    results,
    installed: results.filter((r) => r.status === 'installed').length,
    alreadyInstalled: results.filter((r) => r.status === 'already-installed').length,
    wouldInstall: results.filter((r) => r.status === 'would-install').length,
    skipped: results.filter((r) => r.status === 'skipped-no-manager').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
};
