/**
 * Secret resolver for tuck
 *
 * Orchestrates secret resolution across multiple backends (local, 1Password,
 * Bitwarden, pass) with caching and proper error handling.
 */

import type {
  BackendName,
  SecretBackend,
  SecretReference,
  ResolvedSecret,
  ResolveOptions,
  BatchResolveResult,
} from './types.js';
import type { SecurityConfig } from '../../schemas/secrets.schema.js';
import { LocalBackend } from './local.js';
import { OnePasswordBackend } from './onepassword.js';
import { BitwardenBackend } from './bitwarden.js';
import { PassBackend } from './pass.js';
import { SecretCache, getGlobalCache } from './cache.js';
import { getBackendPath, listMappings } from './mappings.js';
import { BackendNotAvailableError, BackendAuthenticationError, UnresolvedSecretsError } from '../../errors.js';

/**
 * SecretResolver manages secret resolution across multiple backends.
 *
 * Features:
 * - Multi-backend support (local, 1Password, Bitwarden, pass)
 * - Caching for performance
 * - Mapping-based resolution
 * - Auto-detection of available backends
 */
export class SecretResolver {
  private backends: Map<BackendName, SecretBackend>;
  private cache: SecretCache;
  private primaryBackend: BackendName;
  private useCache: boolean;

  /**
   * Create a new SecretResolver
   * @param tuckDir - The tuck directory path
   * @param config - Security configuration
   */
  constructor(
    private tuckDir: string,
    private config: SecurityConfig
  ) {
    // Initialize backends
    this.backends = new Map<BackendName, SecretBackend>();
    this.backends.set('local', new LocalBackend(tuckDir));
    this.backends.set('1password', new OnePasswordBackend(config.backends?.['1password']));
    this.backends.set('bitwarden', new BitwardenBackend(config.backends?.bitwarden));
    this.backends.set('pass', new PassBackend(config.backends?.pass));

    // Set up caching
    this.useCache = config.cacheSecrets !== false;
    this.cache = getGlobalCache();

    // Determine primary backend
    const configured = config.secretBackend || 'local';
    this.primaryBackend = configured === 'auto' ? 'local' : (configured as BackendName);
  }

  /**
   * Get a specific backend by name
   */
  getBackend(name: BackendName): SecretBackend | undefined {
    return this.backends.get(name);
  }

  /**
   * Get the primary backend
   */
  getPrimaryBackend(): SecretBackend {
    const backend = this.backends.get(this.primaryBackend);
    if (!backend) {
      throw new BackendNotAvailableError(this.primaryBackend, 'Primary backend is not configured');
    }
    return backend;
  }

  /**
   * Get the primary backend name
   */
  getPrimaryBackendName(): BackendName {
    return this.primaryBackend;
  }

  /**
   * Check if a backend is available
   */
  async isBackendAvailable(name: BackendName): Promise<boolean> {
    const backend = this.backends.get(name);
    if (!backend) return false;
    return backend.isAvailable();
  }

  /**
   * Check if a backend is authenticated
   */
  async isBackendAuthenticated(name: BackendName): Promise<boolean> {
    const backend = this.backends.get(name);
    if (!backend) return false;
    return backend.isAuthenticated();
  }

  /**
   * Authenticate with a backend
   */
  async authenticateBackend(name: BackendName): Promise<void> {
    const backend = this.backends.get(name);
    if (!backend) {
      throw new BackendNotAvailableError(name, 'Unknown backend');
    }
    await backend.authenticate();
  }

  /**
   * Get all available backends
   */
  async getAvailableBackends(): Promise<BackendName[]> {
    const available: BackendName[] = [];
    for (const [name, backend] of this.backends.entries()) {
      if (await backend.isAvailable()) {
        available.push(name);
      }
    }
    return available;
  }

  /**
   * Auto-detect the best backend to use
   * Returns the first available and authenticated backend
   */
  async autoDetectBackend(): Promise<BackendName> {
    // Priority order: check environment variables first
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
      const op = this.backends.get('1password');
      if (op && (await op.isAvailable()) && (await op.isAuthenticated())) {
        return '1password';
      }
    }

    if (process.env.BW_SESSION) {
      const bw = this.backends.get('bitwarden');
      if (bw && (await bw.isAvailable()) && (await bw.isAuthenticated())) {
        return 'bitwarden';
      }
    }

    // Check each backend in order
    const order: BackendName[] = ['1password', 'bitwarden', 'pass', 'local'];
    for (const name of order) {
      const backend = this.backends.get(name);
      if (backend && (await backend.isAvailable()) && (await backend.isAuthenticated())) {
        return name;
      }
    }

    // Fallback to local (always available)
    return 'local';
  }

  /**
   * Resolve a single secret
   * @param name - The placeholder name
   * @param options - Resolution options
   */
  async resolveSecret(name: string, options?: ResolveOptions): Promise<ResolvedSecret | null> {
    // Check cache first (unless skipped)
    if (this.useCache && !options?.skipCache) {
      const cached = this.cache.get(name);
      if (cached) {
        return {
          name,
          value: cached.value,
          backend: cached.backend,
          cached: true,
        };
      }
    }

    // Determine which backend to use
    const backendName = options?.backend || this.primaryBackend;
    const backend = this.backends.get(backendName);

    if (!backend) {
      throw new BackendNotAvailableError(backendName, 'Unknown backend');
    }

    // Check if backend is available
    if (!(await backend.isAvailable())) {
      throw new BackendNotAvailableError(backendName, 'CLI not installed');
    }

    // Check if backend is authenticated
    if (!(await backend.isAuthenticated())) {
      // In non-interactive mode, fail immediately instead of attempting auth
      if (options?.failOnAuthRequired) {
        throw new BackendAuthenticationError(backendName);
      }
      await backend.authenticate();
    }

    // Get the backend-specific path from mappings
    const backendPath = await getBackendPath(
      this.tuckDir,
      name,
      backendName,
      this.config.secretMappings
    );

    // Create the reference
    const ref: SecretReference = {
      name,
      backendPath: backendPath || undefined,
    };

    // Try to get the secret
    const value = await backend.getSecret(ref);

    if (value === null) {
      return null;
    }

    // Cache the result
    if (this.useCache) {
      this.cache.set(name, value, backendName);
    }

    return {
      name,
      value,
      backend: backendName,
      cached: false,
    };
  }

  /**
   * Resolve multiple secrets
   * @param names - Array of placeholder names
   * @param options - Resolution options
   */
  async resolveAll(names: string[], options?: ResolveOptions): Promise<BatchResolveResult> {
    const resolved = new Map<string, ResolvedSecret>();
    const unresolved: string[] = [];
    const errors = new Map<string, Error>();

    for (const name of names) {
      try {
        const secret = await this.resolveSecret(name, options);
        if (secret) {
          resolved.set(name, secret);
        } else {
          unresolved.push(name);
        }
      } catch (error) {
        errors.set(name, error instanceof Error ? error : new Error(String(error)));
        unresolved.push(name);
      }
    }

    return { resolved, unresolved, errors };
  }

  /**
   * Resolve all secrets and throw if any are unresolved
   * @param names - Array of placeholder names
   * @param options - Resolution options
   */
  async resolveAllOrThrow(
    names: string[],
    options?: ResolveOptions
  ): Promise<Map<string, ResolvedSecret>> {
    const result = await this.resolveAll(names, options);

    if (result.unresolved.length > 0) {
      throw new UnresolvedSecretsError(result.unresolved, this.primaryBackend);
    }

    return result.resolved;
  }

  /**
   * Get secrets as a simple name->value map (for restoration)
   * @param names - Array of placeholder names
   * @param options - Resolution options
   */
  async resolveToMap(
    names: string[],
    options?: ResolveOptions
  ): Promise<Record<string, string>> {
    const result = await this.resolveAll(names, options);
    const map: Record<string, string> = {};

    for (const [name, secret] of result.resolved.entries()) {
      map[name] = secret.value;
    }

    return map;
  }

  /**
   * Invalidate cached secrets
   * @param name - Optional specific secret to invalidate
   */
  invalidateCache(name?: string): void {
    this.cache.invalidate(name);
  }

  /**
   * Lock/cleanup all backends
   */
  async lockAll(): Promise<void> {
    for (const backend of this.backends.values()) {
      try {
        await backend.lock();
      } catch {
        // Ignore errors during cleanup
      }
    }
  }

  /**
   * Get status information for all backends
   */
  async getBackendStatuses(): Promise<
    Array<{
      name: BackendName;
      displayName: string;
      available: boolean;
      authenticated: boolean;
      isPrimary: boolean;
    }>
  > {
    const statuses = [];

    for (const [name, backend] of this.backends.entries()) {
      const available = await backend.isAvailable();
      const authenticated = available ? await backend.isAuthenticated() : false;

      statuses.push({
        name,
        displayName: backend.displayName,
        available,
        authenticated,
        isPrimary: name === this.primaryBackend,
      });
    }

    return statuses;
  }

  /**
   * Get all mappings
   */
  async getMappings(): Promise<Record<string, Record<string, string | boolean | undefined>>> {
    return listMappings(this.tuckDir, this.config.secretMappings);
  }
}

/**
 * Create a SecretResolver from tuck configuration
 * @param tuckDir - The tuck directory path
 * @param config - Security configuration
 */
export const createResolver = (tuckDir: string, config: SecurityConfig): SecretResolver => {
  return new SecretResolver(tuckDir, config);
};
