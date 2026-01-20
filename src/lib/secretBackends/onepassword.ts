/**
 * 1Password backend for tuck
 *
 * Uses the 1Password CLI (op) to fetch secrets from 1Password vaults.
 * Supports both interactive authentication and service account tokens.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SecretBackend, SecretReference, OnePasswordConfig } from './types.js';
import { SecretBackendError, BackendAuthenticationError } from '../../errors.js';

const execFileAsync = promisify(execFile);

/**
 * OnePasswordBackend implements the SecretBackend interface
 * using the 1Password CLI (op).
 *
 * Supports:
 * - Interactive authentication (op signin)
 * - Service account tokens (OP_SERVICE_ACCOUNT_TOKEN env var)
 * - Reading secrets via op:// URIs
 */
export class OnePasswordBackend implements SecretBackend {
  readonly name = '1password' as const;
  readonly displayName = '1Password';
  readonly cliName = 'op';

  private config: OnePasswordConfig;

  constructor(config?: OnePasswordConfig) {
    this.config = config || {};
  }

  /**
   * Check if the op CLI is installed
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('op', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if authenticated with 1Password
   * Works for both interactive sessions and service accounts
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      // Try to get account info - this will fail if not authenticated
      await execFileAsync('op', ['account', 'get', '--format=json'], {
        env: { ...process.env },
      });
      return true;
    } catch {
      // Check if service account token is set
      if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
        try {
          // Verify the service account token works
          await execFileAsync('op', ['vault', 'list', '--format=json'], {
            env: { ...process.env },
          });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /**
   * Authenticate with 1Password
   * For service accounts, just verifies the token works.
   * For interactive, prompts for signin.
   */
  async authenticate(): Promise<void> {
    // Check if service account token is set
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
      // Just verify it works
      try {
        await execFileAsync('op', ['vault', 'list', '--format=json'], {
          env: { ...process.env },
        });
        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new SecretBackendError('1password', `Service account token is invalid: ${errorMsg}`, [
          'Check that OP_SERVICE_ACCOUNT_TOKEN is set correctly',
          'Service account tokens can be created at https://start.1password.com/',
        ]);
      }
    }

    // Interactive authentication
    throw new BackendAuthenticationError('1password');
  }

  /**
   * Sign out of 1Password
   */
  async lock(): Promise<void> {
    // Don't sign out if using service account
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
      return;
    }

    try {
      await execFileAsync('op', ['signout'], {
        env: { ...process.env },
      });
    } catch {
      // Ignore errors - might not be signed in
    }
  }

  /**
   * Get a secret from 1Password
   *
   * @param ref - Secret reference with backendPath in op:// format
   * @returns The secret value, or null if not found
   */
  async getSecret(ref: SecretReference): Promise<string | null> {
    if (!ref.backendPath) {
      throw new SecretBackendError('1password', `No path configured for secret "${ref.name}"`, [
        `Run: tuck secrets map ${ref.name} --1password "op://vault/item/field"`,
      ]);
    }

    // Ensure the path is in op:// format
    let path = ref.backendPath;
    if (!path.startsWith('op://')) {
      // Try to construct a path using default vault
      if (this.config.vault) {
        path = `op://${this.config.vault}/${path}`;
      } else {
        throw new SecretBackendError('1password', `Invalid path format: ${path}`, [
          'Path must be in op://vault/item/field format',
          'Or set a default vault in config: security.backends.1password.vault',
        ]);
      }
    }

    try {
      const { stdout } = await execFileAsync('op', ['read', path, '--no-newline'], {
        env: { ...process.env },
      });
      return stdout;
    } catch (error) {
      // Check if it's a "not found" error
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('not found') || errorMsg.includes('could not be found')) {
        return null;
      }
      throw new SecretBackendError('1password', `Failed to read secret: ${errorMsg}`);
    }
  }

  /**
   * List available vaults (optional operation)
   */
  async listVaults(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('op', ['vault', 'list', '--format=json'], {
        env: { ...process.env },
      });
      const vaults = JSON.parse(stdout) as Array<{ name: string }>;
      return vaults.map((v) => v.name);
    } catch {
      return [];
    }
  }

  /**
   * Get setup instructions for 1Password backend
   */
  getSetupInstructions(): string {
    return `1Password Backend Setup
──────────────────────────
1. Install the 1Password CLI:
   https://1password.com/downloads/command-line/

2. Sign in to 1Password:
   op signin

3. Configure tuck to use 1Password:
   tuck secrets backend set 1password

4. Map your secrets:
   tuck secrets map GITHUB_TOKEN --1password "op://Personal/GitHub Token/password"

For CI/CD (service accounts):
1. Create a service account at https://start.1password.com/
2. Set the environment variable:
   export OP_SERVICE_ACCOUNT_TOKEN="your-token"

Path format: op://vault-name/item-name/field-name
  - vault-name: Your vault (e.g., "Personal", "Work")
  - item-name: The item title in 1Password
  - field-name: Usually "password", "username", or custom field name`;
  }
}
