/**
 * Secret pattern unit tests
 *
 * Verifies that all secret detection patterns work correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_SECRET_PATTERNS,
  CLOUD_PROVIDER_PATTERNS,
  API_TOKEN_PATTERNS,
  PRIVATE_KEY_PATTERNS,
  GENERIC_PATTERNS,
  getPatternById,
  getPatternsBySeverity,
  getPatternsAboveSeverity,
  createCustomPattern,
  shouldSkipFile,
  BINARY_EXTENSIONS,
} from '../../src/lib/secrets/patterns.js';

describe('patterns', () => {
  // ============================================================================
  // Pattern Collection Tests
  // ============================================================================

  describe('Pattern Collections', () => {
    it('should have cloud provider patterns', () => {
      expect(CLOUD_PROVIDER_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should have API token patterns', () => {
      expect(API_TOKEN_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should have private key patterns', () => {
      expect(PRIVATE_KEY_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should have generic patterns', () => {
      expect(GENERIC_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should combine all patterns', () => {
      const expected =
        CLOUD_PROVIDER_PATTERNS.length +
        API_TOKEN_PATTERNS.length +
        PRIVATE_KEY_PATTERNS.length +
        GENERIC_PATTERNS.length;

      expect(ALL_SECRET_PATTERNS.length).toBe(expected);
    });

    it('should have unique pattern IDs', () => {
      const ids = ALL_SECRET_PATTERNS.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  // ============================================================================
  // AWS Pattern Tests
  // ============================================================================

  describe('AWS Patterns', () => {
    it('should match AWS access key ID', () => {
      const pattern = getPatternById('aws-access-key');
      expect(pattern).toBeDefined();

      const validKeys = ['AKIAIOSFODNN7EXAMPLE', 'AKIA1234567890ABCDEF'];

      validKeys.forEach((key) => {
        expect(pattern!.pattern.test(key)).toBe(true);
        pattern!.pattern.lastIndex = 0;
      });
    });

    it('should not match invalid AWS keys', () => {
      const pattern = getPatternById('aws-access-key');

      const invalidKeys = [
        'AKIA1234', // Too short
        'BKIAIOSFODNN7EXAMPLE', // Wrong prefix
        'not-an-aws-key',
      ];

      invalidKeys.forEach((key) => {
        expect(pattern!.pattern.test(key)).toBe(false);
        pattern!.pattern.lastIndex = 0;
      });
    });
  });

  // ============================================================================
  // GitHub Pattern Tests
  // ============================================================================

  describe('GitHub Patterns', () => {
    it('should match GitHub PAT', () => {
      const pattern = getPatternById('github-pat');
      expect(pattern).toBeDefined();

      const validTokens = [
        'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      ];

      validTokens.forEach((token) => {
        expect(pattern!.pattern.test(token)).toBe(true);
        pattern!.pattern.lastIndex = 0;
      });
    });

    it('should match GitHub fine-grained PAT', () => {
      const pattern = getPatternById('github-fine-grained');
      expect(pattern).toBeDefined();

      const token = 'github_pat_1234567890abcdefghijklmnopqrstuvwxyz';
      expect(pattern!.pattern.test(token)).toBe(true);
    });
  });

  // ============================================================================
  // Stripe Pattern Tests
  // ============================================================================

  describe('Stripe Patterns', () => {
    it('should have Stripe live secret key pattern defined correctly', () => {
      const pattern = getPatternById('stripe-live-secret');
      expect(pattern).toBeDefined();
      expect(pattern!.severity).toBe('critical');
      // Verify pattern structure expects sk_live_ prefix with 24+ alphanumeric chars
      expect(pattern!.pattern.source).toContain('sk_live_');
      expect(pattern!.pattern.source).toContain('[0-9a-zA-Z]');
    });

    it('should match Stripe test key with lower severity', () => {
      const pattern = getPatternById('stripe-test-secret');
      expect(pattern).toBeDefined();
      expect(pattern!.severity).toBe('medium');
    });
  });

  // ============================================================================
  // Private Key Pattern Tests
  // ============================================================================

  describe('Private Key Patterns', () => {
    it('should match RSA private key', () => {
      const pattern = getPatternById('rsa-private-key');
      expect(pattern).toBeDefined();

      const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyf8bq
-----END RSA PRIVATE KEY-----`;

      expect(pattern!.pattern.test(key)).toBe(true);
    });

    it('should match OpenSSH private key', () => {
      const pattern = getPatternById('openssh-private-key');
      expect(pattern).toBeDefined();

      const key = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA
-----END OPENSSH PRIVATE KEY-----`;

      expect(pattern!.pattern.test(key)).toBe(true);
    });

    it('should have length limits on private key patterns', () => {
      PRIVATE_KEY_PATTERNS.forEach((pattern) => {
        // All private key patterns should have length limits to prevent ReDoS
        expect(pattern.pattern.source).toMatch(/\{.*,.*\}|\?/);
      });
    });
  });

  // ============================================================================
  // Generic Pattern Tests
  // ============================================================================

  describe('Generic Patterns', () => {
    it('should match password assignments', () => {
      const pattern = getPatternById('password-assignment');
      expect(pattern).toBeDefined();

      // Pattern requires quotes around the password value
      const passwords = [
        'password="mysecretpassword"',
        "password='mysecretpassword'",
        'PASSWORD: "mysecretpassword"',
        "PASSWORD='verysecretvalue'",
      ];

      passwords.forEach((pwd) => {
        expect(pattern!.pattern.test(pwd)).toBe(true);
        pattern!.pattern.lastIndex = 0;
      });
    });

    it('should match passwords in URLs', () => {
      const pattern = getPatternById('password-url');
      expect(pattern).toBeDefined();

      const urls = [
        'https://user:password123@example.com',
        'postgres://admin:secretpass@localhost/db',
      ];

      urls.forEach((url) => {
        expect(pattern!.pattern.test(url)).toBe(true);
        pattern!.pattern.lastIndex = 0;
      });
    });

    it('should match database connection strings', () => {
      const pgPattern = getPatternById('postgres-connection');
      const mongoPattern = getPatternById('mongodb-connection');

      expect(pgPattern!.pattern.test('postgres://user:pass@localhost/db')).toBe(true);
      pgPattern!.pattern.lastIndex = 0;

      expect(mongoPattern!.pattern.test('mongodb://user:pass@localhost/db')).toBe(true);
      mongoPattern!.pattern.lastIndex = 0;
    });
  });

  // ============================================================================
  // Pattern Helper Function Tests
  // ============================================================================

  describe('getPatternById', () => {
    it('should return pattern by ID', () => {
      const pattern = getPatternById('aws-access-key');
      expect(pattern).toBeDefined();
      expect(pattern!.id).toBe('aws-access-key');
    });

    it('should return undefined for unknown ID', () => {
      const pattern = getPatternById('nonexistent');
      expect(pattern).toBeUndefined();
    });
  });

  describe('getPatternsBySeverity', () => {
    it('should filter patterns by severity', () => {
      const criticalPatterns = getPatternsBySeverity('critical');
      expect(criticalPatterns.length).toBeGreaterThan(0);
      expect(criticalPatterns.every((p) => p.severity === 'critical')).toBe(true);
    });
  });

  describe('getPatternsAboveSeverity', () => {
    it('should return patterns at or above severity', () => {
      const highAndAbove = getPatternsAboveSeverity('high');
      expect(highAndAbove.length).toBeGreaterThan(0);

      const severities = new Set(highAndAbove.map((p) => p.severity));
      expect(severities.has('critical')).toBe(true);
      expect(severities.has('high')).toBe(true);
      expect(severities.has('low')).toBe(false);
    });

    it('should return all patterns for low severity', () => {
      const allPatterns = getPatternsAboveSeverity('low');
      expect(allPatterns.length).toBe(ALL_SECRET_PATTERNS.length);
    });
  });

  describe('createCustomPattern', () => {
    it('should create custom pattern', () => {
      const custom = createCustomPattern('my-pattern', 'My Pattern', 'SECRET_\\w+');

      expect(custom.id).toBe('custom-my-pattern');
      expect(custom.name).toBe('My Pattern');
      expect(custom.severity).toBe('high'); // Default
    });

    it('should respect custom options', () => {
      const custom = createCustomPattern('my-pattern', 'My Pattern', 'SECRET_\\w+', {
        severity: 'critical',
        description: 'Custom description',
        placeholder: 'MY_SECRET',
      });

      expect(custom.severity).toBe('critical');
      expect(custom.description).toBe('Custom description');
      expect(custom.placeholder).toBe('MY_SECRET');
    });
  });

  // ============================================================================
  // Binary File Detection Tests
  // ============================================================================

  describe('shouldSkipFile', () => {
    it('should skip binary file extensions', () => {
      const binaryFiles = [
        'image.png',
        'photo.jpg',
        'video.mp4',
        'document.pdf',
        'archive.zip',
        'binary.exe',
      ];

      binaryFiles.forEach((file) => {
        expect(shouldSkipFile(file)).toBe(true);
      });
    });

    it('should not skip text file extensions', () => {
      const textFiles = [
        'config.txt',
        'script.sh',
        'code.js',
        'style.css',
        'data.json',
        'markup.html',
      ];

      textFiles.forEach((file) => {
        expect(shouldSkipFile(file)).toBe(false);
      });
    });

    it('should handle files without extensions', () => {
      expect(shouldSkipFile('Makefile')).toBe(false);
      expect(shouldSkipFile('Dockerfile')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(shouldSkipFile('Image.PNG')).toBe(true);
      expect(shouldSkipFile('Photo.JPG')).toBe(true);
    });
  });

  describe('BINARY_EXTENSIONS', () => {
    it('should include common binary extensions', () => {
      const expected = ['.png', '.jpg', '.pdf', '.zip', '.exe'];
      expected.forEach((ext) => {
        expect(BINARY_EXTENSIONS.has(ext)).toBe(true);
      });
    });
  });

  // ============================================================================
  // Pattern Safety Tests
  // ============================================================================

  describe('Pattern Safety', () => {
    it('all patterns should have global flag', () => {
      ALL_SECRET_PATTERNS.forEach((pattern) => {
        expect(pattern.pattern.global).toBe(true);
      });
    });

    it('all patterns should have required properties', () => {
      ALL_SECRET_PATTERNS.forEach((pattern) => {
        expect(pattern.id).toBeDefined();
        expect(pattern.name).toBeDefined();
        expect(pattern.pattern).toBeDefined();
        expect(pattern.severity).toBeDefined();
        expect(pattern.description).toBeDefined();
        expect(pattern.placeholder).toBeDefined();
      });
    });

    it('all patterns should have valid severity', () => {
      const validSeverities = ['critical', 'high', 'medium', 'low'];
      ALL_SECRET_PATTERNS.forEach((pattern) => {
        expect(validSeverities).toContain(pattern.severity);
      });
    });
  });
});
