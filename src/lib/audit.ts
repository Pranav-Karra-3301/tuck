/**
 * Audit logging for dangerous operations
 *
 * Records when users perform potentially dangerous actions like:
 * - Using --force to bypass secret scanning
 * - Force pushing to remote
 * - Overwriting files without backup
 *
 * Logs are stored in ~/.tuck/audit.log (not tracked by git)
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

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
  | 'DANGEROUS_CONFIRMED'; // User confirmed a dangerous operation

// ============================================================================
// Constants
// ============================================================================

const AUDIT_FILENAME = 'audit.log';

// ============================================================================
// Logging Functions
// ============================================================================

/**
 * Get the path to the audit log file
 */
function getAuditLogPath(): string {
  return join(homedir(), '.tuck', AUDIT_FILENAME);
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
    const tuckDir = join(homedir(), '.tuck');

    // Ensure .tuck directory exists
    if (!existsSync(tuckDir)) {
      await mkdir(tuckDir, { recursive: true });
    }

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
    const logPath = getAuditLogPath();
    if (!existsSync(logPath)) {
      return [];
    }

    const { readFile } = await import('fs/promises');
    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Get last N entries
    const recentLines = lines.slice(-limit);

    return recentLines.map((line) => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        return {
          timestamp: 'unknown',
          action: 'DANGEROUS_CONFIRMED' as AuditAction,
          command: 'unknown',
          details: line,
        };
      }
    });
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
