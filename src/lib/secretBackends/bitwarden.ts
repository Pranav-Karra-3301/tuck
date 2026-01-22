/**
 * Bitwarden backend for tuck
 *
 * Uses the Bitwarden CLI (bw) to fetch secrets from Bitwarden vaults.
 * Supports session management with automatic unlock.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SecretBackend, SecretReference, BitwardenConfig } from './types.js';
import { SecretBackendError, BackendAuthenticationError } from '../../errors.js';

const execFileAsync = promisify(execFile);

/** Bitwarden item structure from CLI */
interface BitwardenItem {
  id: string;
  name: string;
  login?: {
    username?: string;
    password?: string;
  };
  fields?: Array<{
    name: string;
    value: string;
  }>;
  notes?: string;
}

/** Bitwarden status response */
interface BitwardenStatus {
  status: 'unauthenticated' | 'locked' | 'unlocked';
  userEmail?: string;
}

/**
 * BitwardenBackend implements the SecretBackend interface
 * using the Bitwarden CLI (bw).
 *
 * Supports:
 * - Interactive authentication (bw login, bw unlock)
 * - Session tokens (BW_SESSION env var)
 * - Self-hosted Bitwarden instances
 */
export class BitwardenBackend implements SecretBackend {
  readonly name = 'bitwarden' as const;
  readonly displayName = 'Bitwarden';
  readonly cliName = 'bw';

  private config: BitwardenConfig;
  private sessionKey?: string;

  constructor(config?: BitwardenConfig) {
    this.config = config || {};
    // Check for existing session in environment
    this.sessionKey = process.env.BW_SESSION;
  }

  /**
   * Check if the bw CLI is installed
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('bw', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check Bitwarden authentication and unlock status
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const status = await this.getStatus();
      return status.status === 'unlocked';
    } catch {
      return false;
    }
  }

  /**
   * Get Bitwarden CLI status
   */
  private async getStatus(): Promise<BitwardenStatus> {
    const env = this.getEnv();
    const { stdout } = await execFileAsync('bw', ['status'], { env });
    return JSON.parse(stdout) as BitwardenStatus;
  }

  /**
   * Get environment with session key
   */
  private getEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.sessionKey) {
      env.BW_SESSION = this.sessionKey;
    }
    if (this.config.serverUrl) {
      env.BW_URL = this.config.serverUrl;
    }
    return env;
  }

  /**
   * Authenticate with Bitwarden
   * Requires interactive login if not already authenticated.
   */
  async authenticate(): Promise<void> {
    const status = await this.getStatus();

    switch (status.status) {
      case 'unauthenticated':
        throw new BackendAuthenticationError('bitwarden');

      case 'locked':
        throw new SecretBackendError('bitwarden', 'Vault is locked', [
          'Run `bw unlock` and set BW_SESSION environment variable',
          'Or run: export BW_SESSION="$(bw unlock --raw)"',
        ]);

      case 'unlocked':
        // Already authenticated and unlocked
        return;
    }
  }

  /**
   * Lock the Bitwarden vault
   */
  async lock(): Promise<void> {
    try {
      const env = this.getEnv();
      await execFileAsync('bw', ['lock'], { env });
      this.sessionKey = undefined;
    } catch {
      // Ignore errors - might not be unlocked
    }
  }

  /**
   * Get a secret from Bitwarden
   *
   * @param ref - Secret reference with backendPath as item name/ID
   * @returns The secret value (password), or null if not found
   */
  async getSecret(ref: SecretReference): Promise<string | null> {
    if (!ref.backendPath) {
      throw new SecretBackendError('bitwarden', `No path configured for secret "${ref.name}"`, [
        `Run: tuck secrets map ${ref.name} --bitwarden "item-name-or-id"`,
      ]);
    }

    const env = this.getEnv();

    try {
      // Get the item by name or ID
      const { stdout } = await execFileAsync('bw', ['get', 'item', ref.backendPath], { env });
      const item = JSON.parse(stdout) as BitwardenItem;

      // Determine which field to return
      // Path can include field specifier: "item-name/field-name"
      const pathParts = ref.backendPath.split('/');
      const fieldName = pathParts.length > 1 ? pathParts.slice(1).join('/') : null;

      if (fieldName) {
        // Look for custom field first
        const field = item.fields?.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
        if (field) {
          return field.value;
        }

        // Check standard fields
        if (fieldName.toLowerCase() === 'username' && item.login?.username) {
          return item.login.username;
        }
        if (fieldName.toLowerCase() === 'password' && item.login?.password) {
          return item.login.password;
        }
        if (fieldName.toLowerCase() === 'notes' && item.notes) {
          return item.notes;
        }

        // Field not found
        return null;
      }

      // Default: return password
      return item.login?.password ?? null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check for "not found" errors
      if (errorMsg.includes('Not found') || errorMsg.includes('no item')) {
        return null;
      }

      // Check for authentication errors
      if (errorMsg.includes('locked') || errorMsg.includes('unauthenticated')) {
        throw new BackendAuthenticationError('bitwarden');
      }

      throw new SecretBackendError('bitwarden', `Failed to get secret: ${errorMsg}`);
    }
  }

  /**
   * Sync the Bitwarden vault (optional helper)
   */
  async sync(): Promise<void> {
    const env = this.getEnv();
    await execFileAsync('bw', ['sync'], { env });
  }

  /**
   * Get setup instructions for Bitwarden backend
   */
  getSetupInstructions(): string {
    return `Bitwarden Backend Setup
─────────────────────────
1. Install the Bitwarden CLI:
   https://bitwarden.com/help/cli/

2. Log in to Bitwarden:
   bw login

3. Unlock your vault and set the session:
   export BW_SESSION="$(bw unlock --raw)"

4. Configure tuck to use Bitwarden:
   tuck secrets backend set bitwarden

5. Map your secrets:
   tuck secrets map GITHUB_TOKEN --bitwarden "github-token"

For self-hosted Bitwarden:
   tuck secrets backend set bitwarden --server-url https://vault.example.com

Path format: item-name or item-name/field-name
  - item-name: The name or ID of the item in Bitwarden
  - field-name: Optional. "password" (default), "username", "notes", or custom field name

Examples:
  "github-token"                - Returns the password field
  "github-token/username"       - Returns the username field
  "aws-creds/access_key_id"     - Returns a custom field named "access_key_id"`;
  }
}
