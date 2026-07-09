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

import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';
import { existsSync } from 'fs';
import { getAuditLogPath, getLegacyAuditLogPath } from './state.js';

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
 * Get the path to the audit log file
 */
function getAuditLogPaths(): string[] {
  const paths = [getAuditLogPath(), getLegacyAuditLogPath()];
  return [...new Set(paths)];
}

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
 * Log when user confirms committing files with secrets
 */
export async function logSecretsCommitted(files: string[]): Promise<void> {
  const truncatedFiles = files.slice(0, 10);
  const details =
    truncatedFiles.join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : '');
  await logAuditEntry('SECRETS_COMMITTED', 'tuck add/sync', `Files with secrets: ${details}`);
}

/**
 * Log when a dangerous operation is confirmed
 */
export async function logDangerousConfirmed(operation: string, details?: string): Promise<void> {
  await logAuditEntry('DANGEROUS_CONFIRMED', operation, details);
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

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Read recent audit entries (for display in status/diagnostic commands)
 *
 * @param limit - Maximum number of entries to return (default: 10)
 * @returns Array of recent audit entries
 */
export async function getRecentAuditEntries(limit = 10): Promise<AuditEntry[]> {
  try {
    const parsedEntries: AuditEntry[] = [];

    for (const logPath of getAuditLogPaths()) {
      if (!existsSync(logPath)) {
        continue;
      }

      const content = await readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as AuditEntry;
          // Skip entries whose timestamp is unparseable. A NaN timestamp would
          // poison the sort below and break the recency check, so we never
          // fabricate placeholder 'unknown' entries for corrupted log lines.
          if (Number.isNaN(new Date(parsed.timestamp).getTime())) {
            continue;
          }
          parsedEntries.push(parsed);
        } catch {
          // Corrupted/garbage log line — skip it entirely rather than
          // fabricating an 'unknown' entry that would produce NaN downstream.
          continue;
        }
      }
    }

    const sortedEntries = parsedEntries.sort((a, b) => {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    return sortedEntries.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Check if there are any recent dangerous operations
 * Useful for warning users in status command
 *
 * @param withinHours - Check for operations within this many hours (default: 24)
 * @returns true if there are recent dangerous operations
 */
export async function hasRecentDangerousOperations(withinHours = 24): Promise<boolean> {
  const entries = await getRecentAuditEntries(50);
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000);

  return entries.some((entry) => {
    const entryDate = new Date(entry.timestamp);
    return entryDate > cutoff;
  });
}
