import { z } from 'zod';

export const fileStrategySchema = z.enum(['copy', 'symlink']);

export const trackedFileSchema = z.object({
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
});

export const tuckManifestSchema = z.object({
  version: z.string(),
  created: z.string(),
  updated: z.string(),
  machine: z.string().optional(),
  files: z.record(trackedFileSchema),
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
  };
};
