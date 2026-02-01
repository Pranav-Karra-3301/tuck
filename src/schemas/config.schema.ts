import { z } from 'zod';
import { securityConfigSchema } from './secrets.schema.js';

export const fileStrategySchema = z.enum(['copy', 'symlink']);

// ============================================================================
// Remote/Provider Configuration
// ============================================================================

/** Supported git provider modes */
export const providerModeSchema = z.enum(['github', 'gitlab', 'local', 'custom']);

/** Remote configuration schema */
export const remoteConfigSchema = z
  .object({
    /** Provider mode (github, gitlab, local, custom) */
    mode: providerModeSchema.default('local'),
    /** Custom remote URL (for custom mode or manual override) */
    url: z.string().optional(),
    /** Provider instance URL (for self-hosted GitLab, etc.) */
    providerUrl: z.string().optional(),
    /** Cached username from provider */
    username: z.string().optional(),
    /** Repository name (without owner) */
    repoName: z.string().optional(),
  })
  .default({ mode: 'local' });

export const categoryConfigSchema = z.object({
  patterns: z.array(z.string()),
  icon: z.string().optional(),
});

export const tuckConfigSchema = z.object({
  repository: z
    .object({
      path: z.string(),
      defaultBranch: z.string().default('main'),
      autoCommit: z.boolean().default(true),
      autoPush: z.boolean().default(false),
    })
    .partial()
    .default({}),

  files: z
    .object({
      strategy: fileStrategySchema.default('copy'),
      backupOnRestore: z.boolean().default(true),
      backupDir: z.string().optional(),
    })
    .partial()
    .default({}),

  categories: z.record(categoryConfigSchema).optional().default({}),

  ignore: z.array(z.string()).optional().default([]),

  hooks: z
    .object({
      preSync: z.string().optional(),
      postSync: z.string().optional(),
      preRestore: z.string().optional(),
      postRestore: z.string().optional(),
    })
    .partial()
    .default({}),

  templates: z
    .object({
      enabled: z.boolean().default(false),
      variables: z.record(z.string()).default({}),
    })
    .partial()
    .default({}),

  encryption: z
    .object({
      /** Master switch for encryption features */
      enabled: z.boolean().default(false),
      /** Enable encryption for backups */
      backupsEnabled: z.boolean().default(false),
      /** GPG key for encryption (optional) */
      gpgKey: z.string().optional(),
      /** Files to encrypt */
      files: z.array(z.string()).default([]),
      /** Internal: Salt for password verification (hex encoded) */
      _verificationSalt: z.string().optional(),
      /** Internal: Hash for password verification */
      _verificationHash: z.string().optional(),
    })
    .partial()
    .default({}),

  ui: z
    .object({
      colors: z.boolean().default(true),
      emoji: z.boolean().default(true),
      verbose: z.boolean().default(false),
    })
    .partial()
    .default({}),

  security: securityConfigSchema,

  /** Remote/provider configuration */
  remote: remoteConfigSchema,
});

export type TuckConfigInput = z.input<typeof tuckConfigSchema>;
export type TuckConfigOutput = z.output<typeof tuckConfigSchema>;
export type ProviderMode = z.infer<typeof providerModeSchema>;
export type RemoteConfigOutput = z.output<typeof remoteConfigSchema>;

export const defaultConfig: TuckConfigOutput = {
  repository: {
    defaultBranch: 'main',
    autoCommit: true,
    autoPush: false,
  },
  files: {
    strategy: 'copy',
    backupOnRestore: true,
  },
  categories: {},
  ignore: [],
  hooks: {},
  templates: {
    enabled: false,
    variables: {},
  },
  encryption: {
    enabled: false,
    backupsEnabled: false,
    files: [],
  },
  ui: {
    colors: true,
    emoji: true,
    verbose: false,
  },
  security: {
    scanSecrets: true,
    blockOnSecrets: true,
    minSeverity: 'high',
    scanner: 'builtin',
    customPatterns: [],
    excludePatterns: [],
    excludeFiles: [],
    maxFileSize: 10 * 1024 * 1024,
    secretBackend: 'local',
    cacheSecrets: true,
    secretMappings: 'secrets.mappings.json',
  },
  remote: {
    mode: 'local',
  },
};
