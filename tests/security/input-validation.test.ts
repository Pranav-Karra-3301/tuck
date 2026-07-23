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
        // generateFileId should produce safe, NON-EMPTY output. The `+`
        // quantifier (not `*`) and the explicit length check ensure an
        // injection path that collapsed the id to '' would fail this test
        // rather than pass vacuously.
        const id = generateFileId(`~/config/${payload}`);
        expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(id.length).toBeGreaterThan(0);

        // detectCategory should not execute anything
        expect(() => detectCategory(`~/config/${payload}`)).not.toThrow();
      });
    });
  });

  // ============================================================================
  // Unicode Edge Cases
  // ============================================================================

  describe('Unicode Edge Cases', () => {
    it('should handle homoglyph attacks', () => {
      // Cyrillic 'a' looks like Latin 'a'
      const homoglyphPath = '~/.config/\u0430pp'; // Cyrillic 'a'

      // This is tricky - may need to normalize or warn
      // At minimum, it should not cause security issues
      expect(() => expandPath(homoglyphPath)).not.toThrow();
    });
  });

});
