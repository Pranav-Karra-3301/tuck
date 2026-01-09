/**
 * Secret redaction and restoration for tuck
 *
 * Handles replacing secrets with placeholders in file content,
 * and restoring them from the local secrets store.
 */

import { readFile, writeFile, rename, unlink, stat } from 'fs/promises';
import { randomBytes } from 'crypto';
import { dirname, basename, join } from 'path';
import { expandPath, pathExists } from '../paths.js';
import type { SecretMatch } from './scanner.js';
import { getAllSecrets } from './store.js';

// ============================================================================
// Atomic File Operations
// ============================================================================

/**
 * Atomically write to a file by writing to a temp file first, then renaming.
 * This prevents data loss from race conditions or crashes during write.
 */
const atomicWriteFile = async (filepath: string, content: string): Promise<void> => {
  // Generate unique temp filename in same directory (for same-filesystem rename)
  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = join(dirname(filepath), `.${basename(filepath)}.tmp.${tempSuffix}`);

  try {
    // Get original file permissions if file exists
    let mode: number | undefined;
    try {
      const stats = await stat(filepath);
      mode = stats.mode;
    } catch {
      // File doesn't exist, use default permissions
    }

    // Write to temp file first
    await writeFile(tempPath, content, { encoding: 'utf-8', mode });

    // Atomically rename temp to target (this is atomic on POSIX systems)
    await rename(tempPath, filepath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
};

// ============================================================================
// Types
// ============================================================================

export interface RedactionResult {
  originalContent: string;
  redactedContent: string;
  replacements: Array<{
    placeholder: string;
    originalValue: string;
    line: number;
  }>;
}

export interface RestorationResult {
  originalContent: string;
  restoredContent: string;
  restored: number;
  unresolved: string[];
}

// ============================================================================
// Placeholder Formatting
// ============================================================================

/**
 * Format a placeholder name into placeholder syntax
 */
export const formatPlaceholder = (name: string): string => {
  return `{{${name}}}`;
};

/**
 * Extract placeholder name from placeholder syntax
 */
export const parsePlaceholder = (placeholder: string): string | null => {
  const match = placeholder.match(/^\{\{([A-Z0-9_]+)\}\}$/);
  return match ? match[1] : null;
};

/**
 * Regex to find all placeholders in content
 */
export const PLACEHOLDER_REGEX = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

// ============================================================================
// Content Redaction
// ============================================================================

/**
 * Redact secrets in content string with placeholders
 */
export const redactContent = (
  content: string,
  matches: SecretMatch[],
  placeholderMap: Map<string, string> // secret value -> placeholder name
): RedactionResult => {
  let redactedContent = content;
  const replacements: RedactionResult['replacements'] = [];

  // Sort matches by position (descending by line, then column)
  // This way we replace from end to start to preserve indices
  const sortedMatches = [...matches].sort((a, b) => {
    if (a.line !== b.line) return b.line - a.line;
    return b.column - a.column;
  });

  for (const match of sortedMatches) {
    const placeholderName = placeholderMap.get(match.value) || match.placeholder;
    const placeholder = formatPlaceholder(placeholderName);

    // Replace all occurrences of this secret value
    // Use a temporary marker to avoid replacing already-replaced content
    const tempMarker = `__TUCK_TEMP_${Math.random().toString(36).slice(2)}__`;
    redactedContent = redactedContent.split(match.value).join(tempMarker);
    redactedContent = redactedContent.split(tempMarker).join(placeholder);

    replacements.push({
      placeholder: placeholderName,
      originalValue: match.value,
      line: match.line,
    });
  }

  return {
    originalContent: content,
    redactedContent,
    replacements: replacements.reverse(), // Return in original line order
  };
};

/**
 * Redact a file in place, returning the mapping for storage
 */
export const redactFile = async (
  filepath: string,
  matches: SecretMatch[],
  placeholderMap: Map<string, string>
): Promise<RedactionResult> => {
  const expandedPath = expandPath(filepath);
  const content = await readFile(expandedPath, 'utf-8');

  const result = redactContent(content, matches, placeholderMap);

  // Security: Use atomic write to prevent data loss from race conditions
  await atomicWriteFile(expandedPath, result.redactedContent);

  return result;
};

// ============================================================================
// Content Restoration
// ============================================================================

/**
 * Restore secrets in content string from placeholders
 */
export const restoreContent = (
  content: string,
  secrets: Record<string, string> // placeholder name -> actual value
): RestorationResult => {
  let restoredContent = content;
  let restored = 0;
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();

  // Find all placeholders in the content
  const matches = [...content.matchAll(PLACEHOLDER_REGEX)];

  for (const match of matches) {
    const placeholderName = match[1];
    const fullPlaceholder = match[0];

    if (placeholderName in secrets) {
      // Replace this placeholder with actual value
      restoredContent = restoredContent.replaceAll(fullPlaceholder, secrets[placeholderName]);
      restored++;
    } else if (!seenUnresolved.has(placeholderName)) {
      // Track unresolved placeholders
      unresolved.push(placeholderName);
      seenUnresolved.add(placeholderName);
    }
  }

  return {
    originalContent: content,
    restoredContent,
    restored,
    unresolved,
  };
};

/**
 * Restore a file in place from the secrets store
 */
export const restoreFile = async (
  filepath: string,
  tuckDir: string
): Promise<{ restored: number; unresolved: string[] }> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    return { restored: 0, unresolved: [] };
  }

  const content = await readFile(expandedPath, 'utf-8');
  const secrets = await getAllSecrets(tuckDir);

  const result = restoreContent(content, secrets);

  // Only write if changes were made
  if (result.restored > 0) {
    // Security: Use atomic write to prevent data loss from race conditions
    await atomicWriteFile(expandedPath, result.restoredContent);
  }

  return {
    restored: result.restored,
    unresolved: result.unresolved,
  };
};

// ============================================================================
// Placeholder Detection
// ============================================================================

/**
 * Find all placeholders in content
 */
export const findPlaceholders = (content: string): string[] => {
  const placeholders: string[] = [];
  const matches = content.matchAll(PLACEHOLDER_REGEX);

  for (const match of matches) {
    if (!placeholders.includes(match[1])) {
      placeholders.push(match[1]);
    }
  }

  return placeholders;
};

/**
 * Find unresolved placeholders in content (those without stored values)
 */
export const findUnresolvedPlaceholders = (
  content: string,
  availableSecrets: Record<string, string>
): string[] => {
  const placeholders = findPlaceholders(content);
  return placeholders.filter((name) => !(name in availableSecrets));
};

/**
 * Check if content has any placeholders
 */
export const hasPlaceholders = (content: string): boolean => {
  return PLACEHOLDER_REGEX.test(content);
};

/**
 * Count placeholders in content
 */
export const countPlaceholders = (content: string): number => {
  const matches = content.match(PLACEHOLDER_REGEX);
  return matches ? matches.length : 0;
};

// ============================================================================
// Batch Operations
// ============================================================================

/**
 * Restore multiple files in place
 */
export const restoreFiles = async (
  filepaths: string[],
  tuckDir: string
): Promise<{
  totalRestored: number;
  filesModified: number;
  allUnresolved: string[];
}> => {
  const secrets = await getAllSecrets(tuckDir);
  let totalRestored = 0;
  let filesModified = 0;
  const allUnresolved = new Set<string>();

  for (const filepath of filepaths) {
    const expandedPath = expandPath(filepath);

    if (!(await pathExists(expandedPath))) {
      continue;
    }

    const content = await readFile(expandedPath, 'utf-8');
    const result = restoreContent(content, secrets);

    if (result.restored > 0) {
      // Security: Use atomic write to prevent data loss from race conditions
      await atomicWriteFile(expandedPath, result.restoredContent);
      totalRestored += result.restored;
      filesModified++;
    }

    for (const unresolved of result.unresolved) {
      allUnresolved.add(unresolved);
    }
  }

  return {
    totalRestored,
    filesModified,
    allUnresolved: [...allUnresolved],
  };
};

/**
 * Preview what placeholders would be restored without modifying files
 */
export const previewRestoration = async (
  filepath: string,
  tuckDir: string
): Promise<{
  wouldRestore: number;
  unresolved: string[];
  placeholders: string[];
}> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    return { wouldRestore: 0, unresolved: [], placeholders: [] };
  }

  const content = await readFile(expandedPath, 'utf-8');
  const secrets = await getAllSecrets(tuckDir);
  const placeholders = findPlaceholders(content);

  const resolved = placeholders.filter((p) => p in secrets);
  const unresolved = placeholders.filter((p) => !(p in secrets));

  return {
    wouldRestore: resolved.length,
    unresolved,
    placeholders,
  };
};
