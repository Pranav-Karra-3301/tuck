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
