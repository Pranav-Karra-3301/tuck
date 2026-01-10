/**
 * Zod schemas for secret scanning configuration
 */

import { z } from 'zod';

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
