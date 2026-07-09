/**
 * Zod schemas for `tuck settings` — versioned OS settings.
 *
 * Two on-disk artifacts are validated here:
 *
 *   1. The SHARED settings manifest (`os-settings.json`, committed to the tuck
 *      repo). It records captured OS settings (macOS `defaults` writes) and a
 *      manual-steps checklist. Because it round-trips across machines and can be
 *      pulled from an untrusted remote, it is always parsed, never `as`-cast.
 *
 *   2. The MACHINE-LOCAL state (`os-settings-state.json`, in the platform state
 *      dir, never committed). It records which manual steps the user has
 *      completed ON THIS MACHINE.
 *
 * The `os` discriminator ('macos' today) and the optional min/max version
 * guards are what let apply mode replay a setting safely on a machine whose OS
 * version may differ from where the setting was captured. Linux/dconf can be
 * added later by extending the `os` enum and adding a backend.
 */
import { z } from 'zod';

/**
 * Supported scalar `defaults` value types. Complex plist containers
 * (dictionary/array) and opaque `data` are intentionally excluded from v1
 * auto-capture — a GUI toggle almost always writes one of these scalars, and
 * replaying a raw container safely is out of scope. Such changes are surfaced
 * as a suggestion to record a manual step instead.
 */
export const settingTypeSchema = z.enum(['boolean', 'integer', 'float', 'string', 'date']);
export type SettingType = z.infer<typeof settingTypeSchema>;

/** Whether apply should `defaults write` a value or `defaults delete` the key. */
export const settingActionSchema = z.enum(['write', 'delete']);
export type SettingAction = z.infer<typeof settingActionSchema>;

/** OS discriminator. Only macOS is implemented in v1; the enum is the seam. */
export const settingsOsSchema = z.enum(['macos']);
export type SettingsOs = z.infer<typeof settingsOsSchema>;

export const settingEntrySchema = z.object({
  id: z.string().min(1),
  os: settingsOsSchema,
  /** Human description of what this setting does. */
  description: z.string().default(''),
  /** `defaults` domain, e.g. "NSGlobalDomain" or "com.apple.dock". */
  domain: z.string().min(1),
  /** Preference key within the domain. */
  key: z.string().min(1),
  action: settingActionSchema.default('write'),
  /** Present for action=write; absent/ignored for action=delete. */
  type: settingTypeSchema.optional(),
  /** String form of the value passed to `defaults write`. */
  value: z.string().optional(),
  /** OS version the setting was captured on (e.g. macOS "15.1"). */
  capturedOsVersion: z.string().default(''),
  /** Inclusive lower bound: skip apply when current OS version < minVersion. */
  minVersion: z.string().nullable().default(null),
  /** Inclusive upper bound: skip apply when current OS version > maxVersion. */
  maxVersion: z.string().nullable().default(null),
  /** Apps to `killall` after applying so the change takes effect. */
  restartApps: z.array(z.string()).default([]),
  added: z.string(),
  modified: z.string(),
});
export type SettingEntry = z.infer<typeof settingEntrySchema>;

export const manualStepSchema = z.object({
  id: z.string().min(1),
  os: settingsOsSchema,
  title: z.string().min(1),
  instructions: z.string().default(''),
  added: z.string(),
  modified: z.string(),
});
export type ManualStep = z.infer<typeof manualStepSchema>;

export const osSettingsManifestSchema = z.object({
  version: z.literal('1'),
  settings: z.record(settingEntrySchema).default({}),
  manualSteps: z.record(manualStepSchema).default({}),
});
export type OsSettingsManifest = z.infer<typeof osSettingsManifestSchema>;

export const osSettingsStateSchema = z.object({
  version: z.literal('1'),
  /** manualStepId -> ISO timestamp the step was marked done on this machine. */
  manualDone: z.record(z.string()).default({}),
});
export type OsSettingsState = z.infer<typeof osSettingsStateSchema>;
