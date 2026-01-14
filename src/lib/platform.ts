/**
 * Platform detection and cross-platform path utilities
 *
 * This module provides utilities for Windows compatibility (beta).
 * - Platform detection constants
 * - Path normalization for cross-platform consistency
 * - Windows environment variable resolution
 */

import { platform, homedir } from 'os';
import { join } from 'path';

// ============================================================================
// Platform Detection Constants
// ============================================================================

/** True if running on Windows */
export const IS_WINDOWS = platform() === 'win32';

/** True if running on macOS */
export const IS_MACOS = platform() === 'darwin';

/** True if running on Linux */
export const IS_LINUX = platform() === 'linux';

/** True if running on any Unix-like OS (macOS or Linux) */
export const IS_UNIX = IS_MACOS || IS_LINUX;

// ============================================================================
// Path Normalization Utilities
// ============================================================================

/**
 * Normalize path separators to forward slashes for internal consistency.
 * This ensures paths can be compared reliably across platforms.
 *
 * Note: Windows APIs generally accept forward slashes, so this is safe.
 *
 * @param path - Path to normalize
 * @returns Path with all backslashes converted to forward slashes
 */
export const normalizePath = (path: string): string => {
  return path.replace(/\\/g, '/');
};

/**
 * Normalize a path for comparison purposes.
 * Converts to forward slashes and removes trailing slashes.
 *
 * @param path - Path to normalize
 * @returns Normalized path for comparison
 */
export const normalizeForComparison = (path: string): string => {
  return normalizePath(path).replace(/\/+$/, '');
};

// ============================================================================
// Windows Environment Variable Utilities
// ============================================================================

/**
 * Windows environment variable paths resolved at runtime.
 * Returns empty strings on non-Windows platforms.
 *
 * These are resolved at runtime rather than stored in config files
 * for better portability across different Windows machines.
 */
export interface WindowsPaths {
  /** %APPDATA% - Roaming application data (e.g., C:\Users\name\AppData\Roaming) */
  appData: string;
  /** %LOCALAPPDATA% - Local application data (e.g., C:\Users\name\AppData\Local) */
  localAppData: string;
  /** %USERPROFILE% - User home directory (e.g., C:\Users\name) */
  userProfile: string;
  /** %PROGRAMDATA% - Shared application data (e.g., C:\ProgramData) */
  programData: string;
}

/**
 * Get Windows environment variable paths.
 * Returns resolved paths on Windows, empty strings on other platforms.
 *
 * @returns Object containing resolved Windows paths
 */
export const getWindowsPaths = (): WindowsPaths => {
  if (!IS_WINDOWS) {
    return {
      appData: '',
      localAppData: '',
      userProfile: homedir(),
      programData: '',
    };
  }

  return {
    appData: process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    localAppData: process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    userProfile: process.env.USERPROFILE || homedir(),
    programData: process.env.PROGRAMDATA || 'C:\\ProgramData',
  };
};

/**
 * Expand a Windows environment variable in a path.
 * Supports: %USERPROFILE%, %APPDATA%, %LOCALAPPDATA%, %PROGRAMDATA%
 *
 * @param path - Path potentially containing Windows environment variables
 * @returns Path with environment variables expanded
 */
export const expandWindowsEnvVars = (path: string): string => {
  if (!IS_WINDOWS) {
    return path;
  }

  const winPaths = getWindowsPaths();
  let expanded = path;

  // Case-insensitive replacement of Windows environment variables
  expanded = expanded.replace(/%USERPROFILE%/gi, winPaths.userProfile);
  expanded = expanded.replace(/%APPDATA%/gi, winPaths.appData);
  expanded = expanded.replace(/%LOCALAPPDATA%/gi, winPaths.localAppData);
  expanded = expanded.replace(/%PROGRAMDATA%/gi, winPaths.programData);

  return expanded;
};

// ============================================================================
// Platform-Specific Path Utilities
// ============================================================================

/**
 * Get the home directory prefix used in collapsed paths.
 * Always returns '~' for cross-platform consistency in manifest storage.
 *
 * @returns Home directory prefix ('~')
 */
export const getHomePrefix = (): string => {
  return '~';
};

/**
 * Check if a path starts with a home directory indicator.
 * Handles both Unix (~/) and Windows (~\ or %USERPROFILE%) styles.
 *
 * @param path - Path to check
 * @returns True if path starts with a home directory indicator
 */
export const startsWithHome = (path: string): boolean => {
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return true;
  }
  if (path.startsWith('$HOME/') || path.startsWith('$HOME\\')) {
    return true;
  }
  if (path.toLowerCase().startsWith('%userprofile%')) {
    return true;
  }
  return false;
};

/**
 * Get platform-specific path separator.
 * Use this only when you need the native separator (e.g., for display).
 * For internal operations, prefer forward slashes.
 *
 * @returns '\' on Windows, '/' on Unix
 */
export const getPathSeparator = (): string => {
  return IS_WINDOWS ? '\\' : '/';
};
