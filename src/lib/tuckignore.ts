import { join } from 'path';
import { readFile, writeFile, appendFile } from 'fs/promises';
import { pathExists, expandPath, collapsePath } from './paths.js';

const TUCKIGNORE_FILENAME = '.tuckignore';

const TUCKIGNORE_HEADER = `# .tuckignore - Files to exclude from tracking
# One exact file path per line (no globs)
# Lines starting with # are comments
#
# Example:
# ~/bin/large-binary
# ~/.docker/config.json
`;

/**
 * Get the path to .tuckignore file
 */
export const getTuckignorePath = (tuckDir: string): string => {
  return join(tuckDir, TUCKIGNORE_FILENAME);
};

/**
 * Load and parse .tuckignore file
 * Returns a Set of collapsed paths (with ~/ prefix)
 */
export const loadTuckignore = async (tuckDir: string): Promise<Set<string>> => {
  const ignorePath = getTuckignorePath(tuckDir);
  const ignoredPaths = new Set<string>();

  if (!(await pathExists(ignorePath))) {
    return ignoredPaths;
  }

  try {
    const content = await readFile(ignorePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Expand and then collapse to normalize the path
      const expanded = expandPath(trimmed);
      const collapsed = collapsePath(expanded);
      ignoredPaths.add(collapsed);
    }
  } catch {
    // If the file can't be read, treat it as having no ignore rules.
    // This is intentionally non-fatal as it allows operation when .tuckignore
    // doesn't exist or has permission issues.
  }

  return ignoredPaths;
};

/**
 * Save paths to .tuckignore file
 * Overwrites the entire file
 */
export const saveTuckignore = async (tuckDir: string, paths: string[]): Promise<void> => {
  const ignorePath = getTuckignorePath(tuckDir);
  
  // Sort paths for consistent output
  const sortedPaths = [...paths].sort();
  
  const content = TUCKIGNORE_HEADER + '\n' + sortedPaths.join('\n') + '\n';
  
  await writeFile(ignorePath, content, 'utf-8');
};

/**
 * Add a path to .tuckignore file
 * Appends to the file if it exists, creates it if not
 */
export const addToTuckignore = async (tuckDir: string, path: string): Promise<void> => {
  const ignorePath = getTuckignorePath(tuckDir);
  
  // Normalize path to use ~/ prefix
  const expanded = expandPath(path);
  const collapsed = collapsePath(expanded);

  // Check if already ignored
  const existingPaths = await loadTuckignore(tuckDir);
  if (existingPaths.has(collapsed)) {
    return; // Already in the ignore file
  }

  // If file doesn't exist, create it with header
  if (!(await pathExists(ignorePath))) {
    await writeFile(ignorePath, TUCKIGNORE_HEADER + '\n', 'utf-8');
  }

  // Append the path
  await appendFile(ignorePath, collapsed + '\n', 'utf-8');
};

/**
 * Check if a path is in .tuckignore
 */
export const isIgnored = async (tuckDir: string, path: string): Promise<boolean> => {
  const ignoredPaths = await loadTuckignore(tuckDir);
  
  // Normalize path for comparison
  const expanded = expandPath(path);
  const collapsed = collapsePath(expanded);
  
  return ignoredPaths.has(collapsed);
};

/**
 * Remove a path from .tuckignore
 */
export const removeFromTuckignore = async (tuckDir: string, path: string): Promise<void> => {
  const ignorePath = getTuckignorePath(tuckDir);
  
  if (!(await pathExists(ignorePath))) {
    return; // Nothing to remove
  }

  // Normalize path
  const expanded = expandPath(path);
  const collapsed = collapsePath(expanded);

  // Load all paths
  const ignoredPaths = await loadTuckignore(tuckDir);
  ignoredPaths.delete(collapsed);

  // Save back
  await saveTuckignore(tuckDir, Array.from(ignoredPaths));
};

/**
 * Get all ignored paths
 */
export const getIgnoredPaths = async (tuckDir: string): Promise<string[]> => {
  const ignoredPaths = await loadTuckignore(tuckDir);
  return Array.from(ignoredPaths).sort();
};

