/**
 * Read-only guarantee for inspection commands.
 *
 * `tuck status`, `tuck diff`, and `tuck list` promise NEVER to touch a secret
 * backend (1Password/Bitwarden/pass/local external) and NEVER to trigger a
 * keystore unlock prompt. They only READ what is already on disk. This module
 * is the single, process-global switch that enforces that promise:
 *
 *   - Inspection commands call {@link enterReadOnlyMode} at the top of their run.
 *   - The keystore accessor ({@link keystorePassphrase}) and the secret resolver
 *     consult {@link isReadOnlyMode}. When it is on, they refuse to reach out to
 *     the OS keystore or an external backend — returning a cached value or
 *     nothing at all, so no interactive prompt can ever appear.
 *   - {@link assertNotReadOnly} is a defensive guard: any code path that would
 *     touch a backend from within a read-only command throws instead of silently
 *     prompting, so a future regression fails loudly in tests rather than nagging
 *     the user in production.
 *
 * The flag is deliberately a plain module-level boolean (one CLI invocation runs
 * exactly one command), mirroring how `jsonOutput` tracks JSON mode.
 */

import { ReadOnlyViolationError } from '../errors.js';

let readOnly = false;

/**
 * Enter read-only mode for the remainder of this process. Idempotent. Called by
 * inspection commands (status/diff/list) before they read any tracked state.
 */
export const enterReadOnlyMode = (): void => {
  readOnly = true;
};

/** Whether the current command has declared itself read-only. */
export const isReadOnlyMode = (): boolean => readOnly;

/**
 * Reset read-only mode. Intended for tests and long-lived hosts (e.g. the MCP
 * server) that run many logical commands in one process.
 */
export const resetReadOnlyMode = (): void => {
  readOnly = false;
};

/**
 * Throw {@link ReadOnlyViolationError} if a secret-backend / keystore-unlocking
 * operation is attempted while read-only mode is active. `operation` names the
 * thing that was blocked so the error message is actionable.
 */
export const assertNotReadOnly = (operation: string): void => {
  if (readOnly) {
    throw new ReadOnlyViolationError(operation);
  }
};

/**
 * Run `fn` with read-only mode forced on, restoring the previous state
 * afterwards. Useful for tests and for embedding an inspection routine inside a
 * larger command without leaking the flag.
 */
export const withReadOnlyMode = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = readOnly;
  readOnly = true;
  try {
    return await fn();
  } finally {
    readOnly = previous;
  }
};
