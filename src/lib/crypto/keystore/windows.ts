/**
 * Windows Credential Manager integration using cmdkey
 *
 * Note: Windows Credential Manager has limitations:
 * - cmdkey can store credentials but cannot retrieve passwords programmatically
 * - For full password retrieval, a native module would be needed
 * - This implementation stores credentials for apps that can use them (e.g., git)
 * - For tuck's own password retrieval, the fallback keystore is used
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Keystore } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Validate that an argument doesn't contain dangerous characters.
 * Defense-in-depth measure for credential arguments.
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
  // Reject characters that could cause issues with cmdkey
  // cmdkey uses : as a delimiter, so we need to be careful
  if (/[<>|&^]/.test(arg)) {
    throw new Error(`${name} contains invalid characters`);
  }
}

export class WindowsKeystore implements Keystore {
  getName(): string {
    return 'Windows Credential Manager';
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false;

    try {
      // Check if cmdkey is available (should be on all Windows versions)
      await execFileAsync('where', ['cmdkey'], { timeout: 5000 });
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
    if (secret.length > 512) {
      throw new Error('Secret too long for Windows Credential Manager (max 512 characters)');
    }

    const target = this.getTargetName(service, account);

    // Delete existing credential first (ignore errors)
    try {
      await execFileAsync('cmdkey', ['/delete:' + target], { timeout: 10000 });
    } catch {
      // Ignore - credential may not exist
    }

    // Add new credential using cmdkey
    // cmdkey /generic:target /user:username /pass:password
    try {
      await execFileAsync(
        'cmdkey',
        ['/generic:' + target, '/user:' + account, '/pass:' + secret],
        { timeout: 10000 }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to store in Windows Credential Manager: ${message}`);
    }
  }

  async retrieve(_service: string, _account: string): Promise<string | null> {
    // Note: Windows Credential Manager doesn't easily expose passwords via CLI
    // cmdkey /list can show credentials but cannot retrieve passwords programmatically
    // For full support, we'd need a native module or .NET interop
    //
    // This means Windows users will use the fallback encrypted file keystore
    // for password retrieval, while cmdkey is used for storing credentials
    // that other applications (like git) can use.
    return null;
  }

  async delete(service: string, account: string): Promise<void> {
    validateArg(service, 'service');
    validateArg(account, 'account');

    const target = this.getTargetName(service, account);

    try {
      await execFileAsync('cmdkey', ['/delete:' + target], { timeout: 10000 });
    } catch {
      // Ignore errors - credential may not exist
    }
  }

  private getTargetName(service: string, account: string): string {
    // Use a format that's compatible with git credential manager
    return `${service}:${account}`;
  }
}
