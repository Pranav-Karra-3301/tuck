/**
 * Keystore interface for cross-platform credential storage
 */

export interface Keystore {
  /**
   * Store a secret in the keystore
   */
  store(service: string, account: string, secret: string): Promise<void>;

  /**
   * Retrieve a secret from the keystore
   * Returns null if not found
   */
  retrieve(service: string, account: string): Promise<string | null>;

  /**
   * Delete a secret from the keystore
   */
  delete(service: string, account: string): Promise<void>;

  /**
   * Check if the keystore is available on this system
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get a human-readable name for this keystore
   */
  getName(): string;
}

// Constants for tuck's keystore entries
export const TUCK_SERVICE = 'tuck-dotfiles';
export const TUCK_ACCOUNT = 'backup-encryption';

/** Options controlling the shared keystore-argument validator. */
export interface ValidateKeystoreArgOptions {
  /**
   * Reject the extra cmdkey-hostile delimiter characters `< > | & ^`.
   * Only the Windows Credential Manager backend needs this, since cmdkey uses
   * `:` as a delimiter and mishandles these characters.
   */
  rejectShellDelimiters?: boolean;
}

/**
 * Validate that a credential argument doesn't contain dangerous characters.
 *
 * Defense-in-depth measure shared by all OS keystore backends: even though they
 * use execFile (which doesn't invoke a shell), the value should never be empty,
 * excessively long, or carry null bytes / control characters. The Windows
 * backend additionally passes `rejectShellDelimiters` to block cmdkey-hostile
 * characters.
 */
export function validateKeystoreArg(
  arg: string,
  name: string,
  options: ValidateKeystoreArgOptions = {}
): void {
  if (typeof arg !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  if (arg.length === 0) {
    throw new Error(`${name} cannot be empty`);
  }
  if (arg.length > 256) {
    throw new Error(`${name} too long (max 256 characters)`);
  }
  // Reject null bytes and control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(arg)) {
    throw new Error(`${name} contains invalid control characters`);
  }
  // Reject characters that could cause issues with cmdkey (Windows), which uses
  // `:` as a delimiter, so we need to be careful with these.
  if (options.rejectShellDelimiters && /[<>|&^]/.test(arg)) {
    throw new Error(`${name} contains invalid characters`);
  }
}
