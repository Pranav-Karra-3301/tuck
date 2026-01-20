/**
 * Zod schemas for secret scanning configuration
 */

import { z } from 'zod';

// ============================================================================
// Secret Pattern Schemas
// ============================================================================

/**
 * Schema for custom secret patterns defined by users
 */
export const customPatternSchema = z.object({
  name: z.string().optional(),
  pattern: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  flags: z.string().optional().default('g'),
});

// ============================================================================
// Secret Backend Configuration Schemas
// ============================================================================

/** Supported secret backend names */
export const backendNameSchema = z.enum(['local', '1password', 'bitwarden', 'pass', 'auto']);

/** 1Password backend configuration */
export const onePasswordConfigSchema = z.object({
  /** Default vault to use when not specified in mapping */
  vault: z.string().optional(),
  /** Use service account token (for CI/CD) */
  serviceAccount: z.boolean().default(false),
  /** Cache timeout in seconds (0 = no cache) */
  cacheTimeout: z.number().default(300),
});

/** Bitwarden backend configuration */
export const bitwardenConfigSchema = z.object({
  /** Server URL for self-hosted instances */
  serverUrl: z.string().optional(),
  /** Auto-unlock timeout in seconds */
  unlockTimeout: z.number().default(900),
  /** Cache timeout in seconds (0 = no cache) */
  cacheTimeout: z.number().default(300),
});

/** Pass backend configuration */
export const passConfigSchema = z.object({
  /** Path to password store (default: ~/.password-store) */
  storePath: z.string().default('~/.password-store'),
  /** GPG key ID override */
  gpgId: z.string().optional(),
});

/** All backend configurations */
export const backendsConfigSchema = z.object({
  '1password': onePasswordConfigSchema.optional(),
  bitwarden: bitwardenConfigSchema.optional(),
  pass: passConfigSchema.optional(),
});

/**
 * Schema for security configuration
 */
export const securityConfigSchema = z
  .object({
    // Enable/disable secret scanning
    scanSecrets: z.boolean().default(true),

    // Block operations when secrets are detected (vs just warn)
    blockOnSecrets: z.boolean().default(true),

    // Minimum severity level to report
    minSeverity: z.enum(['critical', 'high', 'medium', 'low']).default('high'),

    // Scanner to use: 'builtin' or external tools
    scanner: z.enum(['builtin', 'gitleaks', 'trufflehog']).default('builtin'),

    // Path to gitleaks binary (if using gitleaks scanner)
    gitleaksPath: z.string().optional(),

    // Path to trufflehog binary (if using trufflehog scanner)
    trufflehogPath: z.string().optional(),

    // Custom patterns to add to the built-in patterns
    customPatterns: z.array(customPatternSchema).default([]),

    // Pattern IDs to exclude from scanning
    excludePatterns: z.array(z.string()).default([]),

    // File patterns to exclude from scanning (glob patterns)
    excludeFiles: z.array(z.string()).default([]),

    // Maximum file size to scan (in bytes)
    maxFileSize: z.number().default(10 * 1024 * 1024), // 10MB

    // ========== Password Manager Backend Configuration ==========

    /** Which backend to use for secret resolution */
    secretBackend: backendNameSchema.default('local'),

    /** Backend-specific configuration */
    backends: backendsConfigSchema.optional(),

    /** Cache secrets in memory during session */
    cacheSecrets: z.boolean().default(true),

    /** Path to secrets mappings file (relative to tuck dir) */
    secretMappings: z.string().default('secrets.mappings.json'),
  })
  .partial()
  .default({});

/**
 * Schema for the secrets store file (secrets.local.json)
 */
export const secretEntrySchema = z.object({
  value: z.string(),
  placeholder: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
  addedAt: z.string(),
  lastUsed: z.string().optional(),
});

export const secretsStoreSchema = z.object({
  version: z.string().default('1.0.0'),
  secrets: z.record(secretEntrySchema).default({}),
});

// Type exports
export type CustomPattern = z.infer<typeof customPatternSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
export type SecretEntry = z.infer<typeof secretEntrySchema>;
export type SecretsStore = z.infer<typeof secretsStoreSchema>;

// Backend type exports
export type BackendName = z.infer<typeof backendNameSchema>;
export type OnePasswordConfig = z.infer<typeof onePasswordConfigSchema>;
export type BitwardenConfig = z.infer<typeof bitwardenConfigSchema>;
export type PassConfig = z.infer<typeof passConfigSchema>;
export type BackendsConfig = z.infer<typeof backendsConfigSchema>;
