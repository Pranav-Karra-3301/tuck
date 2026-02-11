import { homedir } from 'os';
import { join } from 'path';
import type { TuckConfigOutput } from '../schemas/config.schema.js';
import type { TuckManifestOutput } from '../schemas/manifest.schema.js';
import { loadConfig } from './config.js';
import { getStatus } from './git.js';
import { loadManifest } from './manifest.js';
import {
  collapsePath,
  expandPath,
  getConfigPath,
  getManifestPath,
  getTuckDir,
  isDirectory,
  pathExists,
  validatePathWithinRoot,
  validateSafeManifestDestination,
  validateSafeSourcePath,
} from './paths.js';

export const DOCTOR_CATEGORIES = ['env', 'repo', 'manifest', 'security', 'hooks'] as const;

export type DoctorCategory = (typeof DOCTOR_CATEGORIES)[number];
export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheckResult {
  id: string;
  category: DoctorCategory;
  status: DoctorStatus;
  message: string;
  details?: string;
  fix?: string;
}

export interface DoctorSummary {
  passed: number;
  warnings: number;
  failed: number;
}

export interface DoctorReport {
  generatedAt: string;
  tuckDir: string;
  summary: DoctorSummary;
  checks: DoctorCheckResult[];
}

export interface DoctorRunOptions {
  category?: DoctorCategory;
}

interface DoctorContext {
  tuckDir: string;
  manifestPath: string;
  configPath: string;
  hasTuckDir: boolean;
  isTuckDirDirectory: boolean;
  hasGitDir: boolean;
  hasManifestFile: boolean;
  hasConfigFile: boolean;
  manifestLoadError?: string;
  configLoadError?: string;
  manifest?: TuckManifestOutput;
  config?: TuckConfigOutput;
}

interface DoctorCheck {
  id: string;
  category: DoctorCategory;
  run: (context: DoctorContext) => Promise<DoctorCheckResult>;
}

const checkNodeVersion: DoctorCheck = {
  id: 'env.node-version',
  category: 'env',
  run: async () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
    if (major >= 18) {
      return {
        id: 'env.node-version',
        category: 'env',
        status: 'pass',
        message: `Node.js ${process.versions.node} is supported`,
      };
    }

    return {
      id: 'env.node-version',
      category: 'env',
      status: 'fail',
      message: `Node.js ${process.versions.node} is unsupported`,
      fix: 'Upgrade Node.js to version 18 or newer',
    };
  },
};

const checkHomeDirectory: DoctorCheck = {
  id: 'env.home-directory',
  category: 'env',
  run: async () => {
    const home = homedir();
    if (!home || home.trim().length === 0) {
      return {
        id: 'env.home-directory',
        category: 'env',
        status: 'fail',
        message: 'Home directory could not be resolved',
        fix: 'Ensure the current OS user account has a valid home directory',
      };
    }

    return {
      id: 'env.home-directory',
      category: 'env',
      status: 'pass',
      message: `Home directory resolved: ${collapsePath(home)}`,
    };
  },
};

const checkTuckDirectory: DoctorCheck = {
  id: 'repo.tuck-directory',
  category: 'repo',
  run: async (context) => {
    if (context.hasTuckDir && context.isTuckDirDirectory) {
      return {
        id: 'repo.tuck-directory',
        category: 'repo',
        status: 'pass',
        message: `Tuck directory exists: ${collapsePath(context.tuckDir)}`,
      };
    }

    if (context.hasTuckDir && !context.isTuckDirDirectory) {
      return {
        id: 'repo.tuck-directory',
        category: 'repo',
        status: 'fail',
        message: `Tuck path is not a directory: ${collapsePath(context.tuckDir)}`,
        fix: 'Remove or rename the conflicting file, then run `tuck init`',
      };
    }

    return {
      id: 'repo.tuck-directory',
      category: 'repo',
      status: 'fail',
      message: `Tuck directory missing: ${collapsePath(context.tuckDir)}`,
      fix: 'Run `tuck init` to initialize this machine',
    };
  },
};

const checkGitDirectory: DoctorCheck = {
  id: 'repo.git-directory',
  category: 'repo',
  run: async (context) => {
    if (!context.hasTuckDir) {
      return {
        id: 'repo.git-directory',
        category: 'repo',
        status: 'warn',
        message: 'Skipped git checks because tuck is not initialized',
      };
    }

    if (context.hasGitDir) {
      return {
        id: 'repo.git-directory',
        category: 'repo',
        status: 'pass',
        message: 'Git metadata is present in tuck directory',
      };
    }

    return {
      id: 'repo.git-directory',
      category: 'repo',
      status: 'fail',
      message: 'Missing .git directory under tuck repository',
      fix: 'Reinitialize with `tuck init` or restore the git metadata',
    };
  },
};

const checkGitStatusReadable: DoctorCheck = {
  id: 'repo.git-status',
  category: 'repo',
  run: async (context) => {
    if (!context.hasTuckDir || !context.hasGitDir) {
      return {
        id: 'repo.git-status',
        category: 'repo',
        status: 'warn',
        message: 'Skipped git status check because repository is unavailable',
      };
    }

    try {
      await getStatus(context.tuckDir);
      return {
        id: 'repo.git-status',
        category: 'repo',
        status: 'pass',
        message: 'Git status can be read successfully',
      };
    } catch (error) {
      return {
        id: 'repo.git-status',
        category: 'repo',
        status: 'fail',
        message: 'Failed to read git status',
        details: error instanceof Error ? error.message : String(error),
        fix: 'Run `git status` inside the tuck directory and resolve repository errors',
      };
    }
  },
};

const checkManifestLoadable: DoctorCheck = {
  id: 'repo.manifest-loadable',
  category: 'repo',
  run: async (context) => {
    if (!context.hasTuckDir) {
      return {
        id: 'repo.manifest-loadable',
        category: 'repo',
        status: 'warn',
        message: 'Skipped manifest load check because tuck is not initialized',
      };
    }

    if (!context.hasManifestFile) {
      return {
        id: 'repo.manifest-loadable',
        category: 'repo',
        status: 'fail',
        message: `Manifest missing: ${collapsePath(context.manifestPath)}`,
        fix: 'Recreate with `tuck init` or restore `.tuckmanifest.json` from backup',
      };
    }

    if (context.manifest) {
      return {
        id: 'repo.manifest-loadable',
        category: 'repo',
        status: 'pass',
        message: 'Manifest is present and valid',
      };
    }

    return {
      id: 'repo.manifest-loadable',
      category: 'repo',
      status: 'fail',
      message: 'Manifest exists but failed to parse',
      details: context.manifestLoadError,
      fix: 'Repair `.tuckmanifest.json` using a valid schema or restore from git',
    };
  },
};

const checkConfigLoadable: DoctorCheck = {
  id: 'repo.config-loadable',
  category: 'repo',
  run: async (context) => {
    if (!context.hasTuckDir) {
      return {
        id: 'repo.config-loadable',
        category: 'repo',
        status: 'warn',
        message: 'Skipped config load check because tuck is not initialized',
      };
    }

    if (!context.hasConfigFile) {
      return {
        id: 'repo.config-loadable',
        category: 'repo',
        status: 'warn',
        message: `Config file missing: ${collapsePath(context.configPath)} (defaults will be used)`,
        fix: 'Run `tuck config reset` to generate a config file with defaults',
      };
    }

    if (context.config) {
      return {
        id: 'repo.config-loadable',
        category: 'repo',
        status: 'pass',
        message: 'Configuration is present and valid',
      };
    }

    return {
      id: 'repo.config-loadable',
      category: 'repo',
      status: 'fail',
      message: 'Configuration exists but failed to parse',
      details: context.configLoadError,
      fix: 'Repair `.tuckrc.json` or run `tuck config reset`',
    };
  },
};

const checkManifestPathSafety: DoctorCheck = {
  id: 'manifest.path-safety',
  category: 'manifest',
  run: async (context) => {
    if (!context.manifest) {
      return {
        id: 'manifest.path-safety',
        category: 'manifest',
        status: 'warn',
        message: 'Skipped manifest path checks because manifest is unavailable',
      };
    }

    const violations: string[] = [];
    for (const [id, file] of Object.entries(context.manifest.files)) {
      try {
        validateSafeSourcePath(file.source);
      } catch (error) {
        violations.push(`${id}: unsafe source ${file.source} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }

      try {
        validateSafeManifestDestination(file.destination);
      } catch (error) {
        violations.push(
          `${id}: unsafe destination ${file.destination} (${error instanceof Error ? error.message : String(error)})`
        );
        continue;
      }

      try {
        validatePathWithinRoot(join(context.tuckDir, file.destination), context.tuckDir, 'manifest destination');
      } catch (error) {
        violations.push(
          `${id}: destination escapes tuck dir (${error instanceof Error ? error.message : String(error)})`
        );
      }
    }

    if (violations.length === 0) {
      return {
        id: 'manifest.path-safety',
        category: 'manifest',
        status: 'pass',
        message: 'All manifest paths are safe',
      };
    }

    return {
      id: 'manifest.path-safety',
      category: 'manifest',
      status: 'fail',
      message: `Detected ${violations.length} unsafe manifest path entr${violations.length === 1 ? 'y' : 'ies'}`,
      details: violations.slice(0, 3).join('; '),
      fix: 'Replace unsafe paths with home-scoped sources and `files/...` destinations',
    };
  },
};

const checkManifestDuplicateSources: DoctorCheck = {
  id: 'manifest.duplicate-sources',
  category: 'manifest',
  run: async (context) => {
    if (!context.manifest) {
      return {
        id: 'manifest.duplicate-sources',
        category: 'manifest',
        status: 'warn',
        message: 'Skipped duplicate source checks because manifest is unavailable',
      };
    }

    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const file of Object.values(context.manifest.files)) {
      const normalized = expandPath(file.source);
      if (seen.has(normalized)) {
        duplicates.push(file.source);
      }
      seen.add(normalized);
    }

    if (duplicates.length === 0) {
      return {
        id: 'manifest.duplicate-sources',
        category: 'manifest',
        status: 'pass',
        message: 'No duplicate source paths detected',
      };
    }

    return {
      id: 'manifest.duplicate-sources',
      category: 'manifest',
      status: 'fail',
      message: `Detected duplicate source paths (${duplicates.length})`,
      details: duplicates.slice(0, 5).join(', '),
      fix: 'Keep each source path tracked exactly once in `.tuckmanifest.json`',
    };
  },
};

const checkManifestDuplicateDestinations: DoctorCheck = {
  id: 'manifest.duplicate-destinations',
  category: 'manifest',
  run: async (context) => {
    if (!context.manifest) {
      return {
        id: 'manifest.duplicate-destinations',
        category: 'manifest',
        status: 'warn',
        message: 'Skipped duplicate destination checks because manifest is unavailable',
      };
    }

    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const file of Object.values(context.manifest.files)) {
      const normalized = file.destination.replace(/\\/g, '/');
      if (seen.has(normalized)) {
        duplicates.push(file.destination);
      }
      seen.add(normalized);
    }

    if (duplicates.length === 0) {
      return {
        id: 'manifest.duplicate-destinations',
        category: 'manifest',
        status: 'pass',
        message: 'No duplicate repository destinations detected',
      };
    }

    return {
      id: 'manifest.duplicate-destinations',
      category: 'manifest',
      status: 'fail',
      message: `Detected duplicate destinations (${duplicates.length})`,
      details: duplicates.slice(0, 5).join(', '),
      fix: 'Assign each tracked file a unique destination under `files/`',
    };
  },
};

const checkSecretScanning: DoctorCheck = {
  id: 'security.secret-scanning',
  category: 'security',
  run: async (context) => {
    if (!context.config) {
      return {
        id: 'security.secret-scanning',
        category: 'security',
        status: 'warn',
        message: 'Skipped secret scanning checks because config is unavailable',
      };
    }

    if (!context.config.security.scanSecrets) {
      return {
        id: 'security.secret-scanning',
        category: 'security',
        status: 'warn',
        message: 'Secret scanning is disabled',
        fix: 'Enable with `tuck config set security.scanSecrets true`',
      };
    }

    return {
      id: 'security.secret-scanning',
      category: 'security',
      status: 'pass',
      message: 'Secret scanning is enabled',
    };
  },
};

const checkBackupOnRestore: DoctorCheck = {
  id: 'security.backup-on-restore',
  category: 'security',
  run: async (context) => {
    if (!context.config) {
      return {
        id: 'security.backup-on-restore',
        category: 'security',
        status: 'warn',
        message: 'Skipped backup checks because config is unavailable',
      };
    }

    if (!context.config.files.backupOnRestore) {
      return {
        id: 'security.backup-on-restore',
        category: 'security',
        status: 'warn',
        message: 'Backup before restore is disabled',
        fix: 'Enable with `tuck config set files.backupOnRestore true`',
      };
    }

    return {
      id: 'security.backup-on-restore',
      category: 'security',
      status: 'pass',
      message: 'Backup before restore is enabled',
    };
  },
};

const checkHooksSafety: DoctorCheck = {
  id: 'hooks.commands',
  category: 'hooks',
  run: async (context) => {
    if (!context.config) {
      return {
        id: 'hooks.commands',
        category: 'hooks',
        status: 'warn',
        message: 'Skipped hook checks because config is unavailable',
      };
    }

    const hooks = context.config.hooks;
    const configuredHooks = Object.entries(hooks).filter(
      ([, command]) => typeof command === 'string' && command.trim().length > 0
    );

    if (configuredHooks.length === 0) {
      return {
        id: 'hooks.commands',
        category: 'hooks',
        status: 'pass',
        message: 'No lifecycle hooks configured',
      };
    }

    const suspiciousPatterns = [/&&/u, /\|\|/u, /;{1}/u, /\$\(/u, /`/u];
    const suspicious = configuredHooks.filter(([, command]) =>
      suspiciousPatterns.some((pattern) => pattern.test(command as string))
    );

    if (suspicious.length > 0) {
      return {
        id: 'hooks.commands',
        category: 'hooks',
        status: 'warn',
        message: `Detected ${suspicious.length} hook command${suspicious.length === 1 ? '' : 's'} with complex shell syntax`,
        details: suspicious.map(([name]) => name).join(', '),
        fix: 'Review hook commands and keep them minimal and auditable',
      };
    }

    return {
      id: 'hooks.commands',
      category: 'hooks',
      status: 'pass',
      message: `Validated ${configuredHooks.length} hook command${configuredHooks.length === 1 ? '' : 's'}`,
    };
  },
};

const doctorChecks: DoctorCheck[] = [
  checkNodeVersion,
  checkHomeDirectory,
  checkTuckDirectory,
  checkGitDirectory,
  checkGitStatusReadable,
  checkManifestLoadable,
  checkConfigLoadable,
  checkManifestPathSafety,
  checkManifestDuplicateSources,
  checkManifestDuplicateDestinations,
  checkSecretScanning,
  checkBackupOnRestore,
  checkHooksSafety,
];

const buildDoctorSummary = (checks: DoctorCheckResult[]): DoctorSummary => {
  return checks.reduce<DoctorSummary>(
    (summary, check) => {
      if (check.status === 'pass') {
        summary.passed += 1;
      } else if (check.status === 'warn') {
        summary.warnings += 1;
      } else {
        summary.failed += 1;
      }
      return summary;
    },
    {
      passed: 0,
      warnings: 0,
      failed: 0,
    }
  );
};

const buildDoctorContext = async (): Promise<DoctorContext> => {
  const tuckDir = getTuckDir();
  const manifestPath = getManifestPath(tuckDir);
  const configPath = getConfigPath(tuckDir);
  const hasTuckDir = await pathExists(tuckDir);
  const isTuckDirDirectory = hasTuckDir ? await isDirectory(tuckDir) : false;
  const hasGitDir = await pathExists(join(tuckDir, '.git'));
  const hasManifestFile = await pathExists(manifestPath);
  const hasConfigFile = await pathExists(configPath);

  const context: DoctorContext = {
    tuckDir,
    manifestPath,
    configPath,
    hasTuckDir,
    isTuckDirDirectory,
    hasGitDir,
    hasManifestFile,
    hasConfigFile,
  };

  if (hasManifestFile) {
    try {
      context.manifest = await loadManifest(tuckDir);
    } catch (error) {
      context.manifestLoadError = error instanceof Error ? error.message : String(error);
    }
  }

  if (hasConfigFile) {
    try {
      context.config = await loadConfig(tuckDir);
    } catch (error) {
      context.configLoadError = error instanceof Error ? error.message : String(error);
    }
  }

  return context;
};

const normalizeCategory = (category?: string): DoctorCategory | undefined => {
  if (!category) {
    return undefined;
  }

  if ((DOCTOR_CATEGORIES as readonly string[]).includes(category)) {
    return category as DoctorCategory;
  }

  return undefined;
};

export const runDoctorChecks = async (options: DoctorRunOptions = {}): Promise<DoctorReport> => {
  const context = await buildDoctorContext();
  const category = normalizeCategory(options.category);
  const selectedChecks = category
    ? doctorChecks.filter((check) => check.category === category)
    : doctorChecks;

  const checks: DoctorCheckResult[] = [];
  for (const check of selectedChecks) {
    try {
      checks.push(await check.run(context));
    } catch (error) {
      checks.push({
        id: check.id,
        category: check.category,
        status: 'fail',
        message: 'Doctor check crashed unexpectedly',
        details: error instanceof Error ? error.message : String(error),
        fix: 'Run with DEBUG=1 and inspect the stack trace',
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    tuckDir: context.tuckDir,
    summary: buildDoctorSummary(checks),
    checks,
  };
};

export const getDoctorExitCode = (report: DoctorReport, strict = false): number => {
  if (report.summary.failed > 0) {
    return 1;
  }

  if (strict && report.summary.warnings > 0) {
    return 2;
  }

  return 0;
};
