/**
 * macOS Keychain integration using the `security` command
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { Keystore } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Quote a token for `security`'s interactive command parser. Its tokenizer
 * treats whitespace as a separator and `\`, `"`, `'` as special, so we wrap the
 * value in double quotes and backslash-escape `\` and `"`. This lets us pass a
 * secret (which may contain spaces or quotes) as a single argument WITHOUT ever
 * placing it on the process argv.
 */
function quoteInteractiveArg(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Run a single `security` sub-command in interactive mode, feeding the command
 * line over stdin. Because the command line (and any secret in it) is written to
 * the child's stdin rather than passed as argv, it is never exposed in `ps`.
 */
function runSecurityInteractive(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `security exited with code ${code}`));
      }
    });

    child.stdin.write(`${command}\n`);
    child.stdin.end();
  });
}

/**
 * Validate that an argument doesn't contain dangerous characters.
 * Defense-in-depth measure since we use execFile which doesn't invoke a shell.
 */
function validateArg(arg: string, name: string): void {
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
}

export class MacOSKeystore implements Keystore {
  getName(): string {
    return 'macOS Keychain';
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;

    try {
      await execFileAsync('which', ['security'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async store(service: string, account: string, secret: string): Promise<void> {
    validateArg(service, 'service');
    validateArg(account, 'account');
    if (!secret || typeof secret !== 'string') {
      throw new Error('Secret must be a non-empty string');
    }

    // Delete existing entry first (security command doesn't update in place reliably)
    try {
      await this.delete(service, account);
    } catch {
      // Ignore if doesn't exist
    }

    // Add the new password via `security -i` (interactive), writing the command
    // over stdin. The secret must NOT be passed as an argv element: argv is
    // world-readable via `ps`/Activity Monitor for the command's lifetime, which
    // would leak the master backup-encryption password on shared machines. This
    // mirrors the Linux keystore, which pipes the secret to secret-tool's stdin.
    // -U updates in place if the entry already exists.
    const command = [
      'add-generic-password',
      '-U',
      '-s',
      quoteInteractiveArg(service),
      '-a',
      quoteInteractiveArg(account),
      '-w',
      quoteInteractiveArg(secret),
    ].join(' ');

    try {
      await runSecurityInteractive(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to store in macOS Keychain: ${message}`);
    }
  }

  async retrieve(service: string, account: string): Promise<string | null> {
    validateArg(service, 'service');
    validateArg(account, 'account');

    const args = [
      'find-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w', // Output password only
    ];

    try {
      const { stdout } = await execFileAsync('security', args, { timeout: 10000 });
      return stdout.trim();
    } catch {
      // Not found or other error
      return null;
    }
  }

  async delete(service: string, account: string): Promise<void> {
    validateArg(service, 'service');
    validateArg(account, 'account');

    const args = ['delete-generic-password', '-s', service, '-a', account];

    try {
      await execFileAsync('security', args, { timeout: 10000 });
    } catch {
      // Ignore errors (might not exist)
    }
  }
}
