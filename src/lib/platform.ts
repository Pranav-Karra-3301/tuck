/**
 * Platform detection and cross-platform utilities
 * Centralizes all platform-specific logic for Windows compatibility
 */
import { homedir, platform } from 'os';
import { sep } from 'path';

/**
 * Platform detection constants
 */
export const IS_WINDOWS = platform() === 'win32';
export const IS_MACOS = platform() === 'darwin';
export const IS_LINUX = platform() === 'linux';

/**
 * Path separator for current platform
 */
export const PATH_SEP = sep;

/**
 * Environment variable path separator (: on Unix, ; on Windows)
 */
export const ENV_PATH_SEP = IS_WINDOWS ? ';' : ':';

/**
 * Normalize path separators to current platform
 * Converts forward slashes to backslashes on Windows, vice versa on Unix
 */
export const normalizePath = (path: string): string => {
  if (IS_WINDOWS) {
    return path.replace(/\//g, '\\');
  }
  return path.replace(/\\/g, '/');
};

/**
 * Convert path to POSIX format (forward slashes) for storage/manifest
 * Paths are stored in POSIX format for cross-platform compatibility
 */
export const toPosixPath = (path: string): string => {
  return path.replace(/\\/g, '/');
};

/**
 * Convert path from POSIX format to native platform format
 */
export const fromPosixPath = (path: string): string => {
  if (IS_WINDOWS) {
    return path.replace(/\//g, '\\');
  }
  return path;
};

/**
 * Get Windows environment variable paths
 * Returns empty strings on non-Windows platforms
 */
export const getWindowsEnvPaths = (): {
  appData: string;
  localAppData: string;
  userProfile: string;
} => {
  if (!IS_WINDOWS) {
    return {
      appData: '',
      localAppData: '',
      userProfile: homedir(),
    };
  }
  return {
    appData: process.env.APPDATA || '',
    localAppData: process.env.LOCALAPPDATA || '',
    userProfile: process.env.USERPROFILE || homedir(),
  };
};

/**
 * Expand Windows environment variables in a path
 * Handles %USERPROFILE%, %APPDATA%, %LOCALAPPDATA%
 */
export const expandWindowsEnvVars = (path: string): string => {
  if (!IS_WINDOWS) {
    return path;
  }

  const envPaths = getWindowsEnvPaths();

  return path
    .replace(/%USERPROFILE%/gi, envPaths.userProfile)
    .replace(/%APPDATA%/gi, envPaths.appData)
    .replace(/%LOCALAPPDATA%/gi, envPaths.localAppData);
};

/**
 * Check if a path is an absolute Windows path (has drive letter)
 * e.g., C:\Users\... or D:/path/to/file
 */
export const isWindowsAbsolutePath = (path: string): boolean => {
  return /^[A-Za-z]:[/\\]/.test(path);
};

/**
 * Check if a path is absolute for the current platform
 */
export const isAbsoluteForPlatform = (path: string): boolean => {
  if (IS_WINDOWS) {
    return isWindowsAbsolutePath(path);
  }
  return path.startsWith('/');
};
