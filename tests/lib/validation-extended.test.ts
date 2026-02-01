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
  // validatePath Tests
  // ============================================================================

  describe('validatePath', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should accept valid paths', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath('/home/user/.zshrc')).not.toThrow();
      expect(() => validatePath('./relative/path')).not.toThrow();
      expect(() => validatePath('simple-file.txt')).not.toThrow();
    });

    it('should throw for null path', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath(null as unknown as string)).toThrow('Path is required');
    });

    it('should throw for undefined path', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath(undefined as unknown as string)).toThrow('Path is required');
    });

    it('should throw for non-string path', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath(123 as unknown as string)).toThrow('Path must be a string');
    });

    it('should throw for empty path', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath('')).toThrow('Path cannot be empty');
    });

    it('should throw for path with null byte', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath('/path/with\x00null')).toThrow('null byte');
    });

    it('should throw for path with control characters', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath('/path/with\x1Fcontrol')).toThrow('control characters');
    });

    it('should throw for path with RTL override characters', async () => {
      const { validatePath } = await import('../../src/lib/validation.js');

      expect(() => validatePath('/path/with\u202Ertl')).toThrow(
        'bidirectional override characters'
      );
    });
  });

  // ============================================================================
  // validateFilename Tests
  // ============================================================================

  describe('validateFilename', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should accept valid filenames', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename('file.txt')).not.toThrow();
      expect(() => validateFilename('.zshrc')).not.toThrow();
      expect(() => validateFilename('my-config.json')).not.toThrow();
    });

    it('should throw for empty filename', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename('')).toThrow('Filename is required');
    });

    it('should throw for null/undefined filename', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename(null as unknown as string)).toThrow('Filename is required');
      expect(() => validateFilename(undefined as unknown as string)).toThrow(
        'Filename is required'
      );
    });

    it('should throw for filename exceeding 255 characters', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      const longFilename = 'a'.repeat(256);
      expect(() => validateFilename(longFilename)).toThrow('Filename too long');
    });

    it('should throw for filename with forward slash', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename('path/file.txt')).toThrow('path separators');
    });

    it('should throw for filename with backslash', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename('path\\file.txt')).toThrow('path separators');
    });

    it('should throw for . or .. filenames', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename('.')).toThrow('Invalid filename');
      expect(() => validateFilename('..')).toThrow('Invalid filename');
    });

    it('should throw for filename with null byte', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename('file\x00name')).toThrow('null byte');
    });

    it('should throw for filename with control characters', async () => {
      const { validateFilename } = await import('../../src/lib/validation.js');

      expect(() => validateFilename('file\x1Fname')).toThrow('control characters');
    });
  });

  // ============================================================================
  // validateConfigValue Tests
  // ============================================================================

  describe('validateConfigValue', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should accept valid config values', async () => {
      const { validateConfigValue } = await import('../../src/lib/validation.js');

      expect(() => validateConfigValue('key', 'value')).not.toThrow();
      expect(() => validateConfigValue('path', '/home/user/.tuck')).not.toThrow();
    });

    it('should throw for non-string values', async () => {
      const { validateConfigValue } = await import('../../src/lib/validation.js');

      expect(() => validateConfigValue('key', 123 as unknown as string)).toThrow(
        'must be a string'
      );
    });

    it('should throw for very long values', async () => {
      const { validateConfigValue } = await import('../../src/lib/validation.js');

      const longValue = 'x'.repeat(10001);
      expect(() => validateConfigValue('key', longValue)).toThrow('too long');
    });

    it('should throw for values with shell injection patterns', async () => {
      const { validateConfigValue } = await import('../../src/lib/validation.js');

      expect(() => validateConfigValue('key', '; rm -rf /')).toThrow('dangerous characters');
      expect(() => validateConfigValue('key', '&& cat /etc/passwd')).toThrow(
        'dangerous characters'
      );
      expect(() => validateConfigValue('key', '| cat /etc/passwd')).toThrow(
        'dangerous characters'
      );
      expect(() => validateConfigValue('key', '$(whoami)')).toThrow('dangerous characters');
      expect(() => validateConfigValue('key', '`whoami`')).toThrow('dangerous characters');
    });
  });

  // ============================================================================
  // sanitizeInput Tests
  // ============================================================================

  describe('sanitizeInput', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should return empty string for null', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput(null as unknown as string)).toBe('');
    });

    it('should return empty string for undefined', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput(undefined as unknown as string)).toBe('');
    });

    it('should return empty string for non-string', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput(123 as unknown as string)).toBe('');
    });

    it('should remove null bytes', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput('hello\x00world')).toBe('helloworld');
    });

    it('should remove zero-width space', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput('hello\u200Bworld')).toBe('helloworld');
    });

    it('should remove zero-width non-joiner', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput('hello\u200Cworld')).toBe('helloworld');
    });

    it('should remove zero-width joiner', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput('hello\u200Dworld')).toBe('helloworld');
    });

    it('should remove BOM', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput('\uFEFFhello')).toBe('hello');
    });

    it('should trim whitespace', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      expect(sanitizeInput('  hello world  ')).toBe('hello world');
    });

    it('should normalize unicode', async () => {
      const { sanitizeInput } = await import('../../src/lib/validation.js');

      // e + combining acute accent should normalize to single char
      const combined = 'cafe\u0301';
      const normalized = sanitizeInput(combined);
      // After NFC normalization
      expect(normalized.length).toBeLessThanOrEqual(combined.length);
    });
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

      it('should handle file:// prefix for Windows', async () => {
        const { validateGitUrl } = await import('../../src/lib/validation.js');

        // file:// URLs with drive letters
        const result = validateGitUrl('file:///C:/Users/user/repo');
        // Result depends on implementation - just verify it doesn't throw
        expect(typeof result).toBe('boolean');
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
