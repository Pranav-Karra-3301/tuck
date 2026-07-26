import { readFile } from 'fs/promises';
import {
  tuckManifestSchema,
  createEmptyManifest,
  type TuckManifestOutput,
  type TrackedFileOutput,
} from '../schemas/manifest.schema.js';
import { getManifestPath, pathExists } from './paths.js';
import { atomicWriteFile } from './files.js';
import { ManifestError } from '../errors.js';

let cachedManifest: TuckManifestOutput | null = null;
let cachedManifestDir: string | null = null;

export const DEFAULT_BUNDLE = 'default';

/**
 * Forward-compatible migration: legacy manifests pre-dating bundles either
 * lack the `bundles` registry entirely or have files with no `bundle` field.
 * Zod's `.default(...)` already populates the missing values during parse, but
 * we still need to guarantee a `default` bundle exists in the registry so the
 * UI/JSON output stays consistent regardless of insertion order.
 */
const migrateBundles = (manifest: TuckManifestOutput): TuckManifestOutput => {
  // After zod parse, bundle defaults are populated. Ensure the default bundle
  // is registered if files reference it (which they will, after defaulting).
  const needsDefault =
    !manifest.bundles[DEFAULT_BUNDLE] &&
    (Object.keys(manifest.bundles).length === 0 ||
      Object.values(manifest.files).some((f) => f.bundle === DEFAULT_BUNDLE));

  if (needsDefault) {
    manifest.bundles[DEFAULT_BUNDLE] = {
      created: manifest.created,
    };
  }

  return manifest;
};

export const loadManifest = async (tuckDir: string): Promise<TuckManifestOutput> => {
  // Return cached manifest if same directory
  if (cachedManifest && cachedManifestDir === tuckDir) {
    return cachedManifest;
  }

  const manifestPath = getManifestPath(tuckDir);

  if (!(await pathExists(manifestPath))) {
    throw new ManifestError('Manifest file not found. Is tuck initialized?');
  }

  try {
    const content = await readFile(manifestPath, 'utf-8');
    const rawManifest = JSON.parse(content);
    const result = tuckManifestSchema.safeParse(rawManifest);

    if (!result.success) {
      throw new ManifestError(`Invalid manifest: ${result.error.message}`);
    }

    cachedManifest = migrateBundles(result.data);
    cachedManifestDir = tuckDir;

    return cachedManifest;
  } catch (error) {
    if (error instanceof ManifestError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new ManifestError('Manifest file contains invalid JSON');
    }
    throw new ManifestError(`Failed to load manifest: ${error}`);
  }
};

export const saveManifest = async (
  manifest: TuckManifestOutput,
  tuckDir: string
): Promise<void> => {
  const manifestPath = getManifestPath(tuckDir);

  // The mutation helpers below (addFileToManifest, removeFileFromManifest, …)
  // mutate the shared cached object BEFORE calling saveManifest. If validation
  // or the atomic write fails, that in-memory mutation would otherwise survive
  // and every subsequent loadManifest in this process would return state that
  // was never persisted (an orphaned tracked file, manifest/repo mismatch on
  // other machines). To prevent divergence:
  //  1. stamp `updated` on a copy, never the caller's (possibly cached) object;
  //  2. drop the cache on ANY failure so the next load re-reads disk truth.
  const candidate: TuckManifestOutput = { ...manifest, updated: new Date().toISOString() };

  const result = tuckManifestSchema.safeParse(candidate);
  if (!result.success) {
    clearManifestCache();
    throw new ManifestError(`Invalid manifest: ${result.error.message}`);
  }

  try {
    await atomicWriteFile(manifestPath, JSON.stringify(result.data, null, 2) + '\n');
    cachedManifest = result.data;
    cachedManifestDir = tuckDir;
  } catch (error) {
    clearManifestCache();
    throw new ManifestError(`Failed to save manifest: ${error}`);
  }
};

export const createManifest = async (
  tuckDir: string,
  machine?: string
): Promise<TuckManifestOutput> => {
  const manifestPath = getManifestPath(tuckDir);

  if (await pathExists(manifestPath)) {
    throw new ManifestError('Manifest already exists');
  }

  const manifest = createEmptyManifest(machine);

  try {
    await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    cachedManifest = manifest;
    cachedManifestDir = tuckDir;
    return manifest;
  } catch (error) {
    throw new ManifestError(`Failed to create manifest: ${error}`);
  }
};

export const addFileToManifest = async (
  tuckDir: string,
  id: string,
  file: TrackedFileOutput
): Promise<void> => {
  const manifest = await loadManifest(tuckDir);

  if (manifest.files[id]) {
    throw new ManifestError(`File already tracked with ID: ${id}`);
  }

  manifest.files[id] = file;
  await saveManifest(manifest, tuckDir);
};

export const updateFileInManifest = async (
  tuckDir: string,
  id: string,
  updates: Partial<TrackedFileOutput>
): Promise<void> => {
  const manifest = await loadManifest(tuckDir);

  if (!manifest.files[id]) {
    throw new ManifestError(`File not found in manifest: ${id}`);
  }

  manifest.files[id] = {
    ...manifest.files[id],
    ...updates,
    modified: new Date().toISOString(),
  };

  await saveManifest(manifest, tuckDir);
};

export const removeFileFromManifest = async (tuckDir: string, id: string): Promise<void> => {
  const manifest = await loadManifest(tuckDir);

  if (!manifest.files[id]) {
    throw new ManifestError(`File not found in manifest: ${id}`);
  }

  delete manifest.files[id];
  await saveManifest(manifest, tuckDir);
};

export const getTrackedFileBySource = async (
  tuckDir: string,
  source: string
): Promise<{ id: string; file: TrackedFileOutput } | null> => {
  const manifest = await loadManifest(tuckDir);

  for (const [id, file] of Object.entries(manifest.files)) {
    if (file.source === source) {
      return { id, file };
    }
  }

  return null;
};

/**
 * Build a single source→{id,file} lookup map for the manifest.
 *
 * `getTrackedFileBySource` is O(N) per call, so callers that probe many sources
 * against the manifest (e.g. new-file detection in `scan`/`sync`, which checks
 * every detected dotfile) were O(detected × tracked). Building this map ONCE
 * before such a loop turns each "already tracked?" check into an O(1) lookup
 * with identical semantics: a source is "tracked" iff it appears as a key here,
 * exactly as `getTrackedFileBySource` returning non-null.
 *
 * Note: if two entries somehow share the same `source`, the LAST one in
 * iteration order wins here. `getTrackedFileBySource` returns the FIRST match,
 * but a duplicate-source manifest is malformed and never produced by tuck, so
 * the only observable answer ("is this source tracked?") is unchanged.
 */
export const buildSourceIndex = async (
  tuckDir: string
): Promise<Map<string, { id: string; file: TrackedFileOutput }>> => {
  const manifest = await loadManifest(tuckDir);
  const index = new Map<string, { id: string; file: TrackedFileOutput }>();

  for (const [id, file] of Object.entries(manifest.files)) {
    index.set(file.source, { id, file });
  }

  return index;
};

export const getAllTrackedFiles = async (
  tuckDir: string
): Promise<Record<string, TrackedFileOutput>> => {
  const manifest = await loadManifest(tuckDir);
  return manifest.files;
};

export const isFileTracked = async (tuckDir: string, source: string): Promise<boolean> => {
  const result = await getTrackedFileBySource(tuckDir, source);
  return result !== null;
};

export const ensureBundle = async (
  tuckDir: string,
  bundle: string,
  description?: string
): Promise<void> => {
  const manifest = await loadManifest(tuckDir);
  if (manifest.bundles[bundle]) {
    if (description && !manifest.bundles[bundle].description) {
      manifest.bundles[bundle].description = description;
      await saveManifest(manifest, tuckDir);
    }
    return;
  }

  manifest.bundles[bundle] = {
    created: new Date().toISOString(),
    ...(description ? { description } : {}),
  };
  await saveManifest(manifest, tuckDir);
};

export const removeBundle = async (
  tuckDir: string,
  bundle: string,
  options: { reassignTo?: string } = {}
): Promise<{ reassigned: number }> => {
  if (bundle === DEFAULT_BUNDLE) {
    throw new ManifestError('Cannot remove the default bundle');
  }

  const manifest = await loadManifest(tuckDir);
  if (!manifest.bundles[bundle]) {
    throw new ManifestError(`Bundle not found: ${bundle}`);
  }

  const target = options.reassignTo ?? DEFAULT_BUNDLE;
  if (!manifest.bundles[target] && target !== DEFAULT_BUNDLE) {
    throw new ManifestError(`Reassignment target bundle not found: ${target}`);
  }
  if (target === DEFAULT_BUNDLE && !manifest.bundles[DEFAULT_BUNDLE]) {
    manifest.bundles[DEFAULT_BUNDLE] = { created: new Date().toISOString() };
  }

  let reassigned = 0;
  for (const [id, file] of Object.entries(manifest.files)) {
    if (file.bundle === bundle) {
      manifest.files[id] = { ...file, bundle: target, modified: new Date().toISOString() };
      reassigned++;
    }
  }

  delete manifest.bundles[bundle];
  await saveManifest(manifest, tuckDir);
  return { reassigned };
};

export const assignFileToBundle = async (
  tuckDir: string,
  id: string,
  bundle: string
): Promise<void> => {
  const manifest = await loadManifest(tuckDir);
  if (!manifest.files[id]) {
    throw new ManifestError(`File not found in manifest: ${id}`);
  }
  if (!manifest.bundles[bundle]) {
    throw new ManifestError(`Bundle not found: ${bundle}`);
  }

  manifest.files[id] = {
    ...manifest.files[id],
    bundle,
    modified: new Date().toISOString(),
  };
  await saveManifest(manifest, tuckDir);
};

export const clearManifestCache = (): void => {
  cachedManifest = null;
  cachedManifestDir = null;
};
