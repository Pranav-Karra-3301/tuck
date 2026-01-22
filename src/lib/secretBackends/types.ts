/**
 * Secret backend types and interfaces for tuck
 *
 * Defines the contract for secret backends (1Password, Bitwarden, pass, local)
 * that can be used to resolve placeholders in dotfiles.
 */

// ============================================================================
// Backend Names
// ============================================================================

/** Supported secret backend names */
export type BackendName = 'local' | '1password' | 'bitwarden' | 'pass';

/** Backend names as array for iteration */
export const BACKEND_NAMES: readonly BackendName[] = ['local', '1password', 'bitwarden', 'pass'] as const;

// ============================================================================
// Secret References
// ============================================================================

/** Reference to a secret that needs to be resolved */
export interface SecretReference {
  /** Placeholder name (e.g., GITHUB_TOKEN) */
  name: string;
  /** Backend-specific path (e.g., op://vault/item/field) */
  backendPath?: string;
}

/** Information about a secret (without the value) */
export interface SecretInfo {
  /** Secret name/identifier */
  name: string;
  /** Backend-specific path */
  path: string;
  /** When the secret was last modified (if available) */
  lastModified?: Date;
}

/** A resolved secret with its value */
export interface ResolvedSecret {
  /** Placeholder name */
  name: string;
  /** The actual secret value */
  value: string;
  /** Which backend resolved this secret */
  backend: BackendName;
  /** Whether this was served from cache */
  cached: boolean;
}

// ============================================================================
// Backend Interface
// ============================================================================

/**
 * Interface that all secret backends must implement.
 *
 * Backends are responsible for fetching secrets from their respective
 * password managers (1Password, Bitwarden, pass, or local file).
 */
export interface SecretBackend {
  /** Backend identifier */
  readonly name: BackendName;

  /** Human-readable name for display */
  readonly displayName: string;

  /** CLI tool name (null for local backend) */
  readonly cliName: string | null;

  // ========== Availability & Authentication ==========

  /**
   * Check if the backend is available (CLI installed, etc.)
   */
  isAvailable(): Promise<boolean>;

  /**
   * Check if the user is authenticated with this backend
   */
  isAuthenticated(): Promise<boolean>;

  /**
   * Authenticate with the backend (interactive flow)
   * @throws BackendAuthenticationError if authentication fails
   */
  authenticate(): Promise<void>;

  /**
   * Lock/logout from the backend (cleanup session)
   */
  lock(): Promise<void>;

  // ========== Secret Operations ==========

  /**
   * Get a secret value by reference
   * @param ref - The secret reference (name and optional backend path)
   * @returns The secret value, or null if not found
   * @throws SecretBackendError on backend communication errors
   */
  getSecret(ref: SecretReference): Promise<string | null>;

  /**
   * List available secrets (optional, not all backends support this)
   * @returns List of secret info objects
   */
  listSecrets?(): Promise<SecretInfo[]>;

  // ========== Setup & Help ==========

  /**
   * Get human-readable setup instructions for this backend
   */
  getSetupInstructions(): string;
}

// ============================================================================
// Backend Configuration
// ============================================================================

/** 1Password backend configuration */
export interface OnePasswordConfig {
  /** Default vault to use when not specified in mapping */
  vault?: string;
  /** Use service account token (for CI/CD) */
  serviceAccount?: boolean;
  /** Cache timeout in seconds (0 = no cache) */
  cacheTimeout?: number;
}

/** Bitwarden backend configuration */
export interface BitwardenConfig {
  /** Server URL for self-hosted instances */
  serverUrl?: string;
  /** Auto-unlock timeout in seconds */
  unlockTimeout?: number;
  /** Cache timeout in seconds (0 = no cache) */
  cacheTimeout?: number;
}

/** Pass backend configuration */
export interface PassConfig {
  /** Path to password store (default: ~/.password-store) */
  storePath?: string;
  /** GPG key ID override */
  gpgId?: string;
}

/** All backend configurations */
export interface BackendsConfig {
  '1password'?: OnePasswordConfig;
  bitwarden?: BitwardenConfig;
  pass?: PassConfig;
}

// ============================================================================
// Resolver Types
// ============================================================================

/** Options for secret resolution */
export interface ResolveOptions {
  /** Skip cache and fetch fresh value */
  skipCache?: boolean;
  /** Specific backend to use (overrides config) */
  backend?: BackendName;
  /**
   * If true, fail immediately when authentication is required instead of
   * attempting interactive authentication. Useful for non-interactive contexts
   * like `tuck apply` where prompts are unexpected.
   */
  failOnAuthRequired?: boolean;
}

/** Result of a batch resolution operation */
export interface BatchResolveResult {
  /** Successfully resolved secrets */
  resolved: Map<string, ResolvedSecret>;
  /** Secrets that could not be resolved */
  unresolved: string[];
  /** Errors encountered during resolution */
  errors: Map<string, Error>;
}

// ============================================================================
// Cache Types
// ============================================================================

/** A cached secret entry */
export interface CachedSecret {
  /** The secret value */
  value: string;
  /** Which backend provided this value */
  backend: BackendName;
  /** When the value was cached */
  timestamp: number;
  /** When the cache entry expires */
  expiresAt: number;
}

/** Cache statistics */
export interface CacheStats {
  /** Number of entries in cache */
  size: number;
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
}
