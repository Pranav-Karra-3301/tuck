import { z } from 'zod';
import { PROFILE_NAME_PATTERN } from './manifest.schema.js';

/**
 * Machine-local profile binding (profile.json under the state dir).
 *
 * This is per-machine and NEVER committed — it records which PROFILE this
 * particular machine is bound to (work, personal, server, agent, …). `tuck
 * apply` with no explicit `--profile` falls back to this binding, and `tuck
 * status` surfaces it plus any files that leaked in from other profiles. Two
 * machines sharing the same repo can therefore bind to different profiles and
 * apply different subsets of the same manifest. It is validated, never
 * `as`-cast, since it is read off disk.
 */
export const profileBindingSchema = z.object({
  version: z.literal('1'),
  /** The profile name this machine is bound to. */
  profile: z.string().regex(PROFILE_NAME_PATTERN),
  /** ISO timestamp the binding was written. */
  boundAt: z.string(),
});

export type ProfileBinding = z.infer<typeof profileBindingSchema>;
