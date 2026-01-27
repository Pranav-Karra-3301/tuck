/**
 * Input Validation Security Tests
 *
 * These tests verify that user input is properly validated and sanitized
 * to prevent injection attacks and malformed input from causing issues.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import {
  sanitizeFilename,
  generateFileId,
  detectCategory,
  expandPath,
} from '../../src/lib/paths.js';
import {
  validatePath,
  validateFilename,
  validateConfigValue,
  sanitizeInput,
} from '../../src/lib/validation.js';
import { TEST_HOME } from '../setup.js';

describe('Input Validation Security', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // Path Validation Tests
  // ============================================================================

  describe('validatePath', () => {
    it('should accept valid paths', () => {
      const validPaths = [
        '~/.zshrc',
        '~/.config/nvim/init.lua',
        '~/Documents/notes.txt',
        '~/.gitconfig',
      ];

      for (const path of validPaths) {
        expect(() => validatePath(path)).not.toThrow();
      }
    });

    it('should reject empty paths', () => {
      expect(() => validatePath('')).toThrow();
    });

    it('should reject null/undefined', () => {
      expect(() => validatePath(null as unknown as string)).toThrow();
      expect(() => validatePath(undefined as unknown as string)).toThrow();
    });

    it('should reject paths with null bytes', () => {
      expect(() => validatePath('~/.config\x00evil')).toThrow();
    });

    it('should reject paths with control characters', () => {
      const controlChars = ['\x01', '\x02', '\x1f', '\x7f'];

      for (const char of controlChars) {
        expect(() => validatePath(`~/.config${char}file`)).toThrow();
      }
    });

    it('should handle paths with spaces', () => {
      expect(() => validatePath('~/My Documents/file.txt')).not.toThrow();
    });

    it('should handle unicode paths', () => {
      expect(() => validatePath('~/.config/app-\u00e9')).not.toThrow();
    });
  });

  // ============================================================================
  // Filename Validation Tests
  // ============================================================================

  describe('validateFilename', () => {
    it('should accept valid filenames', () => {
      const validNames = ['.zshrc', 'config.json', 'my-file.txt', 'file_name_123.md'];

      for (const name of validNames) {
        expect(() => validateFilename(name)).not.toThrow();
      }
    });

    it('should reject empty filenames', () => {
      expect(() => validateFilename('')).toThrow();
    });

    it('should reject filenames with path separators', () => {
      expect(() => validateFilename('dir/file.txt')).toThrow();
      expect(() => validateFilename('dir\\file.txt')).toThrow();
    });

    it('should reject special filenames', () => {
      expect(() => validateFilename('.')).toThrow();
      expect(() => validateFilename('..')).toThrow();
    });

    it('should reject filenames with null bytes', () => {
      expect(() => validateFilename('file\x00name')).toThrow();
    });

    it('should handle very long filenames', () => {
      const longName = 'a'.repeat(300);
      expect(() => validateFilename(longName)).toThrow();
    });
  });

  // ============================================================================
  // sanitizeFilename Tests
  // ============================================================================

  describe('sanitizeFilename', () => {
    it('should remove leading dots from dotfiles', () => {
      expect(sanitizeFilename('.zshrc')).toBe('zshrc');
      expect(sanitizeFilename('.gitconfig')).toBe('gitconfig');
    });

    it('should extract filename from path', () => {
      const result = sanitizeFilename('/home/user/.zshrc');
      expect(result).toBe('zshrc');
    });

    it('should handle filenames without dots', () => {
      expect(sanitizeFilename('Makefile')).toBe('Makefile');
    });

    it('should not produce empty results', () => {
      const result = sanitizeFilename('.');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // generateFileId Tests
  // ============================================================================

  describe('generateFileId', () => {
    it('should generate safe IDs', () => {
      const id = generateFileId('~/.config/nvim/init.lua');

      // Should only contain safe characters
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    it('should handle special characters', () => {
      const id = generateFileId('~/.config/app@2.0/config.json');

      // Should not contain special characters
      expect(id).not.toContain('@');
      expect(id).not.toMatch(/[^a-zA-Z0-9_-]/);
    });

    it('should generate unique IDs for different paths', () => {
      const id1 = generateFileId('~/.config/app1');
      const id2 = generateFileId('~/.config/app2');

      expect(id1).not.toBe(id2);
    });

    it('should handle empty path gracefully', () => {
      const id = generateFileId('');
      expect(typeof id).toBe('string');
    });
  });

  // ============================================================================
  // Config Value Validation
  // ============================================================================

  describe('validateConfigValue', () => {
    it('should accept valid config values', () => {
      const validValues = ['copy', 'symlink', 'main', 'true', 'false', '100'];

      for (const value of validValues) {
        expect(() => validateConfigValue('key', value)).not.toThrow();
      }
    });

    it('should reject values with shell metacharacters', () => {
      const dangerous = [
        'value; rm -rf /',
        'value && malicious',
        'value | cat /etc/passwd',
        '$(whoami)',
        '`id`',
      ];

      for (const value of dangerous) {
        expect(() => validateConfigValue('key', value)).toThrow();
      }
    });

    it('should reject values that are too long', () => {
      const longValue = 'a'.repeat(10001);
      expect(() => validateConfigValue('key', longValue)).toThrow();
    });
  });

  // ============================================================================
  // sanitizeInput Tests
  // ============================================================================

  describe('sanitizeInput', () => {
    it('should remove null bytes', () => {
      const result = sanitizeInput('hello\x00world');
      expect(result).not.toContain('\x00');
    });

    it('should trim whitespace', () => {
      const result = sanitizeInput('  hello  ');
      expect(result).toBe('hello');
    });

    it('should normalize unicode', () => {
      // NFC normalization test
      const composed = '\u00e9'; // é
      const decomposed = 'e\u0301'; // e + combining accent

      const result1 = sanitizeInput(composed);
      const result2 = sanitizeInput(decomposed);

      // Both should normalize to the same form
      expect(result1).toBe(result2);
    });

    it('should handle empty strings', () => {
      const result = sanitizeInput('');
      expect(result).toBe('');
    });

    it('should handle null/undefined', () => {
      expect(sanitizeInput(null as unknown as string)).toBe('');
      expect(sanitizeInput(undefined as unknown as string)).toBe('');
    });
  });

  // ============================================================================
  // Injection Attack Prevention
  // ============================================================================

  describe('Injection Attack Prevention', () => {
    const injectionPayloads = [
      // Command injection
      '; rm -rf /',
      '&& cat /etc/passwd',
      '| id',
      '$(whoami)',
      '`id`',

      // Path injection
      '../../../etc/passwd',
      '..\\..\\..\\Windows\\System32',

      // JSON injection
      '{"__proto__":{"admin":true}}',

      // Template injection
      '${process.env.SECRET}',
      '#{system("id")}',

      // SQL-like injection (shouldn't apply but good to test)
      "'; DROP TABLE users;--",
    ];

    injectionPayloads.forEach((payload) => {
      it(`should safely handle injection payload: ${payload.slice(0, 20)}...`, () => {
        // generateFileId should produce safe output
        const id = generateFileId(`~/config/${payload}`);
        expect(id).toMatch(/^[a-zA-Z0-9_-]*$/);

        // detectCategory should not execute anything
        expect(() => detectCategory(`~/config/${payload}`)).not.toThrow();
      });
    });
  });

  // ============================================================================
  // Unicode Edge Cases
  // ============================================================================

  describe('Unicode Edge Cases', () => {
    it('should handle right-to-left override characters', () => {
      // RLO can be used to disguise filenames
      const rtlPath = '~/.config/\u202Etxt.exe';

      // Should either reject or sanitize
      expect(() => validatePath(rtlPath)).toThrow();
    });

    it('should handle zero-width characters', () => {
      const zeroWidthPath = '~/.config/app\u200B\u200Cname';

      // Zero-width chars should be stripped or rejected
      const result = sanitizeInput(zeroWidthPath);
      expect(result).not.toMatch(/\u200B|\u200C/);
    });

    it('should handle homoglyph attacks', () => {
      // Cyrillic 'a' looks like Latin 'a'
      const homoglyphPath = '~/.config/\u0430pp'; // Cyrillic 'a'

      // This is tricky - may need to normalize or warn
      // At minimum, it should not cause security issues
      expect(() => expandPath(homoglyphPath)).not.toThrow();
    });
  });

  // ============================================================================
  // Array/Object Input Handling
  // ============================================================================

  describe('Non-String Input Handling', () => {
    it('should reject array inputs', () => {
      expect(() => validatePath(['~/.config'] as unknown as string)).toThrow();
    });

    it('should reject object inputs', () => {
      expect(() => validatePath({ path: '~/.config' } as unknown as string)).toThrow();
    });

    it('should handle number inputs', () => {
      expect(() => validatePath(123 as unknown as string)).toThrow();
    });

    it('should handle boolean inputs', () => {
      expect(() => validatePath(true as unknown as string)).toThrow();
    });
  });
});
