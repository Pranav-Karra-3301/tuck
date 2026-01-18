/**
 * Input Validation Utilities
 *
 * Centralized validation functions with security-hardened checks.
 */

// ============================================================================
// Constants
// ============================================================================

export const GIT_OPERATION_TIMEOUTS = {
  LS_REMOTE: 30000, // 30 seconds (increased from 10s)
  CLONE: 300000, // 5 minutes
  FETCH: 60000, // 1 minute
  PUSH: 60000, // 1 minute
} as const;

const BLOCKED_SYSTEM_PATHS = [
  '/etc/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/boot/',
  '/root/',
  '/var/run/',
  '/var/log/',
] as const;

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
export function validateRepoName(repoName: string, _provider: string): void {
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
  const validPattern = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?(?:\/[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)*$/;
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
      throw new Error('Invalid GitHub repository URL format. Expected: /owner/repo or /owner/repo.git');
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
  for (const blockedPath of BLOCKED_SYSTEM_PATHS) {
    if (path.startsWith(blockedPath)) {
      return false;
    }
  }

  // Block path traversal
  if (path.includes('../') || path.includes('/..')) {
    return false;
  }

  // Require absolute paths
  if (!path.startsWith('/')) {
    return false;
  }

  // Basic path pattern
  const filePattern = /^\/[a-zA-Z0-9._/-]+$/;
  return filePattern.test(path);
}

// ============================================================================
// Error Message Sanitization
// ============================================================================

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
