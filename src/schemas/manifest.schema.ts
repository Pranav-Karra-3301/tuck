import { z } from 'zod';

export const fileStrategySchema = z.enum(['copy', 'symlink']);

/**
 * Profile/tag name grammar. A tag names a machine PROFILE (work, personal,
 * server, agent, …). Constrained to a filename-safe, shell-safe subset so a tag
 * can appear on the CLI and in JSON without quoting surprises — the same
 * grammar bundle names use, for consistency.
 */
export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/u;

/** A single profile tag on a tracked file. */
export const profileTagSchema = z.string().regex(PROFILE_NAME_PATTERN);

export const trackedFileSchema = z
  .object({
    source: z.string(),
    destination: z.string(),
    category: z.string(),
    strategy: fileStrategySchema,
    encrypted: z.boolean().default(false),
    template: z.boolean().default(false),
    permissions: z.string().optional(),
    added: z.string(),
    modified: z.string(),
    checksum: z.string(),
    /**
     * Live-source stat cache for the mtime+size short-circuit (git/make style).
     * Recorded ONLY for single regular files when their checksum is captured;
     * directories leave these `undefined` (a nested change never moves the dir's
     * own mtime/size, so a dir short-circuit would MISS real changes). When both
     * are present and the live file's stat still matches, the recorded checksum
     * is reused instead of re-hashing. They are `.optional()` (never
     * `.default()`) so legacy manifests parse byte-identical and simply fall back
     * to full hashing.
     */
    sourceMtimeMs: z.number().optional(),
    sourceSize: z.number().optional(),
    /**
     * Logical grouping above category — files default to the implicit "default"
     * bundle so legacy manifests load unchanged. Bundles let callers scope
     * `tuck apply --bundle <name>` and similar operations.
     */
    bundle: z.string().default('default'),
    /**
     * Profile tags — the machine PROFILES this file belongs to (work, personal,
     * server, agent, …). An EMPTY list means the file is "universal": it applies
     * under every profile (the shared/common set). A non-empty list scopes the
     * file to `tuck apply --profile <name>` only when `<name>` is a member.
     * Defaults to `[]` so legacy manifests load unchanged (every legacy file is
     * treated as universal, preserving today's apply-everything behavior).
     */
    tags: z.array(profileTagSchema).default([]),
    /**
     * Tracking scope. ABSENT (undefined) means a legacy/home-scoped file,
     * resolved against `$HOME` and validated exactly as before — so existing
     * manifests parse byte-identical (these fields are `.optional()`, never
     * `.default()`). `'repo'` means the file lives inside a git repo whose
     * absolute path differs per machine; it is identified by a stable, machine-
     * INDEPENDENT (repoKey, repoRelative) pair and resolved via the machine-
     * local repo registry. The manifest never stores an absolute repo path.
     */
    scope: z.enum(['home', 'repo']).optional(),
    /** Stable cross-machine repo identity (never an absolute path). */
    repoKey: z.string().optional(),
    /** POSIX path of the file relative to the repo root. */
    repoRelative: z.string().optional(),
  })
  .superRefine((file, ctx) => {
    if (file.scope === 'repo') {
      if (!file.repoKey) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoKey'], message: 'repoKey is required for repo-scoped files' });
      }
      if (!file.repoRelative) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoRelative'], message: 'repoRelative is required for repo-scoped files' });
      } else {
        const norm = file.repoRelative.replace(/\\/g, '/');
        const unsafe =
          norm.startsWith('/') ||
          /^[A-Za-z]:[\\/]/.test(file.repoRelative) ||
          norm.split('/').includes('..');
        if (unsafe) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoRelative'], message: `Unsafe repoRelative path: ${file.repoRelative}` });
        }
      }
    } else if (file.repoKey !== undefined || file.repoRelative !== undefined) {
      // Home-scoped (or scope absent) files must not carry repo fields.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoKey'], message: 'repoKey/repoRelative are only valid on repo-scoped files' });
    }
  });

export const bundleMetadataSchema = z.object({
  description: z.string().optional(),
  created: z.string(),
});

/**
 * Registry metadata for a named profile. Profiles are declared in the shared
 * (committed) manifest so every machine agrees on which profiles exist; a
 * machine then BINDS to one locally (never committed) via the state dir.
 */
export const profileMetadataSchema = z.object({
  description: z.string().optional(),
  created: z.string(),
});

export const tuckManifestSchema = z.object({
  version: z.string(),
  created: z.string(),
  updated: z.string(),
  machine: z.string().optional(),
  files: z.record(trackedFileSchema),
  /**
   * Registry of known bundles. The `default` bundle is always present after
   * load (the manifest loader migrates legacy manifests transparently).
   */
  bundles: z.record(bundleMetadataSchema).default({}),
  /**
   * Registry of known profiles (work, personal, server, agent, …). Unlike
   * bundles there is no mandatory implicit profile: an empty registry means no
   * profiles are defined and `tuck apply` (with no `--profile`) applies every
   * file, exactly as before. Defaults to `{}` so legacy manifests load
   * unchanged.
   */
  profiles: z.record(profileMetadataSchema).default({}),
});

export type TrackedFileInput = z.input<typeof trackedFileSchema>;
export type TrackedFileOutput = z.output<typeof trackedFileSchema>;
export type TuckManifestInput = z.input<typeof tuckManifestSchema>;
export type TuckManifestOutput = z.output<typeof tuckManifestSchema>;

export const createEmptyManifest = (machine?: string): TuckManifestOutput => {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    created: now,
    updated: now,
    machine,
    files: {},
    bundles: {
      default: { created: now },
    },
    profiles: {},
  };
};
