import { z } from 'zod';

export const fileStrategySchema = z.enum(['copy', 'symlink']);

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
     * JSON-key-scoped tracking. ABSENT (undefined) means the whole file is
     * tracked, exactly as before (this field is `.optional()`, never
     * `.default()`, so legacy manifests parse byte-identical). When present it
     * is a dot-delimited key path (e.g. `mcpServers`): the repo copy holds ONLY
     * that JSON subtree, and on apply/restore it is deep-merged back into the
     * live file, leaving every other key untouched. Mutually exclusive with
     * template/encrypted (the repo copy is a plain JSON subtree, not a
     * rendered/ciphertext artifact).
     */
    jsonKey: z.string().optional(),
  })
  .superRefine((file, ctx) => {
    if (file.jsonKey !== undefined) {
      if (file.jsonKey.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['jsonKey'], message: 'jsonKey must be a non-empty key path' });
      }
      if (file.template || file.encrypted) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['jsonKey'], message: 'jsonKey cannot be combined with template or encrypted' });
      }
    }
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
