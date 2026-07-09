import { z } from 'zod';

export const fileStrategySchema = z.enum(['copy', 'symlink']);

/**
 * How arrays are reconciled during a structured (JSON) three-way merge.
 * - `union`   — combine both sides, dropping deep-duplicate entries (default;
 *               ideal for allowlists like Claude permission `allow`/`deny`).
 * - `concat`  — append both sides verbatim, keeping duplicates.
 * - `replace` — treat a diverged array as a scalar conflict (resolved via the
 *               `conflict` strategy) instead of combining.
 */
export const arrayMergeStrategySchema = z.enum(['union', 'concat', 'replace']);

/**
 * How an irreconcilable scalar/type conflict is resolved during a structured
 * merge (both sides changed the same leaf to different values).
 * - `ours`   — always keep the local value.
 * - `theirs` — always take the incoming value.
 * - `manual` — surface the conflict and stop instead of guessing (default).
 */
export const conflictResolutionSchema = z.enum(['ours', 'theirs', 'manual']);

/**
 * Per-file structured-merge policy. When present, `tuck sync` performs a
 * key-level three-way merge of the tracked file instead of a silent
 * whole-file overwrite when local and remote have both diverged. Absent
 * (undefined) preserves the legacy behavior, so existing manifests parse
 * byte-identical (this field is `.optional()`, never `.default()`).
 */
export const mergePolicySchema = z.object({
  /** Structured format to parse. Only JSON is supported in v1. */
  format: z.literal('json'),
  arrays: arrayMergeStrategySchema.default('union'),
  conflict: conflictResolutionSchema.default('manual'),
});

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
    /**
     * Optional structured three-way merge policy. When set, `tuck sync`
     * reconciles this file key-by-key instead of overwriting it wholesale.
     * Undefined for the vast majority of files (plain copy semantics).
     */
    merge: mergePolicySchema.optional(),
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
  };
};
