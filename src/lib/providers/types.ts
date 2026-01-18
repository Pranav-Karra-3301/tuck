/**
 * Git Provider Abstraction Types
 *
 * This module defines the interface for git providers (GitHub, GitLab, etc.)
 * allowing tuck to work with multiple remote hosting services.
 */

// ============================================================================
// Provider Types
// ============================================================================

/** Supported provider modes */
export type ProviderMode = 'github' | 'gitlab' | 'local' | 'custom';

/** User information from a provider */
export interface ProviderUser {
  /** Username/login identifier */
  login: string;
  /** Display name (may be null) */
  name: string | null;
  /** Email address (may be null) */
  email: string | null;
}

/** Repository information */
export interface ProviderRepo {
  /** Repository name (without owner) */
  name: string;
  /** Full name including owner (e.g., "user/repo") */
  fullName: string;
  /** Web URL for the repository */
  url: string;
  /** SSH clone URL */
  sshUrl: string;
  /** HTTPS clone URL */
  httpsUrl: string;
  /** Whether the repository is private */
  isPrivate: boolean;
}

/** Options for creating a new repository */
export interface CreateRepoOptions {
  /** Repository name */
  name: string;
  /** Repository description */
  description?: string;
  /** Whether to make the repository private (default: true) */
  isPrivate?: boolean;
}

/** Authentication status for a provider */
export interface AuthStatus {
  /** Whether the provider CLI is installed (if applicable) */
  cliInstalled: boolean;
  /** Whether the user is authenticated */
  authenticated: boolean;
  /** The authenticated user (if authenticated) */
  user?: ProviderUser;
  /** Provider-specific instance URL (for self-hosted) */
  instanceUrl?: string;
}

/** Detection result for a provider */
export interface ProviderDetection {
  /** Provider mode identifier */
  mode: ProviderMode;
  /** Human-readable provider name */
  displayName: string;
  /** Whether the provider is available (CLI installed, etc.) */
  available: boolean;
  /** Authentication status */
  authStatus: AuthStatus;
  /** Reason if not available */
  unavailableReason?: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Git Provider Interface
 *
 * Implementations of this interface provide a consistent API for
 * interacting with different git hosting services.
 */
export interface GitProvider {
  /** Provider mode identifier */
  readonly mode: ProviderMode;

  /** Human-readable provider name */
  readonly displayName: string;

  /** CLI command name (e.g., 'gh', 'glab') - null if no CLI */
  readonly cliName: string | null;

  /** Whether this provider requires a remote (local mode doesn't) */
  readonly requiresRemote: boolean;

  // -------------------------------------------------------------------------
  // Detection & Authentication
  // -------------------------------------------------------------------------

  /**
   * Check if the provider's CLI is installed
   * Returns true for providers without a CLI (local, custom)
   */
  isCliInstalled(): Promise<boolean>;

  /**
   * Check if the user is authenticated with the provider
   * Returns true for providers that don't require auth (local)
   */
  isAuthenticated(): Promise<boolean>;

  /**
   * Get the authenticated user's information
   * Returns null for providers without user accounts (local, custom)
   */
  getUser(): Promise<ProviderUser | null>;

  /**
   * Get full detection/authentication status
   */
  detect(): Promise<ProviderDetection>;

  // -------------------------------------------------------------------------
  // Repository Operations
  // -------------------------------------------------------------------------

  /**
   * Check if a repository exists
   * @param repoName Repository name or full name (owner/repo)
   */
  repoExists(repoName: string): Promise<boolean>;

  /**
   * Create a new repository
   * @param options Repository creation options
   * @returns The created repository info
   * @throws Error if creation fails or provider doesn't support creation
   */
  createRepo(options: CreateRepoOptions): Promise<ProviderRepo>;

  /**
   * Get information about a repository
   * @param repoName Repository name or full name
   */
  getRepoInfo(repoName: string): Promise<ProviderRepo | null>;

  /**
   * Clone a repository to a target directory
   * @param repoName Repository name or full name
   * @param targetDir Target directory path
   */
  cloneRepo(repoName: string, targetDir: string): Promise<void>;

  /**
   * Search for existing dotfiles repositories
   * @param username Optional username to search (defaults to authenticated user)
   * @returns Repository full name if found, null otherwise
   */
  findDotfilesRepo(username?: string): Promise<string | null>;

  // -------------------------------------------------------------------------
  // URL Utilities
  // -------------------------------------------------------------------------

  /**
   * Get the preferred clone URL for a repository
   * @param repo Repository info
   * @returns SSH or HTTPS URL based on user preference
   */
  getPreferredRepoUrl(repo: ProviderRepo): Promise<string>;

  /**
   * Validate a repository URL for this provider
   * @param url URL to validate
   * @returns true if the URL is valid for this provider
   */
  validateUrl(url: string): boolean;

  /**
   * Build a repository URL from components
   * @param username Owner/username
   * @param repoName Repository name
   * @param protocol SSH or HTTPS
   */
  buildRepoUrl(username: string, repoName: string, protocol: 'ssh' | 'https'): string;

  // -------------------------------------------------------------------------
  // Provider-specific Features
  // -------------------------------------------------------------------------

  /**
   * Get instructions for setting up this provider
   * Used when the provider isn't available or authenticated
   */
  getSetupInstructions(): string;

  /**
   * Get instructions for alternative authentication methods
   * (e.g., SSH keys, personal access tokens)
   */
  getAltAuthInstructions(): string;
}

// ============================================================================
// Remote Configuration
// ============================================================================

/** Remote configuration stored in .tuckrc.json */
export interface RemoteConfig {
  /** Provider mode */
  mode: ProviderMode;
  /** Custom remote URL (for custom mode) */
  url?: string;
  /** Provider instance URL (for self-hosted GitLab, etc.) */
  providerUrl?: string;
  /** Cached username from provider */
  username?: string;
  /** Repository name */
  repoName?: string;
}

// ============================================================================
// Provider Errors
// ============================================================================

/** Error thrown when a provider operation fails */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderMode,
    public readonly suggestions: string[] = []
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Error thrown when provider is not configured */
export class ProviderNotConfiguredError extends ProviderError {
  constructor(provider: ProviderMode) {
    super(`Provider "${provider}" is not configured`, provider, [
      'Run `tuck init` to set up your git provider',
      'Or use `tuck config remote` to change providers',
    ]);
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Error thrown when trying to use remote features in local mode */
export class LocalModeError extends ProviderError {
  constructor(operation: string) {
    super(`Cannot ${operation} in local-only mode`, 'local', [
      'Your tuck is configured for local-only storage (no remote sync)',
      'To enable remote sync, run: tuck config remote',
      'Or re-run: tuck init',
    ]);
    this.name = 'LocalModeError';
  }
}
