/**
 * Audit logging for dangerous operations
 *
 * Records when users perform potentially dangerous actions like:
 * - Using --force to bypass secret scanning
 * - Force pushing to remote
 * - Overwriting files without backup
 *
 * Logs are stored outside the tracked tuck repository state.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getAuditLogPath } from './state.js';

// ============================================================================
// Types
// ============================================================================

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  command: string;
  details?: string;
  user?: string;
  cwd?: string;
}

export type AuditAction =
  | 'FORCE_SECRET_BYPASS' // --force used to bypass secret scanning
  | 'FORCE_PUSH' // --force used for git push
  | 'FORCE_OVERWRITE' // --force used to overwrite files
  | 'SECRETS_COMMITTED' // User chose to commit files with detected secrets
  | 'SECRET_ALLOWLISTED' // User added a scanner finding to the secret allowlist
  | 'SECRET_ALLOWLIST_REMOVED' // User removed an entry from the secret allowlist
  | 'DANGEROUS_CONFIRMED'; // User confirmed a dangerous operation

// ============================================================================
// Constants
// ============================================================================

/**
 * Log an audit entry for a dangerous operation
 *
 * @param action - The type of dangerous action performed
 * @param command - The command that was run (e.g., 'tuck add --force')
 * @param details - Optional additional details
 */
export async function logAuditEntry(
  action: AuditAction,
  command: string,
  details?: string
): Promise<void> {
  try {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action,
      command,
      details,
      user: process.env.USER || process.env.USERNAME,
      cwd: process.cwd(),
    };

    const logLine = JSON.stringify(entry) + '\n';
    const logPath = getAuditLogPath();

    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, logLine, 'utf-8');
  } catch {
    // Silently fail - audit logging should never break the main operation
    // In debug mode, we could log this failure
    if (process.env.DEBUG) {
      console.error('[DEBUG] Failed to write audit log');
    }
  }
}

/**
 * Log when --force is used to bypass secret scanning
 */
export async function logForceSecretBypass(command: string, filesCount: number): Promise<void> {
  await logAuditEntry(
    'FORCE_SECRET_BYPASS',
    command,
    `Bypassed secret scanning for ${filesCount} file(s)`
  );
}

/**
 * Log when --force push is used
 */
export async function logForcePush(branch: string): Promise<void> {
  await logAuditEntry('FORCE_PUSH', 'tuck push --force', `Force pushed to branch: ${branch}`);
}

/**
 * Log when a scanner finding is added to the secret allowlist.
 *
 * SECURITY: only the (non-reversible) fingerprint and reason are recorded — the
 * raw secret value never touches the audit log.
 */
export async function logSecretAllowlisted(
  fingerprint: string,
  reason: string,
  scope?: { pattern?: string; path?: string }
): Promise<void> {
  const scopeParts = [
    scope?.pattern ? `pattern=${scope.pattern}` : undefined,
    scope?.path ? `path=${scope.path}` : undefined,
  ].filter(Boolean);
  const scopeText = scopeParts.length > 0 ? ` (${scopeParts.join(', ')})` : '';
  await logAuditEntry(
    'SECRET_ALLOWLISTED',
    'tuck secrets allow',
    `Allowlisted ${fingerprint.slice(0, 12)}…${scopeText}: ${reason}`
  );
}

/**
 * Log when an entry is removed from the secret allowlist.
 */
export async function logSecretAllowlistRemoved(fingerprints: string[]): Promise<void> {
  const summary = fingerprints.map((fp) => fp.slice(0, 12)).join(', ');
  await logAuditEntry(
    'SECRET_ALLOWLIST_REMOVED',
    'tuck secrets allow remove',
    `Removed ${fingerprints.length} allowlist entr${fingerprints.length === 1 ? 'y' : 'ies'}: ${summary}`
  );
}

