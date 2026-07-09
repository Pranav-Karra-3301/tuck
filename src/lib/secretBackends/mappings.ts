/**
 * Secret mappings file management for tuck
 *
 * Manages the secrets.mappings.json file which maps placeholder names
 * to backend-specific paths. This file IS version controlled.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { pathExists } from '../paths.js';
import {
  secretMappingsFileSchema,
  defaultMappingsFile,
  type SecretMappingsFile,
  type SecretMapping,
} from '../../schemas/secretMappings.schema.js';
import type { BackendName } from './types.js';

/** Default filename for mappings */
const DEFAULT_MAPPINGS_FILENAME = 'secrets.mappings.json';

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the path to the mappings file
 * @param tuckDir - The tuck directory path
 * @param customPath - Optional custom path from config
 */
export const getMappingsPath = (tuckDir: string, customPath?: string): string => {
  return join(tuckDir, customPath || DEFAULT_MAPPINGS_FILENAME);
};

// ============================================================================
// File Operations
// ============================================================================

/**
 * Load the mappings file from disk
 * @param tuckDir - The tuck directory path
 * @param customPath - Optional custom path from config
 */
export const loadMappings = async (
  tuckDir: string,
  customPath?: string
): Promise<SecretMappingsFile> => {
  const mappingsPath = getMappingsPath(tuckDir, customPath);

  if (!(await pathExists(mappingsPath))) {
    return cloneDefaultMappings();
  }

  try {
    const content = await readFile(mappingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    return secretMappingsFileSchema.parse(parsed);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[tuck] Warning: Failed to load mappings file: ${errorMsg}`);
    return cloneDefaultMappings();
  }
};

/**
 * Return a fresh, independent copy of the default mappings file.
 *
 * A shallow `{ ...defaultMappingsFile }` would share the nested `mappings`
 * object by reference, so a later setMapping() would mutate the module-level
 * default and leak state into every subsequent load.
 */
const cloneDefaultMappings = (): SecretMappingsFile => ({
  ...defaultMappingsFile,
  mappings: {},
});

/**
 * Save the mappings file to disk
 * @param tuckDir - The tuck directory path
 * @param mappings - The mappings to save
 * @param customPath - Optional custom path from config
 */
export const saveMappings = async (
  tuckDir: string,
  mappings: SecretMappingsFile,
  customPath?: string
): Promise<void> => {
  const mappingsPath = getMappingsPath(tuckDir, customPath);
  const content = JSON.stringify(mappings, null, 2) + '\n';
  await writeFile(mappingsPath, content, 'utf-8');
};

// ============================================================================
// Mapping Operations
// ============================================================================

/**
 * Get the mapping for a specific secret
 * @param tuckDir - The tuck directory path
 * @param name - The placeholder name
 * @param customPath - Optional custom path from config
 */
export const getMapping = async (
  tuckDir: string,
  name: string,
  customPath?: string
): Promise<SecretMapping | null> => {
  const mappings = await loadMappings(tuckDir, customPath);
  return mappings.mappings[name] || null;
};

/**
 * Set a mapping for a secret
 * @param tuckDir - The tuck directory path
 * @param name - The placeholder name
 * @param backend - The backend to set
 * @param path - The backend-specific path
 * @param customPath - Optional custom path from config
 */
export const setMapping = async (
  tuckDir: string,
  name: string,
  backend: BackendName | 'local',
  path: string | boolean,
  customPath?: string
): Promise<void> => {
  const mappings = await loadMappings(tuckDir, customPath);

  // Initialize mapping if it doesn't exist
  if (!mappings.mappings[name]) {
    mappings.mappings[name] = {};
  }

  // Set the backend-specific path
  if (backend === 'local') {
    mappings.mappings[name].local = path === true || path === 'true';
  } else {
    mappings.mappings[name][backend] = path as string;
  }

  await saveMappings(tuckDir, mappings, customPath);
};

/**
 * List all mappings
 * @param tuckDir - The tuck directory path
 * @param customPath - Optional custom path from config
 */
export const listMappings = async (
  tuckDir: string,
  customPath?: string
): Promise<Record<string, SecretMapping>> => {
  const mappings = await loadMappings(tuckDir, customPath);
  return mappings.mappings;
};

/**
 * Get the backend path for a secret
 * @param tuckDir - The tuck directory path
 * @param name - The placeholder name
 * @param backend - The backend to get the path for
 * @param customPath - Optional custom path from config
 */
export const getBackendPath = async (
  tuckDir: string,
  name: string,
  backend: BackendName,
  customPath?: string
): Promise<string | null> => {
  const mapping = await getMapping(tuckDir, name, customPath);
  if (!mapping) return null;

  if (backend === 'local') {
    return mapping.local ? name : null;
  }

  return mapping[backend] || null;
};
