/**
 * Local secrets store management for tuck
 *
 * Manages the secrets.local.json file which stores actual secret values
 * locally (never committed to git). These values are used to replace
 * placeholders in dotfiles.
 */

import { readFile, writeFile, chmod, stat } from 'fs/promises';
import { join } from 'path';
import { ensureDir } from 'fs-extra';
import { pathExists } from '../paths.js';
import { secretsStoreSchema, type SecretsStore } from '../../schemas/secrets.schema.js';

// File permission constants
const SECRETS_FILE_MODE = 0o600; // Owner read/write only (rw-------)
const TUCK_DIR_MODE = 0o700;     // Owner read/write/execute only (rwx------)

const SECRETS_FILENAME = 'secrets.local.json';

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the path to the secrets file
 */
export const getSecretsPath = (tuckDir: string): string => {
  return join(tuckDir, SECRETS_FILENAME);
};

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Load the secrets store from disk
 */
export const loadSecretsStore = async (tuckDir: string): Promise<SecretsStore> => {
  const secretsPath = getSecretsPath(tuckDir);

  if (!(await pathExists(secretsPath))) {
    return {
      version: '1.0.0',
      secrets: {},
    };
  }

  // Security: Check and fix file permissions if too permissive
  try {
    const stats = await stat(secretsPath);
    const mode = stats.mode & 0o777;
    // If group or other have any permissions, fix it
    if ((mode & 0o077) !== 0) {
      await chmod(secretsPath, SECRETS_FILE_MODE);
    }
  } catch {
    // Ignore permission check errors (might be Windows)
  }

  try {
    const content = await readFile(secretsPath, 'utf-8');
    const parsed = JSON.parse(content);
    return secretsStoreSchema.parse(parsed);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // If the file disappeared between the existence check and read, treat as "no secrets yet"
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(
        `[tuck] Warning: Secrets store file not found when reading at '${secretsPath}': ${errorMsg}`
      );
      return {
        version: '1.0.0',
        secrets: {},
      };
    }

    // For any other error (permissions, corruption, validation issues), surface a clear failure
    console.error(
      `[tuck] Error: Failed to load secrets store from '${secretsPath}': ${errorMsg}`
    );
    throw new Error(
      `[tuck] Failed to load secrets store from '${secretsPath}': ${errorMsg}`
    );
  }
};

// Track if we've warned about Windows permissions (only warn once per session)
let windowsPermissionWarningShown = false;

/**
 * Save the secrets store to disk with secure permissions
 */
export const saveSecretsStore = async (tuckDir: string, store: SecretsStore): Promise<void> => {
  const secretsPath = getSecretsPath(tuckDir);
  await ensureDir(tuckDir);

  // Security: Set directory permissions to owner-only
  try {
    await chmod(tuckDir, TUCK_DIR_MODE);
  } catch {
    // chmod not supported (Windows) - permissions handled differently
  }

  const content = JSON.stringify(store, null, 2) + '\n';
  await writeFile(secretsPath, content, 'utf-8');

  // Security: Set file permissions to owner read/write only (0600)
  try {
    await chmod(secretsPath, SECRETS_FILE_MODE);
  } catch {
    // Security: Warn Windows users about permission limitations (once per session)
    if (process.platform === 'win32' && !windowsPermissionWarningShown) {
      console.warn(
        '[tuck] Warning: On Windows, file permissions cannot be restricted to owner-only. ' +
          'Ensure your secrets file is in a secure location not accessible to other users.'
      );
      windowsPermissionWarningShown = true;
    }
  }
};

// ============================================================================
// Secret CRUD Operations
// ============================================================================

/**
 * Set (add or update) a secret
 */
export const setSecret = async (
  tuckDir: string,
  name: string,
  value: string,
  options?: {
    description?: string;
    source?: string;
  }
): Promise<void> => {
  const store = await loadSecretsStore(tuckDir);
  const now = new Date().toISOString();

  store.secrets[name] = {
    value,
    placeholder: `{{${name}}}`,
    description: options?.description,
    source: options?.source,
    addedAt: store.secrets[name]?.addedAt || now,
    lastUsed: now,
  };

  await saveSecretsStore(tuckDir, store);
};

/**
 * Get a secret value by name
 */
export const getSecret = async (tuckDir: string, name: string): Promise<string | undefined> => {
  const store = await loadSecretsStore(tuckDir);
  return store.secrets[name]?.value;
};

/**
 * Remove a secret by name
 */
export const unsetSecret = async (tuckDir: string, name: string): Promise<boolean> => {
  const store = await loadSecretsStore(tuckDir);

  if (name in store.secrets) {
    delete store.secrets[name];
    await saveSecretsStore(tuckDir, store);
    return true;
  }

  return false;
};

/**
 * Check if a secret exists
 */
export const hasSecret = async (tuckDir: string, name: string): Promise<boolean> => {
  const store = await loadSecretsStore(tuckDir);
  return name in store.secrets;
};

// ============================================================================
// Listing and Querying
// ============================================================================

/**
 * List all secrets (without values, for display)
 */
export const listSecrets = async (
  tuckDir: string
): Promise<
  Array<{
    name: string;
    placeholder: string;
    description?: string;
    source?: string;
    addedAt: string;
    lastUsed?: string;
  }>
> => {
  const store = await loadSecretsStore(tuckDir);

  return Object.entries(store.secrets).map(([name, entry]) => ({
    name,
    placeholder: entry.placeholder,
    description: entry.description,
    source: entry.source,
    addedAt: entry.addedAt,
    lastUsed: entry.lastUsed,
  }));
};

/**
 * Get all secrets as a name->value map (for restoration)
 */
export const getAllSecrets = async (tuckDir: string): Promise<Record<string, string>> => {
  const store = await loadSecretsStore(tuckDir);

  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(store.secrets)) {
    result[name] = entry.value;
  }

  return result;
};

/**
 * Get secret count
 */
export const getSecretCount = async (tuckDir: string): Promise<number> => {
  const store = await loadSecretsStore(tuckDir);
  return Object.keys(store.secrets).length;
};

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Add multiple secrets at once
 */
export const setSecrets = async (
  tuckDir: string,
  secrets: Array<{
    name: string;
    value: string;
    description?: string;
    source?: string;
  }>
): Promise<void> => {
  const store = await loadSecretsStore(tuckDir);
  const now = new Date().toISOString();

  for (const secret of secrets) {
    store.secrets[secret.name] = {
      value: secret.value,
      placeholder: `{{${secret.name}}}`,
      description: secret.description,
      source: secret.source,
      addedAt: store.secrets[secret.name]?.addedAt || now,
      lastUsed: now,
    };
  }

  await saveSecretsStore(tuckDir, store);
};

/**
 * Update lastUsed timestamp for secrets that were used
 */
export const touchSecrets = async (tuckDir: string, names: string[]): Promise<void> => {
  const store = await loadSecretsStore(tuckDir);
  const now = new Date().toISOString();

  let changed = false;
  for (const name of names) {
    if (name in store.secrets) {
      store.secrets[name].lastUsed = now;
      changed = true;
    }
  }

  if (changed) {
    await saveSecretsStore(tuckDir, store);
  }
};

// ============================================================================
// Git Integration
// ============================================================================

/**
 * Ensure the secrets file is in .gitignore
 */
export const ensureSecretsGitignored = async (tuckDir: string): Promise<void> => {
  const gitignorePath = join(tuckDir, '.gitignore');

  let gitignoreContent = '';
  if (await pathExists(gitignorePath)) {
    gitignoreContent = await readFile(gitignorePath, 'utf-8');
  }

  // Check if already ignored
  if (gitignoreContent.includes(SECRETS_FILENAME)) {
    return;
  }

  // Add to .gitignore
  const newContent = gitignoreContent.trim()
    ? `${gitignoreContent.trim()}\n\n# Local secrets (NEVER commit)\n${SECRETS_FILENAME}\n`
    : `# Local secrets (NEVER commit)\n${SECRETS_FILENAME}\n`;

  await writeFile(gitignorePath, newContent, 'utf-8');
};

// ============================================================================
// Validation
// ============================================================================

// Security: Maximum secret name length to prevent file system issues and abuse
const MAX_SECRET_NAME_LENGTH = 100;
const MIN_SECRET_NAME_LENGTH = 1;

/**
 * Validate secret name format and length
 */
export const isValidSecretName = (name: string): boolean => {
  // Check length bounds
  if (name.length < MIN_SECRET_NAME_LENGTH || name.length > MAX_SECRET_NAME_LENGTH) {
    return false;
  }
  // Must be uppercase alphanumeric with underscores, starting with an uppercase letter (A-Z)
  return /^[A-Z][A-Z0-9_]*$/.test(name);
};

/**
 * Normalize a secret name to valid format
 * Security: Enforces length limits and validates result is not empty
 */
export const normalizeSecretName = (name: string): string => {
  let normalized = name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^[0-9_]+/, '') // Remove leading numbers and underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, ''); // Trim leading/trailing underscores

  // Security: If normalization resulted in empty string, use a fallback
  if (normalized.length === 0) {
    normalized = 'SECRET';
  }

  // Security: Truncate to max length
  if (normalized.length > MAX_SECRET_NAME_LENGTH) {
    normalized = normalized.slice(0, MAX_SECRET_NAME_LENGTH);
  }

  // Ensure it starts with a letter (add prefix if needed)
  if (!/^[A-Z]/.test(normalized)) {
    normalized = 'S_' + normalized;
    if (normalized.length > MAX_SECRET_NAME_LENGTH) {
      normalized = normalized.slice(0, MAX_SECRET_NAME_LENGTH);
    }
  }

  return normalized;
};
