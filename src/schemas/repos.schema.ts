import { z } from 'zod';

/**
 * Machine-local registry of repo bindings (repos.json under the state dir).
 *
 * This is per-machine and NEVER committed — it maps a stable, cross-machine
 * `repoKey` to that machine's absolute repo root, so a repo-scoped tracked file
 * (whose manifest entry holds only repoKey + repoRelative) can be resolved to a
 * concrete path that differs from machine to machine. It is validated, never
 * `as`-cast, since it is read off disk.
 */
export const repoBindingSchema = z.object({
  /** Absolute path to the repo root ON THIS MACHINE. */
  root: z.string(),
  /** Canonical remote URL the key was derived from (for diagnostics). */
  remoteUrl: z.string().optional(),
  boundAt: z.string(),
});

export const reposRegistrySchema = z.object({
  version: z.literal('1'),
  repos: z.record(repoBindingSchema).default({}),
});

export type RepoBinding = z.infer<typeof repoBindingSchema>;
export type ReposRegistry = z.infer<typeof reposRegistrySchema>;
