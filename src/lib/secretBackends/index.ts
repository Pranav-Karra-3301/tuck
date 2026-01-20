/**
 * Secret backends module for tuck
 *
 * Provides a unified interface for fetching secrets from various
 * password managers (1Password, Bitwarden, pass) or the local store.
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  BackendName,
  SecretBackend,
  SecretReference,
  SecretInfo,
  ResolvedSecret,
  OnePasswordConfig,
  BitwardenConfig,
  PassConfig,
  BackendsConfig,
  ResolveOptions,
  BatchResolveResult,
  CachedSecret,
  CacheStats,
} from './types.js';

export { BACKEND_NAMES } from './types.js';

// ============================================================================
// Backend Implementations
// ============================================================================

export { LocalBackend } from './local.js';
export { OnePasswordBackend } from './onepassword.js';
export { BitwardenBackend } from './bitwarden.js';
export { PassBackend } from './pass.js';

// ============================================================================
// Resolver
// ============================================================================

export { SecretResolver, createResolver } from './resolver.js';

// ============================================================================
// Cache
// ============================================================================

export { SecretCache, getGlobalCache, clearGlobalCache, resetGlobalCache } from './cache.js';

// ============================================================================
// Mappings
// ============================================================================

export {
  getMappingsPath,
  loadMappings,
  saveMappings,
  getMapping,
  setMapping,
  removeMapping,
  listMappings,
  getBackendPath,
  hasBackendMapping,
  getSecretsForBackend,
  importMappings,
} from './mappings.js';
