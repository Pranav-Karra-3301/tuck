/**
 * Keystore factory - auto-detects platform and returns appropriate implementation
 */

import type { Keystore } from './types.js';
import { MacOSKeystore } from './macos.js';
import { LinuxKeystore } from './linux.js';
import { WindowsKeystore } from './windows.js';
import { FallbackKeystore } from './fallback.js';

export type { Keystore } from './types.js';
export { TUCK_SERVICE, TUCK_ACCOUNT } from './types.js';

let cachedKeystore: Keystore | null = null;

/**
 * Get the appropriate keystore for the current platform
 * Automatically falls back to encrypted file if system keychain unavailable
 */
export const getKeystore = async (): Promise<Keystore> => {
  if (cachedKeystore) {
    return cachedKeystore;
  }

  const platform = process.platform;

  // Try platform-specific keystore first
  if (platform === 'darwin') {
    const macos = new MacOSKeystore();
    if (await macos.isAvailable()) {
      cachedKeystore = macos;
      return macos;
    }
  } else if (platform === 'linux') {
    const linux = new LinuxKeystore();
    if (await linux.isAvailable()) {
      cachedKeystore = linux;
      return linux;
    }
  } else if (platform === 'win32') {
    // Windows uses the encrypted fallback file keystore by design. The Windows
    // Credential Manager (cmdkey) can store credentials but cannot retrieve
    // passwords programmatically, so WindowsKeystore.isAvailable() always returns
    // false and we fall through to the fallback below — which supports the full
    // store/retrieve/delete cycle and encrypts secrets at rest.
    const windows = new WindowsKeystore();
    if (await windows.isAvailable()) {
      cachedKeystore = windows;
      return windows;
    }
  }

  // Fallback to encrypted file
  const fallback = new FallbackKeystore();
  cachedKeystore = fallback;
  return fallback;
};

/**
 * Clear the cached keystore (useful for testing)
 */
export const clearKeystoreCache = (): void => {
  cachedKeystore = null;
};

/**
 * Get keystore name for display purposes
 */
export const getKeystoreName = async (): Promise<string> => {
  const keystore = await getKeystore();
  return keystore.getName();
};
