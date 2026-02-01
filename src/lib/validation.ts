/**
 * Input Validation Utilities
 *
 * Centralized validation functions with security-hardened checks.
 */

import { IS_WINDOWS } from './platform.js';

// ============================================================================
// Constants
// ============================================================================

export const GIT_OPERATION_TIMEOUTS = {
  LS_REMOTE: 30000, // 30 seconds (increased from 10s)
  CLONE: 300000, // 5 minutes
  FETCH: 60000, // 1 minute
  PUSH: 60000, // 1 minute
} as const;

const BLOCKED_SYSTEM_PATHS_UNIX = [
  '/etc/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/boot/',
  '/root/',
  '/var/run/',
  '/var/log/',
] as const;

const BLOCKED_SYSTEM_PATHS_WINDOWS = [
  'C:\\Windows\\',
  'C:\\Windows\\System32\\',
  'C:\\Windows\\SysWOW64\\',
  'C:\\Program Files\\',
  'C:\\Program Files (x86)\\',
  'C:\\ProgramData\\',
  // Also block with forward slashes for URL-style paths
  'C:/Windows/',
  'C:/Windows/System32/',
  'C:/Windows/SysWOW64/',
  'C:/Program Files/',
  'C:/Program Files (x86)/',
  'C:/ProgramData/',
] as const;

/**
 * Get blocked system paths for the current platform
 */
const getBlockedSystemPaths = (): readonly string[] => {
  if (IS_WINDOWS) {
    return BLOCKED_SYSTEM_PATHS_WINDOWS;
  }
  return BLOCKED_SYSTEM_PATHS_UNIX;
};

const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^::1$/,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // Link-local
  /^fe80:/i, // IPv6 link-local
] as const;

// ============================================================================
// Repository Name Validation
// ============================================================================

/**
 * Validate repository name with strict security checks
 * @param repoName Repository name to validate
 * @param provider Provider name for error messages
 * @throws Error if validation fails
 */
export function validateRepoName(repoName: string, provider: string): void {
  // Check for control characters and null bytes
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(repoName)) {
    throw new Error('Repository name contains invalid control characters');
  }

  // Handle full URLs
  if (repoName.includes('://')) {
    validateHttpUrl(repoName, provider);
    return;
  }

  if (repoName.startsWith('git@')) {
    validateSshUrl(repoName, provider);
    return;
  }

  // For owner/repo or repo format, validate strictly
  const validPattern =
    /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?(?:\/[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)*$/;
  if (!validPattern.test(repoName)) {
    throw new Error(
      'Repository names must start and end with alphanumeric characters and can only contain alphanumeric characters, hyphens, underscores, and dots. Format: "owner/repo" or "repo"'
    );
  }
}

/**
 * Validate HTTP(S) URL
 */
function validateHttpUrl(url: string, provider: string): void {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid repository URL: ${url}`);
  }

  // Restrict to common git-related protocols
  const allowedProtocols = new Set(['http:', 'https:', 'ssh:', 'git+ssh:']);
  if (!allowedProtocols.has(parsedUrl.protocol)) {
    throw new Error(`Invalid protocol in URL. Allowed: ${Array.from(allowedProtocols).join(', ')}`);
  }

  // Validate hostname
  if (!/^[a-zA-Z0-9.-]+$/.test(parsedUrl.hostname)) {
    throw new Error('Invalid characters in hostname');
  }

  // Check for shell metacharacters
  if (/[;&|`$(){}[\]<>!#*?'"\\]/.test(url)) {
    throw new Error('URL contains invalid characters');
  }

  // Path validation for known providers
  if (provider === 'github' && parsedUrl.hostname === 'github.com') {
    const pathPattern = /^\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:\.git)?$/;
    if (!pathPattern.test(parsedUrl.pathname)) {
      throw new Error(
        'Invalid GitHub repository URL format. Expected: /owner/repo or /owner/repo.git'
      );
    }
  }
}

/**
 * Validate SSH URL (git@host:path format)
 */
function validateSshUrl(url: string, _provider: string): void {
  // Check for shell metacharacters before pattern matching
  if (/[;&|`$(){}[\]<>!#*?'"\\]/.test(url)) {
    throw new Error('URL contains invalid characters');
  }

  // Pattern for git@host:path format
  const sshPattern = /^git@([a-zA-Z0-9.-]+):([a-zA-Z0-9._/-]+)(?:\.git)?$/;
  if (!sshPattern.test(url)) {
    throw new Error('Invalid SSH URL format. Expected: git@host:path or git@host:path.git');
  }

  const match = url.match(sshPattern);
  if (match) {
    const [, host, path] = match;

    // Validate host
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
      throw new Error('Invalid hostname in SSH URL');
    }

    // Validate path doesn't contain suspicious patterns
    if (path.includes('..')) {
      throw new Error('Path traversal not allowed in repository URL');
    }
  }
}

// ============================================================================
// Repository Description Validation
// ============================================================================

/**
 * Validate repository description with length and character limits
 * @param description Description to validate
 * @param maxLength Maximum length (default: 350 for GitHub)
 */
export function validateDescription(description: string, maxLength: number = 350): void {
  // Length check
  if (description.length > maxLength) {
    throw new Error(`Description too long (max ${maxLength} characters)`);
  }

  // Check for invalid characters including quotes, newlines, and shell metacharacters
  // eslint-disable-next-line no-control-regex
  if (/[;&|`$(){}[\]<>!#*?'"\\n\r\t\x00-\x1F\x7F]/.test(description)) {
    throw new Error(
      'Description contains invalid characters. Cannot contain: ; & | ` $ ( ) { } [ ] < > ! # * ? \' " \\ newlines or control characters'
    );
  }

  // Normalize unicode to prevent homograph attacks
  const normalized = description.normalize('NFKC');
  if (normalized !== description) {
    throw new Error('Description contains unusual Unicode characters');
  }
}

// ============================================================================
// Hostname Validation (for self-hosted GitLab)
// ============================================================================

/**
 * Validate hostname for self-hosted instances with SSRF protection
 * @param hostname Hostname to validate
 * @throws Error if validation fails
 */
export function validateHostname(hostname: string): void {
  if (!hostname) {
    throw new Error('Hostname is required');
  }

  // Length check
  if (hostname.length > 253) {
    throw new Error('Hostname too long (max 253 characters)');
  }

  // Strict hostname validation with TLD requirement
  // Pattern: label.label.tld where labels are alphanumeric with hyphens (not at start/end)
  const hostnamePattern = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!hostnamePattern.test(hostname)) {
    throw new Error(
      'Invalid hostname format. Must be a fully qualified domain name (e.g., gitlab.example.com)'
    );
  }

  // Block localhost and loopback addresses
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error('Private IP addresses and localhost are not allowed for security reasons');
    }
  }

  // Additional check: reject hostnames that are just TLDs or single labels
  const labels = hostname.split('.');
  if (labels.length < 2) {
    throw new Error('Hostname must have at least two labels (subdomain.domain.tld)');
  }
}

// ============================================================================
// Git URL Validation
// ============================================================================

/**
 * Validate git URL with comprehensive security checks
 */
export function validateGitUrl(url: string): boolean {
  // Check for control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(url)) {
    return false;
  }

  // SSH format: git@host:path.git or git@host:path
  const sshPattern = /^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+(?:\.git)?$/;

  // SSH URL format: ssh://git@host/path
  const sshUrlPattern = /^ssh:\/\/git@[a-zA-Z0-9.-]+\/[a-zA-Z0-9._/-]+(?:\.git)?$/;

  // HTTPS format: https://host/path.git or https://host/path
  const httpsPattern = /^https?:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9._/-]+(?:\.git)?$/;

  // Git protocol: git://host/path
  const gitPattern = /^git:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9._/-]+(?:\.git)?$/;

  // File path (local): /path/to/repo or file:///path/to/repo
  if (url.startsWith('file://') || url.startsWith('/')) {
    return validateFileUrl(url);
  }

  // Check if it matches any valid pattern
  if (
    sshPattern.test(url) ||
    sshUrlPattern.test(url) ||
    httpsPattern.test(url) ||
    gitPattern.test(url)
  ) {
    // Additional check: no shell metacharacters
    if (/[;&|`$(){}[\]<>!#*?]/.test(url.replace(/[/:@.]/g, ''))) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Validate file:// URL with path traversal and sensitive path protection
 */
function validateFileUrl(url: string): boolean {
  // Extract path
  const path = url.replace(/^file:\/\//, '');

  // Block sensitive system paths
  const blockedPaths = getBlockedSystemPaths();
  for (const blockedPath of blockedPaths) {
    // Case-insensitive comparison for Windows
    if (IS_WINDOWS) {
      if (path.toLowerCase().startsWith(blockedPath.toLowerCase())) {
        return false;
      }
    } else {
      if (path.startsWith(blockedPath)) {
        return false;
      }
    }
  }

  // Block path traversal (both Unix and Windows style)
  if (
    path.includes('../') ||
    path.includes('/..') ||
    path.includes('..\\') ||
    path.includes('\\..')
  ) {
    return false;
  }

  // Require absolute paths
  if (IS_WINDOWS) {
    // Windows absolute path: drive letter (C:\, D:\, etc.) or UNC path (\\server\share)
    const hasDriveLetter = /^[A-Za-z]:[/\\]/.test(path);
    const isUncPath = path.startsWith('\\\\');

    if (!hasDriveLetter && !isUncPath) {
      return false;
    }

    // Validate UNC paths separately (\\server\share format)
    if (isUncPath) {
      // UNC path pattern: \\server\share followed by optional path
      // Server and share names can contain alphanumeric, dots, hyphens
      const uncPattern = /^\\\\[a-zA-Z0-9._-]+\\[a-zA-Z0-9._ -]+([/\\][a-zA-Z0-9._ /\\-]*)?$/;
      return uncPattern.test(path);
    }

    // Allow Windows paths with drive letters (spaces are common in Windows paths)
    const windowsFilePattern = /^[A-Za-z]:[/\\][a-zA-Z0-9._ /\\-]+$/;
    return windowsFilePattern.test(path);
  } else {
    if (!path.startsWith('/')) {
      return false;
    }
    // Basic path pattern for Unix
    const filePattern = /^\/[a-zA-Z0-9._/-]+$/;
    return filePattern.test(path);
  }
}

// ============================================================================
// Path and Input Validation
// ============================================================================

/**
 * Validate a file path for safety
 * @param path Path to validate
 * @throws Error if path is invalid
 */
export function validatePath(path: string): void {
  if (path === null || path === undefined) {
    throw new Error('Path is required');
  }

  if (typeof path !== 'string') {
    throw new Error('Path must be a string');
  }

  if (path.length === 0) {
    throw new Error('Path cannot be empty');
  }

  // Check for null bytes (security vulnerability)
  if (path.includes('\x00')) {
    throw new Error('Path contains null byte');
  }

  // Check for control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x01-\x1F\x7F]/.test(path)) {
    throw new Error('Path contains control characters');
  }

  // Check for RTL override characters (security vulnerability)
  if (/[\u202E\u202D\u202C\u202B\u202A]/.test(path)) {
    throw new Error('Path contains bidirectional override characters');
  }
}

/**
 * Validate a filename (not a path)
 * @param filename Filename to validate
 * @throws Error if filename is invalid
 */
export function validateFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename is required');
  }

  if (filename.length === 0) {
    throw new Error('Filename cannot be empty');
  }

  if (filename.length > 255) {
    throw new Error('Filename too long (max 255 characters)');
  }

  // Check for path separators
  if (filename.includes('/') || filename.includes('\\')) {
    throw new Error('Filename cannot contain path separators');
  }

  // Check for special directory names
  if (filename === '.' || filename === '..') {
    throw new Error('Invalid filename');
  }

  // Check for null bytes
  if (filename.includes('\x00')) {
    throw new Error('Filename contains null byte');
  }

  // Check for control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x01-\x1F\x7F]/.test(filename)) {
    throw new Error('Filename contains control characters');
  }
}

/**
 * Validate a configuration value
 * @param key Config key name
 * @param value Config value to validate
 * @throws Error if value is invalid
 */
export function validateConfigValue(key: string, value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`Config value for ${key} must be a string`);
  }

  if (value.length > 10000) {
    throw new Error(`Config value for ${key} too long (max 10000 characters)`);
  }

  // Check for shell metacharacters that could be used for injection
  const dangerousPatterns = [/;\s*rm\s/i, /&&\s*\w/, /\|\s*cat/i, /\$\(/, /`[^`]*`/];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(value)) {
      throw new Error(`Config value for ${key} contains potentially dangerous characters`);
    }
  }
}

/**
 * Sanitize user input
 * @param input Input string to sanitize
 * @returns Sanitized string
 */
export function sanitizeInput(input: string): string {
  if (input === null || input === undefined) {
    return '';
  }

  if (typeof input !== 'string') {
    return '';
  }

  // Remove null bytes and zero-width characters
  // NOTE: We use split().join() instead of regex.replace() to satisfy ESLint rules:
  // - no-control-regex: Disallows control characters in regex (like \x00)
  // - no-misleading-character-class: Warns about confusing character classes
  // This approach is slightly less performant but avoids lint warnings and is
  // more explicit about what characters are being removed.
  const nullChar = String.fromCharCode(0);
  let sanitized = input.split(nullChar).join('');

  // Zero-width characters: ZWSP, ZWNJ, ZWJ, BOM
  sanitized = sanitized
    .split('\u200B')
    .join('')
    .split('\u200C')
    .join('')
    .split('\u200D')
    .join('')
    .split('\uFEFF')
    .join('');

  // Trim whitespace
  sanitized = sanitized.trim();

  // Normalize unicode
  sanitized = sanitized.normalize('NFC');

  return sanitized;
}

// ============================================================================
// Error Message Utilities
// ============================================================================

/**
 * Safely extract an error message from an unknown error.
 * Prevents exposing sensitive information while providing useful debug info.
 *
 * @param error - The error to extract a message from (can be any type)
 * @param context - Optional context to prefix the message (e.g., "Failed to read file")
 * @returns A safe error message string
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   logger.debug(errorToMessage(error, 'Operation failed'));
 * }
 * ```
 */
export function errorToMessage(error: unknown, context?: string): string {
  let message: string;

  if (error instanceof Error) {
    // For known Error types, use the message
    message = error.message;

    // Truncate very long messages (e.g., stack traces accidentally included)
    if (message.length > 500) {
      message = message.slice(0, 500) + '...';
    }
  } else if (typeof error === 'string') {
    message = error.length > 500 ? error.slice(0, 500) + '...' : error;
  } else if (error === null) {
    message = 'null error';
  } else if (error === undefined) {
    message = 'undefined error';
  } else {
    // For objects or other types, be cautious
    try {
      const str = String(error);
      message = str.length > 500 ? str.slice(0, 500) + '...' : str;
    } catch {
      message = 'Unknown error (could not convert to string)';
    }
  }

  // Remove potential secrets from common patterns
  message = message
    .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/key[=:]\s*\S+/gi, 'key=[REDACTED]')
    .replace(/secret[=:]\s*\S+/gi, 'secret=[REDACTED]');

  return context ? `${context}: ${message}` : message;
}

/**
 * Sanitize error messages to prevent information disclosure
 * @param error Error object or string
 * @param genericMessage Generic message to show to users
 * @returns Sanitized error message
 */
export function sanitizeErrorMessage(error: unknown, genericMessage: string): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Detect common error types and provide appropriate messages
    if (message.includes('enotfound') || message.includes('network')) {
      return 'Network error. Please check your internet connection.';
    }
    if (message.includes('permission') || message.includes('eacces')) {
      return 'Permission denied. Please check your access rights.';
    }
    if (message.includes('timeout') || message.includes('etimedout')) {
      return 'Operation timed out. Please try again.';
    }
    if (message.includes('authentication') || message.includes('auth')) {
      return 'Authentication failed. Please check your credentials.';
    }

    // For other errors, use generic message
    return genericMessage;
  }

  return genericMessage;
}
