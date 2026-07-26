/**
 * Extended validation module unit tests
 *
 * Tests for path validation, filename validation, and input sanitization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the platform module to control IS_WINDOWS
const mockIsWindows = vi.fn();
vi.mock('../../src/lib/platform.js', () => ({
  get IS_WINDOWS() {
    return mockIsWindows();
  },
}));

describe('validation-extended', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });


  // ============================================================================
  // validateGitUrl - File URL Tests
  // ============================================================================

  describe('validateGitUrl - file URLs', () => {
    describe('Unix paths', () => {
      beforeEach(() => {
        mockIsWindows.mockReturnValue(false);
      });

      it('should accept valid file:// URLs', async () => {
        const { validateGitUrl } = await import('../../src/lib/validation.js');

        expect(validateGitUrl('file:///home/user/repo')).toBe(true);
        expect(validateGitUrl('/home/user/repo')).toBe(true);
      });

      it('should reject file URLs with path traversal', async () => {
        const { validateGitUrl } = await import('../../src/lib/validation.js');

        expect(validateGitUrl('file:///home/../etc/passwd')).toBe(false);
        expect(validateGitUrl('/home/../etc/passwd')).toBe(false);
      });

      it('should reject system paths on Unix', async () => {
        const { validateGitUrl } = await import('../../src/lib/validation.js');

        expect(validateGitUrl('/etc/passwd')).toBe(false);
        expect(validateGitUrl('/proc/self')).toBe(false);
        expect(validateGitUrl('/sys/kernel')).toBe(false);
      });
    });

    describe('Windows paths', () => {
      beforeEach(() => {
        mockIsWindows.mockReturnValue(true);
      });

      it('should reject Windows system paths', async () => {
        const { validateGitUrl } = await import('../../src/lib/validation.js');

        // System paths should be rejected
        expect(validateGitUrl('C:/Windows/System32')).toBe(false);
        expect(validateGitUrl('C:/Program Files/app')).toBe(false);
      });

      it('rejects a file:// drive-letter URL with a leading slash', async () => {
        const { validateGitUrl } = await import('../../src/lib/validation.js');

        // Stripping `file://` from 'file:///C:/...' leaves '/C:/Users/user/repo';
        // validateFileUrl requires the drive letter at the very start (no leading
        // slash), so this canonical file URI form is rejected. Pin that policy so a
        // change to the drive-letter guard is caught rather than silently accepted.
        expect(validateGitUrl('file:///C:/Users/user/repo')).toBe(false);
      });

      it('accepts a file:// drive-letter URL without a leading slash', async () => {
        const { validateGitUrl } = await import('../../src/lib/validation.js');

        // 'file://C:/...' strips to 'C:/Users/user/repo' which starts with a drive
        // letter, so it is accepted. Pins the accept side of the same policy.
        expect(validateGitUrl('file://C:/Users/user/repo')).toBe(true);
      });
    });
  });

  // ============================================================================
  // errorToMessage Tests - Additional Edge Cases
  // ============================================================================

  describe('errorToMessage - edge cases', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should handle Error with very long message', async () => {
      const { errorToMessage } = await import('../../src/lib/validation.js');

      const longMessage = 'x'.repeat(1000);
      const error = new Error(longMessage);
      const result = errorToMessage(error);

      expect(result.length).toBeLessThanOrEqual(503);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should handle very long string error', async () => {
      const { errorToMessage } = await import('../../src/lib/validation.js');

      const longString = 'error '.repeat(200);
      const result = errorToMessage(longString);

      expect(result.length).toBeLessThanOrEqual(503);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should redact secret= patterns', async () => {
      const { errorToMessage } = await import('../../src/lib/validation.js');

      const error = new Error('Config error: secret=mysupersecretvalue');
      const result = errorToMessage(error);

      expect(result).not.toContain('mysupersecretvalue');
      expect(result).toContain('[REDACTED]');
    });

    it('should handle object that cannot be converted to string', async () => {
      const { errorToMessage } = await import('../../src/lib/validation.js');

      const problematicObj = {
        toString() {
          throw new Error('Cannot convert to string');
        },
      };

      const result = errorToMessage(problematicObj);
      expect(result).toContain('Unknown error');
    });
  });

  // ============================================================================
  // sanitizeErrorMessage Tests - Additional Cases
  // ============================================================================

  describe('sanitizeErrorMessage - additional cases', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should handle network errors', async () => {
      const { sanitizeErrorMessage } = await import('../../src/lib/validation.js');

      const error = new Error('getaddrinfo ENOTFOUND github.com');
      const result = sanitizeErrorMessage(error, 'Generic failure');

      expect(result).toContain('Network error');
    });

    it('should handle permission errors', async () => {
      const { sanitizeErrorMessage } = await import('../../src/lib/validation.js');

      const error = new Error('EACCES: permission denied');
      const result = sanitizeErrorMessage(error, 'Generic failure');

      expect(result).toContain('Permission denied');
    });

    it('should handle timeout errors', async () => {
      const { sanitizeErrorMessage } = await import('../../src/lib/validation.js');

      const error = new Error('ETIMEDOUT: connection timed out');
      const result = sanitizeErrorMessage(error, 'Generic failure');

      expect(result).toContain('timed out');
    });

    it('should handle authentication errors', async () => {
      const { sanitizeErrorMessage } = await import('../../src/lib/validation.js');

      const error = new Error('Authentication failed: bad credentials');
      const result = sanitizeErrorMessage(error, 'Generic failure');

      expect(result).toContain('Authentication failed');
    });

    it('should return generic message for unknown errors', async () => {
      const { sanitizeErrorMessage } = await import('../../src/lib/validation.js');

      const error = new Error('Some random internal error details');
      const result = sanitizeErrorMessage(error, 'Something went wrong');

      expect(result).toBe('Something went wrong');
    });
  });
});
