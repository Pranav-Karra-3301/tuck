import chalk from 'chalk';

export class TuckError extends Error {
  constructor(
    message: string,
    public code: string,
    public suggestions?: string[]
  ) {
    super(message);
    this.name = 'TuckError';
  }
}

export class NotInitializedError extends TuckError {
  constructor() {
    super('Tuck is not initialized in this system', 'NOT_INITIALIZED', [
      'Run `tuck init` to get started',
    ]);
  }
}

export class AlreadyInitializedError extends TuckError {
  constructor(path: string) {
    super(`Tuck is already initialized at ${path}`, 'ALREADY_INITIALIZED', [
      'Use `tuck status` to see current state',
      `Remove ${path} to reinitialize`,
    ]);
  }
}

export class FileNotFoundError extends TuckError {
  constructor(path: string) {
    super(`File not found: ${path}`, 'FILE_NOT_FOUND', [
      'Check that the path is correct',
      'Use absolute paths or paths relative to home directory',
    ]);
  }
}

export class FileNotTrackedError extends TuckError {
  constructor(path: string) {
    super(`File is not tracked: ${path}`, 'FILE_NOT_TRACKED', [
      `Run \`tuck add ${path}\` to track this file`,
      'Run `tuck list` to see all tracked files',
    ]);
  }
}

export class FileAlreadyTrackedError extends TuckError {
  constructor(path: string) {
    super(`File is already tracked: ${path}`, 'FILE_ALREADY_TRACKED', [
      'Run `tuck sync` to update it',
      `Run \`tuck remove ${path}\` to untrack`,
    ]);
  }
}

export class GitError extends TuckError {
  constructor(message: string, gitError?: string) {
    super(`Git operation failed: ${message}`, 'GIT_ERROR', gitError ? [gitError] : undefined);
  }
}

export class ConfigError extends TuckError {
  constructor(message: string) {
    super(`Configuration error: ${message}`, 'CONFIG_ERROR', [
      'Run `tuck config edit` to fix configuration',
      'Run `tuck config reset` to restore defaults',
    ]);
  }
}

export class ManifestError extends TuckError {
  constructor(message: string) {
    super(`Manifest error: ${message}`, 'MANIFEST_ERROR', [
      'The manifest file may be corrupted',
      'Run `tuck init --from <remote>` to restore from remote',
    ]);
  }
}

export class PermissionError extends TuckError {
  constructor(path: string, operation: string) {
    super(`Permission denied: cannot ${operation} ${path}`, 'PERMISSION_ERROR', [
      'Check file permissions',
      'Try running with appropriate permissions',
    ]);
  }
}

export class GitHubCliError extends TuckError {
  constructor(message: string, suggestions?: string[]) {
    super(
      `GitHub CLI error: ${message}`,
      'GITHUB_CLI_ERROR',
      suggestions || ['Install GitHub CLI: https://cli.github.com/', 'Run `gh auth login` to authenticate']
    );
  }
}

export class BackupError extends TuckError {
  constructor(message: string, suggestions?: string[]) {
    super(`Backup error: ${message}`, 'BACKUP_ERROR', suggestions || ['Check available disk space']);
  }
}

export class SecretsDetectedError extends TuckError {
  constructor(count: number, files: string[]) {
    const fileList = files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '');
    
    // Tailor suggestions based on interactive vs CI/CD context
    const isInteractive = !!process.stdout.isTTY && process.env.CI !== 'true';
    const suggestions = isInteractive
      ? [
          'Review the detected secrets and choose how to proceed',
          'Use --force to bypass secret scanning (not recommended)',
          'Run `tuck secrets list` to see stored secrets',
          'Configure scanning with `tuck config set security.scanSecrets false`',
        ]
      : [
          'Review the detected secrets in your source and choose how to proceed before re-running in CI',
          'Use --force to bypass secret scanning (not recommended) if you are sure the secrets are safe to ignore',
          'If needed, run `tuck secrets list` in a local interactive environment to inspect stored secrets',
          'Configure scanning with `tuck config set security.scanSecrets false` if this check is not desired in CI',
        ];
    
    super(`Found ${count} potential secret(s) in: ${fileList}`, 'SECRETS_DETECTED', suggestions);
  }
}

export const handleError = (error: unknown): never => {
  if (error instanceof TuckError) {
    console.error(chalk.red('x'), error.message);
    if (error.suggestions && error.suggestions.length > 0) {
      console.error();
      console.error(chalk.dim('Suggestions:'));
      error.suggestions.forEach((s) => console.error(chalk.dim(`  → ${s}`)));
    }
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error(chalk.red('x'), 'An unexpected error occurred:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }

  console.error(chalk.red('x'), 'An unknown error occurred');
  process.exit(1);
};
