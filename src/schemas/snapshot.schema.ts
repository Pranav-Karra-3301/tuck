import { z } from 'zod';

/**
 * Validation schema for a single file entry inside a snapshot's metadata.json.
 * Mirrors the `SnapshotFile` interface in `src/lib/timemachine.ts`.
 */
export const snapshotFileSchema = z.object({
  originalPath: z.string(),
  backupPath: z.string(),
  existed: z.boolean(),
});

/**
 * Validation schema for a snapshot's `metadata.json`. Mirrors the
 * `SnapshotMetadata` interface in `src/lib/timemachine.ts`.
 *
 * This is parsed defensively when reading snapshots off disk: a corrupted or
 * schema-violating metadata.json must NOT crash the whole snapshot list — the
 * caller is expected to skip the offending snapshot.
 */
export const snapshotMetadataSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  reason: z.string(),
  files: z.array(snapshotFileSchema),
  machine: z.string(),
  profile: z.string().optional(),
});

export type SnapshotFileInput = z.input<typeof snapshotFileSchema>;
export type SnapshotMetadataInput = z.input<typeof snapshotMetadataSchema>;
