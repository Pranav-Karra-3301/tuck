import { readFile, writeFile } from 'fs/promises';
import {
  tuckManifestSchema,
  createEmptyManifest,
  type TuckManifestOutput,
  type TrackedFileOutput,
} from '../schemas/manifest.schema.js';
import { getManifestPath, pathExists } from './paths.js';
import { ManifestError } from '../errors.js';

let cachedManifest: TuckManifestOutput | null = null;
let cachedManifestDir: string | null = null;

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

    cachedManifest = result.data;
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

  // Update the updated timestamp
  manifest.updated = new Date().toISOString();

  // Validate before saving
  const result = tuckManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new ManifestError(`Invalid manifest: ${result.error.message}`);
  }

  try {
    await writeFile(manifestPath, JSON.stringify(result.data, null, 2) + '\n', 'utf-8');
    cachedManifest = result.data;
    cachedManifestDir = tuckDir;
  } catch (error) {
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
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
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

export const getTrackedFile = async (
  tuckDir: string,
  id: string
): Promise<TrackedFileOutput | null> => {
  const manifest = await loadManifest(tuckDir);
  return manifest.files[id] || null;
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

export const getAllTrackedFiles = async (
  tuckDir: string
): Promise<Record<string, TrackedFileOutput>> => {
  const manifest = await loadManifest(tuckDir);
  return manifest.files;
};

export const getTrackedFilesByCategory = async (
  tuckDir: string,
  category: string
): Promise<Record<string, TrackedFileOutput>> => {
  const manifest = await loadManifest(tuckDir);
  const filtered: Record<string, TrackedFileOutput> = {};

  for (const [id, file] of Object.entries(manifest.files)) {
    if (file.category === category) {
      filtered[id] = file;
    }
  }

  return filtered;
};

export const isFileTracked = async (tuckDir: string, source: string): Promise<boolean> => {
  const result = await getTrackedFileBySource(tuckDir, source);
  return result !== null;
};

export const getFileCount = async (tuckDir: string): Promise<number> => {
  const manifest = await loadManifest(tuckDir);
  return Object.keys(manifest.files).length;
};

export const getCategories = async (tuckDir: string): Promise<string[]> => {
  const manifest = await loadManifest(tuckDir);
  const categories = new Set<string>();

  for (const file of Object.values(manifest.files)) {
    categories.add(file.category);
  }

  return Array.from(categories).sort();
};

export const clearManifestCache = (): void => {
  cachedManifest = null;
  cachedManifestDir = null;
};
