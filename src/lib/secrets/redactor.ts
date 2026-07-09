/**
 * Secret redaction and restoration for tuck
 *
 * Handles replacing secrets with placeholders in file content,
 * and restoring them from the local secrets store.
 */

import { readFile, writeFile, rename, unlink, stat } from 'fs/promises';
import { randomBytes, createHash } from 'crypto';
import { dirname, basename, join, relative } from 'path';
import { expandPath, pathExists, isDirectory } from '../paths.js';
import { getDirectoryFiles } from '../files.js';
import { isBinaryBuffer } from '../binary.js';
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
    let fileExists = false;
    try {
      const stats = await stat(filepath);
      mode = stats.mode;
      fileExists = true;
    } catch {
      // File doesn't exist
    }

    // Security: For new security-sensitive files (e.g., dotfiles), use restrictive permissions
    if (!fileExists && basename(filepath).startsWith('.')) {
      mode = 0o600; // Owner read/write only
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
  const match = placeholder.match(/^\{\{([A-Z][A-Z0-9_]*)\}\}$/);
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

  // Replace LONGEST values first. If a shorter detected secret is a literal
  // substring of a longer one, replacing the shorter first would rewrite the
  // longer secret's prefix and leave its remaining characters in cleartext
  // (and orphan the longer placeholder). Length-descending order avoids this.
  const ordered = [...matches].sort((a, b) => b.value.length - a.value.length);

  for (const match of ordered) {
    const placeholder = formatPlaceholder(placeholderMap.get(match.value) || match.placeholder);

    // Replace all occurrences of this secret value. Use a temporary marker to
    // avoid replacing already-replaced content.
    // Security: Use crypto.randomBytes for unpredictable temp markers.
    const tempMarker = `__TUCK_TEMP_${randomBytes(16).toString('hex')}__`;
    redactedContent = redactedContent.split(match.value).join(tempMarker);
    redactedContent = redactedContent.split(tempMarker).join(placeholder);
  }

  // Build the replacements report in original (line) order, then reverse — this
  // preserves the prior contract (last line first) independent of replace order.
  const replacements: RedactionResult['replacements'] = matches.map((match) => ({
    placeholder: placeholderMap.get(match.value) || match.placeholder,
    originalValue: match.value,
    line: match.line,
  }));

  return {
    originalContent: content,
    redactedContent,
    replacements: replacements.reverse(), // reverse line order (last line first)
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
// Redacted-Content Checksums (drift detection, issue #100)
// ============================================================================

/**
 * Invert the secrets store into a `secret value -> placeholder name` map.
 *
 * Returns an empty map when no secrets are stored; callers use that as the
 * "skip entirely" fast path (nothing to redact, so hashing raw content equals
 * the stored checksum). When two stored names map to the same value, the FIRST
 * key in store order wins — stable across runs, and prefers the base name over
 * later `_N` suffixes assigned during redaction.
 */
export const getStoredValueMap = async (tuckDir: string): Promise<Map<string, string>> => {
  const secrets = await getAllSecrets(tuckDir);
  const map = new Map<string, string>();
  // Object.entries preserves store insertion order, so the first name that
  // claims a value wins and later duplicates are ignored.
  for (const [name, value] of Object.entries(secrets)) {
    // Skip empty-string values: an empty value is a substring of EVERY file, so
    // it would match everywhere and corrupt every redacted checksum.
    if (!value) continue;
    if (!map.has(value)) {
      map.set(value, name);
    }
  }
  return map;
};

/**
 * Replace every stored secret value in `content` with its `{{placeholder}}`.
 *
 * Longest value first — identical ordering to redactContent — so a shorter
 * secret that is a literal substring of a longer one cannot corrupt it. Values
 * not present in `content` (and empty-string values) are skipped, and when
 * nothing matches the ORIGINAL string is returned unchanged (same reference).
 * Shared by getRedactedChecksum and by `tuck diff`, which redacts the live
 * content before display so cleartext secrets never reach the terminal.
 */
export const redactValuesInContent = (
  content: string,
  valueMap: Map<string, string>
): string => {
  // Only non-empty values actually present in the text can affect the result.
  const present = [...valueMap.entries()].filter(([value]) => value && content.includes(value));
  if (present.length === 0) {
    return content;
  }

  present.sort((a, b) => b[0].length - a[0].length);

  let redacted = content;
  for (const [value, name] of present) {
    const placeholder = formatPlaceholder(name);
    // Two-phase split/join through a random marker, exactly as redactContent,
    // so already-substituted placeholders are never re-matched.
    const tempMarker = `__TUCK_TEMP_${randomBytes(16).toString('hex')}__`;
    redacted = redacted.split(value).join(tempMarker);
    redacted = redacted.split(tempMarker).join(placeholder);
  }
  return redacted;
};

/**
 * Hash a single file's buffer AS IF its known secrets were redacted.
 *
 * If the decoded utf-8 bytes contain none of the secret values, the ORIGINAL
 * buffer is hashed (never the decoded string) so binary content and non-secret
 * files are byte-identical to files.ts getFileChecksum. Otherwise the utf-8
 * string is redacted longest-value-first — byte-matching redactContent's
 * split/join + formatPlaceholder semantics — and the resulting string is hashed.
 */
const redactedBufferHash = (buffer: Buffer, valueMap: Map<string, string>): string => {
  // BINARY files are never redacted in the repo (the secret scanner skips them),
  // so hash their RAW bytes regardless of what their lossy utf-8 decode contains.
  // Redacting a secret's bytes out of a binary blob here would fabricate drift
  // that can never match the un-redacted repo copy.
  if (isBinaryBuffer(buffer)) {
    return createHash('sha256').update(buffer).digest('hex');
  }

  const text = buffer.toString('utf8');
  const redacted = redactValuesInContent(text, valueMap);

  // No stored value was present (redactValuesInContent returned the SAME string)
  // — hash the ORIGINAL buffer so non-secret text is byte-identical to
  // getFileChecksum. Invalid utf-8 bytes decode to U+FFFD and never match, so
  // they fall through here too.
  if (redacted === text) {
    return createHash('sha256').update(buffer).digest('hex');
  }

  return createHash('sha256').update(redacted).digest('hex');
};

/**
 * Checksum a live path AS IF its known secrets were redacted — i.e. the
 * checksum its repo copy would have after a sync. Byte-compatible with
 * files.ts getFileChecksum: same directory algorithm, and any file whose bytes
 * contain none of the secret values hashes its RAW buffer (so binary files and
 * non-secret files yield results identical to getFileChecksum). Files
 * containing secret values are decoded utf-8, values replaced longest-first
 * with `{{placeholder}}`, and the utf-8 string is hashed.
 *
 * The input path is expanded like getFileChecksum, and a nonexistent path
 * throws the same way getFileChecksum would (readFile ENOENT).
 */
export const getRedactedChecksum = async (
  livePath: string,
  valueMap: Map<string, string>
): Promise<string> => {
  const expandedPath = expandPath(livePath);

  if (await isDirectory(expandedPath)) {
    const files = await getDirectoryFiles(expandedPath);

    // Match getFileChecksum: empty directory hashes the empty string.
    if (files.length === 0) {
      return createHash('sha256').update('').digest('hex');
    }

    const entries: string[] = [];
    for (const file of files) {
      const relPath = relative(expandedPath, file).replace(/\\/g, '/');
      const buffer = await readFile(file);
      const contentHash = redactedBufferHash(buffer, valueMap);
      entries.push(`${relPath}\0${contentHash}`);
    }
    entries.sort();

    return createHash('sha256').update(entries.join('\n')).digest('hex');
  }

  const buffer = await readFile(expandedPath);
  return redactedBufferHash(buffer, valueMap);
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
      // Replace this placeholder with the actual value. Use a replacer FUNCTION
      // (not the string form) so `$`-sequences in the secret ($&, $$, $`, $<n>)
      // are inserted literally instead of being interpreted as replacement
      // patterns, which would silently corrupt the restored credential.
      const value = secrets[placeholderName];
      restoredContent = restoredContent.replaceAll(fullPlaceholder, () => value);
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
  // Use a cloned regex instance to avoid shared lastIndex state issues
  const regex = new RegExp(PLACEHOLDER_REGEX.source, PLACEHOLDER_REGEX.flags);
  return regex.test(content);
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

    // Secret placeholders are per-file; a tracked DIRECTORY has no content to
    // restore at the directory level (and readFile on a dir throws EISDIR).
    if ((await stat(expandedPath)).isDirectory()) {
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

// ============================================================================
// Resolver-Based Operations (Password Manager Integration)
// ============================================================================

import { createResolver } from '../secretBackends/resolver.js';
import { loadConfig } from '../config.js';

/**
 * Restore a file using the SecretResolver (supports password managers)
 *
 * This function uses the configured secret backend (local, 1Password, Bitwarden, pass)
 * to resolve placeholders in the file.
 */
export const restoreFileWithResolver = async (
  filepath: string,
  tuckDir: string
): Promise<{ restored: number; unresolved: string[]; backend: string }> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    return { restored: 0, unresolved: [], backend: 'none' };
  }

  const content = await readFile(expandedPath, 'utf-8');
  const placeholders = findPlaceholders(content);

  if (placeholders.length === 0) {
    return { restored: 0, unresolved: [], backend: 'none' };
  }

  // Create resolver with config
  const config = await loadConfig(tuckDir);
  const resolver = createResolver(tuckDir, config.security);

  // Resolve all placeholders
  const secrets = await resolver.resolveToMap(placeholders);
  const result = restoreContent(content, secrets);

  // Only write if changes were made
  if (result.restored > 0) {
    await atomicWriteFile(expandedPath, result.restoredContent);
  }

  return {
    restored: result.restored,
    unresolved: result.unresolved,
    backend: resolver.getPrimaryBackendName(),
  };
};

/**
 * Restore multiple files using the SecretResolver (supports password managers)
 */
export const restoreFilesWithResolver = async (
  filepaths: string[],
  tuckDir: string
): Promise<{
  totalRestored: number;
  filesModified: number;
  allUnresolved: string[];
  backend: string;
}> => {
  // Create resolver with config
  const config = await loadConfig(tuckDir);
  const resolver = createResolver(tuckDir, config.security);

  // Collect all placeholders from all files first
  const allPlaceholders = new Set<string>();
  const fileContents = new Map<string, string>();

  for (const filepath of filepaths) {
    const expandedPath = expandPath(filepath);

    if (!(await pathExists(expandedPath))) {
      continue;
    }

    // Secret placeholders are per-file; a tracked DIRECTORY has no content to
    // restore at the directory level (and readFile on a dir throws EISDIR).
    if ((await stat(expandedPath)).isDirectory()) {
      continue;
    }

    const content = await readFile(expandedPath, 'utf-8');
    const placeholders = findPlaceholders(content);

    fileContents.set(expandedPath, content);
    for (const p of placeholders) {
      allPlaceholders.add(p);
    }
  }

  // Resolve all placeholders at once (more efficient for password managers)
  const secrets = await resolver.resolveToMap([...allPlaceholders]);

  // Now restore each file
  let totalRestored = 0;
  let filesModified = 0;
  const allUnresolved = new Set<string>();

  for (const [expandedPath, content] of fileContents.entries()) {
    const result = restoreContent(content, secrets);

    if (result.restored > 0) {
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
    backend: resolver.getPrimaryBackendName(),
  };
};

/**
 * Preview restoration using the SecretResolver (supports password managers)
 */
export const previewRestorationWithResolver = async (
  filepath: string,
  tuckDir: string
): Promise<{
  wouldRestore: number;
  unresolved: string[];
  placeholders: string[];
  backend: string;
}> => {
  const expandedPath = expandPath(filepath);

  if (!(await pathExists(expandedPath))) {
    return { wouldRestore: 0, unresolved: [], placeholders: [], backend: 'none' };
  }

  const content = await readFile(expandedPath, 'utf-8');
  const placeholders = findPlaceholders(content);

  if (placeholders.length === 0) {
    return { wouldRestore: 0, unresolved: [], placeholders: [], backend: 'none' };
  }

  // Create resolver with config
  const config = await loadConfig(tuckDir);
  const resolver = createResolver(tuckDir, config.security);

  // Resolve all placeholders (just to check availability)
  const result = await resolver.resolveAll(placeholders);

  return {
    wouldRestore: result.resolved.size,
    unresolved: result.unresolved,
    placeholders,
    backend: resolver.getPrimaryBackendName(),
  };
};
