/**
 * Profiles / tags — work vs personal at the *set* level (IDEAS 5.4).
 *
 * Every tracked file carries a `tags` list naming the machine PROFILES it
 * belongs to. An EMPTY list means the file is "universal" — it applies under
 * every profile (the shared/common set). A non-empty list scopes the file to
 * `tuck apply --profile <name>` only when `<name>` is one of its tags.
 *
 * There are two distinct pieces of state:
 *
 *   1. The PROFILE REGISTRY lives in the shared (committed) manifest, so every
 *      machine agrees on which profiles exist and files carry portable tags.
 *   2. The machine BINDING lives in the off-repo state dir (profile.json) and is
 *      NEVER committed — it records which single profile THIS machine applies by
 *      default. Two machines cloning the same repo can bind to different
 *      profiles and materialize different subsets of the same manifest.
 *
 * This module also powers the ephemeral-environment story (IDEAS 2.5): a
 * headless `tuck apply --profile agent --yes` selects only the agent-config
 * subset for devcontainers / Codespaces / SSH sandboxes.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { ensureDir } from 'fs-extra';
import {
  loadManifest,
  saveManifest,
} from './manifest.js';
import { getStateDir } from './state.js';
import { atomicWriteFile } from './files.js';
import { pathExists } from './paths.js';
import { resolveLiveTarget } from './repoScope.js';
import { ManifestError } from '../errors.js';
import {
  PROFILE_NAME_PATTERN,
  type TrackedFileOutput,
} from '../schemas/manifest.schema.js';
import { profileBindingSchema, type ProfileBinding } from '../schemas/profile.schema.js';

const BINDING_MODE = 0o600;

// ─────────────────────────────────────────────────────────────────────────────
// Name validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Names composed solely of dots (`.`, `..`, `...`). Although the base grammar
 * allows dots, a dot-only name is a path-traversal footgun: `.` and `..` are the
 * current/parent directory on every filesystem, so a profile named `..` must
 * never be treated as valid even though it matches `PROFILE_NAME_PATTERN`.
 */
const DOT_ONLY_PATTERN = /^\.+$/u;

/** Whether `name` is a syntactically valid profile/tag name. */
export const isValidProfileName = (name: string): boolean =>
  typeof name === 'string' &&
  PROFILE_NAME_PATTERN.test(name) &&
  !DOT_ONLY_PATTERN.test(name);

/** Throw a consistent, actionable error for a malformed profile name. */
export const assertValidProfileName = (name: string): void => {
  if (!isValidProfileName(name)) {
    throw new ManifestError(
      `Invalid profile name: ${name}. Profile names may only contain letters, digits, dot, dash, and underscore.`
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure selection predicates (no I/O — safe to unit test directly)
// ─────────────────────────────────────────────────────────────────────────────

/** A file with no tags is "universal": it applies under every profile. */
export const isUniversalFile = (file: Pick<TrackedFileOutput, 'tags'>): boolean =>
  (file.tags?.length ?? 0) === 0;

/**
 * Whether `file` should be selected when applying `profile`.
 *   - `profile` undefined → no profile filtering (every file matches).
 *   - universal files always match.
 *   - tagged files match iff they carry `profile`.
 */
export const fileMatchesProfile = (
  file: Pick<TrackedFileOutput, 'tags'>,
  profile: string | undefined
): boolean => {
  if (!profile) return true;
  if (isUniversalFile(file)) return true;
  return (file.tags ?? []).includes(profile);
};

/**
 * A "leak" for the machine bound to `profile`: a file that is NOT universal and
 * does NOT carry `profile` — i.e. it belongs exclusively to OTHER profiles, yet
 * is tracked in this shared repo. Callers additionally gate on live existence
 * before flagging (a leak that isn't materialized on disk is only a latent one).
 */
export const fileIsForeignToProfile = (
  file: Pick<TrackedFileOutput, 'tags'>,
  profile: string
): boolean => !isUniversalFile(file) && !(file.tags ?? []).includes(profile);

// ─────────────────────────────────────────────────────────────────────────────
// Profile registry (shared, committed manifest)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a profile in the manifest if absent (idempotent upsert). Fills in a
 * description on an existing profile only when it has none, matching
 * `ensureBundle`.
 */
export const ensureProfile = async (
  tuckDir: string,
  name: string,
  description?: string
): Promise<void> => {
  assertValidProfileName(name);
  const manifest = await loadManifest(tuckDir);

  if (manifest.profiles[name]) {
    if (description && !manifest.profiles[name].description) {
      manifest.profiles[name].description = description;
      await saveManifest(manifest, tuckDir);
    }
    return;
  }

  manifest.profiles[name] = {
    created: new Date().toISOString(),
    ...(description ? { description } : {}),
  };
  await saveManifest(manifest, tuckDir);
};

/**
 * Remove a profile from the registry and strip its tag from every file that
 * carried it. Returns the number of files that were untagged.
 */
export const removeProfile = async (
  tuckDir: string,
  name: string
): Promise<{ untagged: number }> => {
  const manifest = await loadManifest(tuckDir);
  if (!manifest.profiles[name]) {
    throw new ManifestError(`Profile not found: ${name}`);
  }

  let untagged = 0;
  const now = new Date().toISOString();
  for (const [id, file] of Object.entries(manifest.files)) {
    if ((file.tags ?? []).includes(name)) {
      manifest.files[id] = {
        ...file,
        tags: (file.tags ?? []).filter((t) => t !== name),
        modified: now,
      };
      untagged++;
    }
  }

  delete manifest.profiles[name];
  await saveManifest(manifest, tuckDir);
  return { untagged };
};

/**
 * Add `profile` to a tracked file's tags (idempotent). Auto-registers the
 * profile in the manifest if it does not yet exist, so `tuck profile tag work
 * ~/.foo` needs no prior `create`. Returns whether the tag was newly added.
 */
export const tagFile = async (
  tuckDir: string,
  id: string,
  profile: string
): Promise<{ added: boolean }> => {
  assertValidProfileName(profile);
  await ensureProfile(tuckDir, profile);

  const manifest = await loadManifest(tuckDir);
  const file = manifest.files[id];
  if (!file) {
    throw new ManifestError(`File not found in manifest: ${id}`);
  }

  const tags = file.tags ?? [];
  if (tags.includes(profile)) {
    return { added: false };
  }

  manifest.files[id] = {
    ...file,
    tags: [...tags, profile].sort(),
    modified: new Date().toISOString(),
  };
  await saveManifest(manifest, tuckDir);
  return { added: true };
};

/**
 * Remove `profile` from a tracked file's tags (idempotent). Returns whether the
 * tag was actually present and removed.
 */
export const untagFile = async (
  tuckDir: string,
  id: string,
  profile: string
): Promise<{ removed: boolean }> => {
  const manifest = await loadManifest(tuckDir);
  const file = manifest.files[id];
  if (!file) {
    throw new ManifestError(`File not found in manifest: ${id}`);
  }

  const tags = file.tags ?? [];
  if (!tags.includes(profile)) {
    return { removed: false };
  }

  manifest.files[id] = {
    ...file,
    tags: tags.filter((t) => t !== profile),
    modified: new Date().toISOString(),
  };
  await saveManifest(manifest, tuckDir);
  return { removed: true };
};

export interface ProfileCounts {
  name: string;
  description?: string;
  created: string;
  /** Files explicitly tagged with this profile. */
  fileCount: number;
}

/**
 * Build a stable, display-ready list of profiles with their tagged-file counts.
 * Includes any profile that appears only as a tag but is missing from the
 * registry (defensive — a hand-edited manifest could produce that).
 */
export const listProfileCounts = async (tuckDir: string): Promise<ProfileCounts[]> => {
  const manifest = await loadManifest(tuckDir);
  const counts = new Map<string, number>();
  for (const file of Object.values(manifest.files)) {
    for (const tag of file.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const names = new Set<string>([...Object.keys(manifest.profiles), ...counts.keys()]);
  const entries: ProfileCounts[] = [...names].map((name) => ({
    name,
    description: manifest.profiles[name]?.description,
    created: manifest.profiles[name]?.created ?? manifest.created,
    fileCount: counts.get(name) ?? 0,
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
};

/** Count of universal (untagged) files. */
export const countUniversalFiles = async (tuckDir: string): Promise<number> => {
  const manifest = await loadManifest(tuckDir);
  return Object.values(manifest.files).filter(isUniversalFile).length;
};

// ─────────────────────────────────────────────────────────────────────────────
// Machine-local binding (state dir, never committed)
// ─────────────────────────────────────────────────────────────────────────────

export const getProfileBindingPath = (): string => join(getStateDir(), 'profile.json');

/** Load this machine's profile binding; null on absence or corruption. */
export const loadProfileBinding = async (): Promise<ProfileBinding | null> => {
  const p = getProfileBindingPath();
  if (!(await pathExists(p))) return null;
  try {
    const parsed = profileBindingSchema.safeParse(JSON.parse(await readFile(p, 'utf-8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The profile name this machine is bound to, or null if unbound. */
export const getBoundProfile = async (): Promise<string | null> => {
  const binding = await loadProfileBinding();
  return binding?.profile ?? null;
};

/** Bind this machine to `profile` (idempotent overwrite). */
export const bindProfile = async (profile: string): Promise<void> => {
  assertValidProfileName(profile);
  const binding: ProfileBinding = {
    version: '1',
    profile,
    boundAt: new Date().toISOString(),
  };
  await ensureDir(getStateDir());
  await atomicWriteFile(getProfileBindingPath(), JSON.stringify(binding, null, 2) + '\n', {
    mode: BINDING_MODE,
  });
};

/** Remove this machine's binding. Returns whether one existed. */
export const unbindProfile = async (): Promise<boolean> => {
  const p = getProfileBindingPath();
  if (!(await pathExists(p))) return false;
  // atomicWriteFile has no delete; write an explicit "unbound" marker by
  // removing the file via the fs layer used everywhere else.
  const { rm } = await import('fs/promises');
  await rm(p, { force: true });
  return true;
};

/**
 * Resolve the EFFECTIVE profile for an operation: an explicit choice wins,
 * otherwise fall back to this machine's binding, otherwise none (no filtering).
 */
export const resolveEffectiveProfile = async (
  explicit: string | undefined
): Promise<string | null> => {
  if (explicit) return explicit;
  return getBoundProfile();
};

// ─────────────────────────────────────────────────────────────────────────────
// Leak detection
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileLeak {
  /** Manifest id of the leaked file. */
  id: string;
  /** Original source path (collapsed-friendly). */
  source: string;
  /** The profiles this file actually belongs to. */
  tags: string[];
  /** Absolute live path where the foreign file was found on disk. */
  livePath: string;
}

/**
 * Find files that leaked across profiles on the machine bound to `profile`: a
 * tracked file that belongs exclusively to OTHER profiles yet is materialized
 * on THIS machine's disk. Universal files and files carrying `profile` are never
 * leaks. Repo-scoped files whose repo is not bound here are skipped (their live
 * path is unknown — never guessed).
 */
export const detectProfileLeaks = async (
  tuckDir: string,
  profile: string
): Promise<ProfileLeak[]> => {
  const manifest = await loadManifest(tuckDir);
  const leaks: ProfileLeak[] = [];

  for (const [id, file] of Object.entries(manifest.files)) {
    if (!fileIsForeignToProfile(file, profile)) continue;

    const livePath = await resolveLiveTarget(file);
    if (!livePath) continue; // unresolvable (e.g. unbound repo) — skip.
    if (!(await pathExists(livePath))) continue; // latent, not materialized.

    leaks.push({
      id,
      source: file.source,
      tags: [...(file.tags ?? [])],
      livePath,
    });
  }

  return leaks;
};
