/**
 * macOS Keychain integration using the `security` command
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Keystore } from './types.js';

const execFileAsync = promisify(execFile);

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

    // Add new password using execFile (no shell interpolation)
    // -U flag updates if exists, but we delete first to be safe
    const args = [
      'add-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w',
      secret,
      '-U', // Update if exists
    ];

    try {
      await execFileAsync('security', args, { timeout: 10000 });
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
