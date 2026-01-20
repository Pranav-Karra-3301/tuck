/**
 * Schema for secret mappings file (secrets.mappings.json)
 *
 * This file maps placeholder names to backend-specific paths,
 * allowing the same dotfiles to work with different password managers.
 *
 * Unlike secrets.local.json, this file IS version controlled.
 */

import { z } from 'zod';

// ============================================================================
// Individual Mapping Schema
// ============================================================================

/**
 * Mapping for a single secret placeholder to various backends
 *
 * Example:
 * {
 *   "1password": "op://Personal/GitHub Token/password",
 *   "bitwarden": "github-token",
 *   "pass": "github/token",
 *   "local": true
 * }
 */
export const secretMappingSchema = z.object({
  /** 1Password path (op://vault/item/field format) */
  '1password': z.string().optional(),

  /** Bitwarden item ID or name */
  bitwarden: z.string().optional(),

  /** pass path (relative to password store) */
  pass: z.string().optional(),

  /** Whether this secret is available in local store */
  local: z.boolean().optional(),
});

// ============================================================================
// Mappings File Schema
// ============================================================================

/**
 * Full secrets.mappings.json file schema
 */
export const secretMappingsFileSchema = z.object({
  /** Schema version for future migrations */
  version: z.string().default('1.0.0'),

  /** Map of placeholder name -> backend paths */
  mappings: z.record(secretMappingSchema).default({}),
});

// ============================================================================
// Type Exports
// ============================================================================

export type SecretMapping = z.infer<typeof secretMappingSchema>;
export type SecretMappingsFile = z.infer<typeof secretMappingsFileSchema>;
export type SecretMappingsFileInput = z.input<typeof secretMappingsFileSchema>;

// ============================================================================
// Default Values
// ============================================================================

export const defaultMappingsFile: SecretMappingsFile = {
  version: '1.0.0',
  mappings: {},
};
