/**
 * Linux Secret Service integration using `secret-tool`
 * Part of libsecret, commonly available on GNOME/KDE systems
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { Keystore } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Validate that an argument doesn't contain dangerous characters.
 * This is a defense-in-depth measure since we use execFile which doesn't invoke a shell.
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

export class LinuxKeystore implements Keystore {
  getName(): string {
    return 'Linux Secret Service';
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;

    try {
      await execFileAsync('which', ['secret-tool']);
      return true;
    } catch {
      return false;
    }
  }

  async store(service: string, account: string, secret: string): Promise<void> {
    // Validate inputs to prevent any potential issues
    validateArg(service, 'service');
    validateArg(account, 'account');
    if (!secret || typeof secret !== 'string') {
      throw new Error('Secret must be a non-empty string');
    }

    // Use spawn with stdin for secure password passing
    // execFile avoids shell interpolation entirely
    const args = [
      'store',
      '--label',
      `${service} - ${account}`,
      'service',
      service,
      'account',
      account,
    ];

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('secret-tool', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        child.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('error', (error) => {
          reject(new Error(`Failed to spawn secret-tool: ${error.message}`));
        });

        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`secret-tool exited with code ${code}: ${stderr}`));
          }
        });

        // Write password to stdin (secure - not passed via command line)
        child.stdin?.write(secret);
        child.stdin?.end();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to store in Linux Secret Service: ${message}`);
    }
  }

  async retrieve(service: string, account: string): Promise<string | null> {
    validateArg(service, 'service');
    validateArg(account, 'account');

    const args = ['lookup', 'service', service, 'account', account];

    try {
      const { stdout } = await execFileAsync('secret-tool', args, {
        timeout: 10000, // 10 second timeout
      });
      const result = stdout.trim();
      return result || null;
    } catch {
      return null;
    }
  }

  async delete(service: string, account: string): Promise<void> {
    validateArg(service, 'service');
    validateArg(account, 'account');

    const args = ['clear', 'service', service, 'account', account];

    try {
      await execFileAsync('secret-tool', args, {
        timeout: 10000,
      });
    } catch {
      // Ignore errors - credential may not exist
    }
  }
}
