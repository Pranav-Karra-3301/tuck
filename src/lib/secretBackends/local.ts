/**
 * Local secret backend for tuck
 *
 * Uses the local secrets.local.json file to store and retrieve secrets.
 * This is the default backend and requires no external dependencies.
 */

import type { SecretBackend, SecretReference, SecretInfo } from './types.js';
import { getSecret, listSecrets as listLocalSecrets } from '../secrets/store.js';

/**
 * LocalBackend implements the SecretBackend interface using
 * the existing secrets.local.json file storage.
 */
export class LocalBackend implements SecretBackend {
  readonly name = 'local' as const;
  readonly displayName = 'Local secrets file';
  readonly cliName = null;

  constructor(private tuckDir: string) {}

  /**
   * Local backend is always available
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Local backend requires no authentication
   */
  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  /**
   * No authentication needed for local backend
   */
  async authenticate(): Promise<void> {
    // No-op: local backend doesn't require authentication
  }

  /**
   * No lock/cleanup needed for local backend
   */
  async lock(): Promise<void> {
    // No-op: local backend doesn't have sessions
  }

  /**
   * Get a secret from the local store
   */
  async getSecret(ref: SecretReference): Promise<string | null> {
    const value = await getSecret(this.tuckDir, ref.name);
    return value ?? null;
  }

  /**
   * List all secrets in the local store
   */
  async listSecrets(): Promise<SecretInfo[]> {
    const secrets = await listLocalSecrets(this.tuckDir);
    return secrets.map((s) => ({
      name: s.name,
      path: s.placeholder,
      lastModified: s.lastUsed ? new Date(s.lastUsed) : undefined,
    }));
  }

  /**
   * Get setup instructions for local backend
   */
  getSetupInstructions(): string {
    return `Local Backend Setup
─────────────────────
The local backend stores secrets in ~/.tuck/secrets.local.json (gitignored).

To add a secret:
  tuck secrets set MY_SECRET

To list stored secrets:
  tuck secrets list

Secrets are automatically stored when you choose to redact detected secrets
during 'tuck add' or 'tuck sync' operations.`;
  }
}
