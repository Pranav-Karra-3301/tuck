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
      suggestions || [
        'Install GitHub CLI: https://cli.github.com/',
        'Run `gh auth login` to authenticate',
      ]
    );
  }
}

export class BackupError extends TuckError {
  constructor(message: string, suggestions?: string[]) {
    super(
      `Backup error: ${message}`,
      'BACKUP_ERROR',
      suggestions || ['Check available disk space']
    );
  }
}

export class EncryptionError extends TuckError {
  constructor(message: string, suggestions?: string[]) {
    super(
      `Encryption error: ${message}`,
      'ENCRYPTION_ERROR',
      suggestions || [
        'Check your encryption password',
        'Run `tuck encryption setup` to configure encryption',
      ]
    );
  }
}

export class DecryptionError extends TuckError {
  constructor(message: string, suggestions?: string[]) {
    super(
      `Decryption error: ${message}`,
      'DECRYPTION_ERROR',
      suggestions || [
        'Verify you are using the correct password',
        'The encrypted data may be corrupted',
      ]
    );
  }
}

export class SecretsDetectedError extends TuckError {
  constructor(count: number, files: string[]) {
    const fileList =
      files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '');

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

// ============================================================================
// Password Manager Backend Errors
// ============================================================================

export class SecretBackendError extends TuckError {
  constructor(backend: string, message: string, suggestions?: string[]) {
    super(
      `${backend} error: ${message}`,
      'SECRET_BACKEND_ERROR',
      suggestions || [
        `Check if ${backend} CLI is installed and authenticated`,
        'Run `tuck secrets backend status` to diagnose',
      ]
    );
  }
}

export class SecretNotFoundError extends TuckError {
  constructor(name: string, backend: string) {
    super(`Secret "${name}" not found in ${backend}`, 'SECRET_NOT_FOUND', [
      'Check the mapping in secrets.mappings.json',
      `Run \`tuck secrets map ${name} --${backend} <path>\` to configure`,
      'Run `tuck secrets list` to see available secrets',
    ]);
  }
}

export class BackendNotAvailableError extends TuckError {
  constructor(backend: string, reason: string) {
    const installHints: Record<string, string> = {
      '1password': 'Install from: https://1password.com/downloads/command-line/',
      bitwarden: 'Install from: https://bitwarden.com/help/cli/',
      pass: 'Install from: https://www.passwordstore.org/',
    };

    super(`Backend "${backend}" is not available: ${reason}`, 'BACKEND_NOT_AVAILABLE', [
      installHints[backend] || `Install the ${backend} CLI`,
      'Run `tuck secrets backend list` to see available backends',
    ]);
  }
}

export class BackendAuthenticationError extends TuckError {
  constructor(backend: string) {
    const authHints: Record<string, string[]> = {
      '1password': ['Run `op signin` to authenticate', 'Or set OP_SERVICE_ACCOUNT_TOKEN for CI/CD'],
      bitwarden: ['Run `bw login` then `bw unlock`', 'Or set BW_SESSION environment variable'],
      pass: ['Ensure GPG key is available', 'Run `gpg --list-keys` to verify'],
    };

    super(
      `Not authenticated with ${backend}`,
      'BACKEND_AUTH_ERROR',
      authHints[backend] || [`Run the ${backend} authentication command`]
    );
  }
}

export class UnresolvedSecretsError extends TuckError {
  constructor(secrets: string[], backend: string) {
    const secretList =
      secrets.slice(0, 5).join(', ') +
      (secrets.length > 5 ? ` and ${secrets.length - 5} more` : '');

    super(`Could not resolve ${secrets.length} secret(s): ${secretList}`, 'UNRESOLVED_SECRETS', [
      `Ensure the secrets are configured in ${backend}`,
      'Run `tuck secrets mappings` to check mappings',
      'Run `tuck secrets test` to diagnose backend connectivity',
    ]);
  }
}

// ============================================================================
// User Action and Input Errors
// ============================================================================

export class OperationCancelledError extends TuckError {
  constructor(operation?: string) {
    super(
      operation ? `Operation cancelled: ${operation}` : 'Operation cancelled',
      'OPERATION_CANCELLED',
      ['Run the command again when ready']
    );
  }
}

export class PrivateKeyError extends TuckError {
  constructor(path: string) {
    super(`Cannot track private key: ${path}`, 'PRIVATE_KEY_ERROR', [
      'Private keys should NEVER be committed to a repository',
      'Use a secure password manager to backup SSH keys',
      'Track the .pub file instead if you need the public key',
    ]);
  }
}

export class RepositoryNotFoundError extends TuckError {
  constructor(source: string) {
    super(`Could not find a dotfiles repository for "${source}"`, 'REPOSITORY_NOT_FOUND', [
      'Try specifying the full repository name (e.g., username/dotfiles)',
      'Verify the repository exists and is accessible',
      'Check your authentication with `gh auth status`',
    ]);
  }
}

export class InvalidManifestError extends TuckError {
  constructor(reason?: string) {
    super(
      reason ? `Invalid manifest: ${reason}` : 'No tuck manifest found in repository',
      'INVALID_MANIFEST',
      [
        'This repository may not be managed by tuck',
        'Look for a .tuckmanifest.json file',
        'Initialize with `tuck init` to create a new manifest',
      ]
    );
  }
}

export class PathTraversalError extends TuckError {
  constructor(path: string, reason?: string) {
    super(
      `Unsafe path detected: ${path}${reason ? ` - ${reason}` : ''}`,
      'PATH_TRAVERSAL_ERROR',
      [
        'Paths must be within your home directory',
        'Path traversal (..) is not allowed',
        'Use absolute paths starting with ~/ or $HOME/',
      ]
    );
  }
}

export class SecretsStoreError extends TuckError {
  constructor(message: string, suggestions?: string[]) {
    super(
      `Secrets store error: ${message}`,
      'SECRETS_STORE_ERROR',
      suggestions || [
        'Check file permissions on ~/.tuck/secrets.local.json',
        'Run `tuck secrets list` to verify the secrets store',
      ]
    );
  }
}

export class ScanLimitError extends TuckError {
  constructor(fileCount: number, maxFiles: number) {
    super(`Too many files to scan (${fileCount} > ${maxFiles})`, 'SCAN_LIMIT_ERROR', [
      'Scan in smaller batches',
      'Use --exclude patterns to reduce scan scope',
      'Add large directories to .tuckignore',
    ]);
  }
}

export class ValidationError extends TuckError {
  constructor(field: string, message: string) {
    super(`Invalid ${field}: ${message}`, 'VALIDATION_ERROR', [
      'Check your input and try again',
    ]);
  }
}

export class KeystoreError extends TuckError {
  constructor(keystore: string, message: string, suggestions?: string[]) {
    super(`${keystore} error: ${message}`, 'KEYSTORE_ERROR', suggestions || [
      'Check your system keychain/credential manager is accessible',
      'Try running without encryption or use the fallback keystore',
    ]);
  }
}

// ============================================================================
// Error Handler
// ============================================================================

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
