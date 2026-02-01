/**
 * pass backend for tuck
 *
 * Uses the standard Unix password store (pass) to fetch secrets.
 * Relies on GPG for encryption/decryption.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import type { SecretBackend, SecretReference, PassConfig, SecretInfo } from './types.js';
import { SecretBackendError } from '../../errors.js';
import { expandPath } from '../paths.js';

const execFileAsync = promisify(execFile);

/**
 * Check if a file exists asynchronously
 */
const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * PassBackend implements the SecretBackend interface
 * using the standard Unix password store (pass).
 *
 * Pass uses GPG for encryption, so the GPG key must be
 * available and unlocked (or GPG agent must have the passphrase).
 *
 * Also works with pass-compatible tools like:
 * - gopass (https://github.com/gopasspw/gopass)
 * - passage (https://github.com/FiloSottile/passage)
 */
export class PassBackend implements SecretBackend {
  readonly name = 'pass' as const;
  readonly displayName = 'pass (Unix password store)';
  readonly cliName = 'pass';

  private config: PassConfig;
  private storePath: string;

  constructor(config?: PassConfig) {
    this.config = config || {};
    this.storePath = expandPath(this.config.storePath || '~/.password-store');
  }

  /**
   * Check if pass is installed
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('pass', ['version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if pass is initialized (has a .gpg-id file)
   */
  async isAuthenticated(): Promise<boolean> {
    // pass is "authenticated" if:
    // 1. The password store exists
    // 2. GPG can decrypt (which we'll find out when we try)
    const gpgIdPath = `${this.storePath}/.gpg-id`;
    return fileExists(gpgIdPath);
  }

  /**
   * Initialize pass (not really authentication, but consistency)
   */
  async authenticate(): Promise<void> {
    const isInit = await this.isAuthenticated();
    if (!isInit) {
      throw new SecretBackendError('pass', 'Password store not initialized', [
        'Run `pass init <gpg-id>` to initialize the password store',
        'See https://www.passwordstore.org/ for setup instructions',
      ]);
    }
    // pass uses GPG, which handles its own authentication via gpg-agent
  }

  /**
   * No lock operation for pass (GPG agent handles this)
   */
  async lock(): Promise<void> {
    // No-op: GPG agent manages key caching
  }

  /**
   * Get a secret from pass
   *
   * @param ref - Secret reference with backendPath as pass path
   * @returns The secret value (first line), or null if not found
   */
  async getSecret(ref: SecretReference): Promise<string | null> {
    if (!ref.backendPath) {
      throw new SecretBackendError('pass', `No path configured for secret "${ref.name}"`, [
        `Run: tuck secrets map ${ref.name} --pass "path/to/secret"`,
      ]);
    }

    const env = this.getEnv();

    try {
      const { stdout } = await execFileAsync('pass', ['show', ref.backendPath], { env });

      // By default, return just the first line (the password)
      // If the path ends with /*, return the full content
      if (ref.backendPath.endsWith('/*')) {
        return stdout.trim();
      }

      // Distinguish between "no output at all" (null) and an empty first line (empty password)
      if (stdout === '') {
        return null;
      }
      const lines = stdout.split('\n');
      // Handle edge case where split returns empty array (shouldn't happen, but defensive)
      const firstLine = lines.length > 0 ? lines[0] : '';
      return firstLine;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check for "not found" errors
      if (
        errorMsg.includes('not in the password store') ||
        errorMsg.includes('No such file') ||
        errorMsg.includes('is not in the password store')
      ) {
        return null;
      }

      // Check for GPG errors
      if (errorMsg.includes('gpg') || errorMsg.includes('decrypt')) {
        throw new SecretBackendError('pass', `GPG decryption failed: ${errorMsg}`, [
          'Ensure your GPG key is available',
          'Run `gpg --list-keys` to check',
          'GPG agent may need the passphrase - try running `pass show <any-entry>` manually',
        ]);
      }

      throw new SecretBackendError('pass', `Failed to get secret: ${errorMsg}`);
    }
  }

  /**
   * List all secrets in the password store
   */
  async listSecrets(): Promise<SecretInfo[]> {
    const env = this.getEnv();

    try {
      const { stdout } = await execFileAsync('pass', ['ls'], { env });

      // Parse the tree output
      const secrets: SecretInfo[] = [];
      const lines = stdout.split('\n');

      for (const line of lines) {
        // Skip empty lines and the header
        if (!line.trim() || line.startsWith('Password Store')) {
          continue;
        }

        // Remove tree characters and extract path
        const path = line.replace(/[├└│─ ]/g, '').trim();
        if (path && !path.endsWith('/')) {
          secrets.push({
            name: path,
            path: path,
          });
        }
      }

      return secrets;
    } catch {
      return [];
    }
  }

  /**
   * Get environment with password store path
   */
  private getEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.config.storePath) {
      env.PASSWORD_STORE_DIR = this.storePath;
    }
    if (this.config.gpgId) {
      env.PASSWORD_STORE_GPG_OPTS = `--default-key ${this.config.gpgId}`;
    }
    return env;
  }

  /**
   * Get setup instructions for pass backend
   */
  getSetupInstructions(): string {
    return `pass Backend Setup
──────────────────────
1. Install pass:
   macOS:   brew install pass
   Ubuntu:  apt install pass
   Arch:    pacman -S pass

2. Initialize with your GPG key:
   pass init <your-gpg-id>

3. Add some secrets:
   pass insert github/token
   pass insert aws/access_key_id

4. Configure tuck to use pass:
   tuck secrets backend set pass

5. Map your secrets:
   tuck secrets map GITHUB_TOKEN --pass "github/token"

Path format: path/to/secret
  - The path is relative to ~/.password-store
  - Returns the first line of the file (typically the password)

For alternative password stores (gopass, passage):
  tuck secrets backend set pass --store-path ~/.local/share/gopass/stores/root

See https://www.passwordstore.org/ for more information.`;
  }
}
