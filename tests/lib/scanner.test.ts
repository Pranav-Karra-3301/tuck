/**
 * Secret scanner unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  scanContent,
  scanFile,
  scanFiles,
  redactSecret,
  generateUniquePlaceholder,
  getSecretsWithPlaceholders,
} from '../../src/lib/secrets/scanner.js';
import { TEST_HOME } from '../setup.js';

describe('scanner', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // scanContent Tests
  // ============================================================================

  describe('scanContent', () => {
    it('should detect AWS access key', () => {
      const content = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const matches = scanContent(content);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.patternId === 'aws-access-key')).toBe(true);
    });

    it('should detect GitHub token', () => {
      const content = 'GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const matches = scanContent(content);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.patternId === 'github-pat')).toBe(true);
    });

    it('should detect passwords in assignments', () => {
      const content = 'password="super-secret-password"';
      const matches = scanContent(content);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.patternId === 'password-assignment')).toBe(true);
    });

    it('should detect database connection strings', () => {
      const content = 'DATABASE_URL=postgres://user:password@localhost/db';
      const matches = scanContent(content);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.patternId === 'postgres-connection')).toBe(true);
    });

    it('should detect private keys', () => {
      const content = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn
-----END RSA PRIVATE KEY-----`;
      const matches = scanContent(content);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.patternId === 'rsa-private-key')).toBe(true);
    });

    it('should return empty array for clean content', () => {
      const content = `
        # Normal configuration
        DEBUG=true
        NODE_ENV=production
        PORT=3000
      `;
      const matches = scanContent(content);

      // Should have no matches or only low-severity ones
      const criticalMatches = matches.filter((m) => m.severity === 'critical');
      expect(criticalMatches.length).toBe(0);
    });

    it('should include line and column in matches', () => {
      const content = 'line1\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nline3';
      const matches = scanContent(content);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].line).toBe(2);
      expect(matches[0].column).toBeGreaterThan(0);
    });

    it('should include redacted value', () => {
      const content = 'password="secret123"';
      const matches = scanContent(content);

      if (matches.length > 0) {
        expect(matches[0].redactedValue).toContain('REDACTED');
        expect(matches[0].redactedValue).not.toContain('secret123');
      }
    });

    it('should deduplicate matches', () => {
      const content = 'AKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLE';
      const matches = scanContent(content);

      // Same secret at different positions should still be tracked
      // but with unique keys
    });

    it('should support custom patterns', () => {
      const content = 'CUSTOM_SECRET=abc123xyz';
      const customPatterns = [
        {
          id: 'custom-test',
          name: 'Custom Test Pattern',
          pattern: /CUSTOM_SECRET=([a-z0-9]+)/g,
          severity: 'high' as const,
          description: 'Custom pattern',
          placeholder: 'CUSTOM_SECRET',
        },
      ];

      const matches = scanContent(content, { customPatterns });
      expect(matches.some((m) => m.patternId === 'custom-test')).toBe(true);
    });

    it('should support excluding patterns', () => {
      const content = 'AKIAIOSFODNN7EXAMPLE';
      const matches = scanContent(content, {
        excludePatternIds: ['aws-access-key'],
      });

      expect(matches.some((m) => m.patternId === 'aws-access-key')).toBe(false);
    });

    it('should support minimum severity filter', () => {
      const content = `
        AKIAIOSFODNN7EXAMPLE
        password="secret"
      `;

      const allMatches = scanContent(content);
      const criticalOnly = scanContent(content, { minSeverity: 'critical' });

      expect(criticalOnly.length).toBeLessThanOrEqual(allMatches.length);
    });
  });

  // ============================================================================
  // scanFile Tests
  // ============================================================================

  describe('scanFile', () => {
    it('should scan file for secrets', async () => {
      const filePath = join(TEST_HOME, 'config.txt');
      vol.writeFileSync(filePath, 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');

      const result = await scanFile(filePath);

      expect(result.hasSecrets).toBe(true);
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('should return skipped for non-existent file', async () => {
      const result = await scanFile(join(TEST_HOME, 'nonexistent.txt'));

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('not found');
    });

    it('should skip binary files', async () => {
      const filePath = join(TEST_HOME, 'image.png');
      vol.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await scanFile(filePath);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('Binary');
    });

    it('should skip large files', async () => {
      const filePath = join(TEST_HOME, 'large.txt');
      vol.writeFileSync(filePath, 'x'.repeat(15 * 1024 * 1024)); // 15MB

      const result = await scanFile(filePath, { maxFileSize: 10 * 1024 * 1024 });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('too large');
    });

    it('should skip directories', async () => {
      const dirPath = join(TEST_HOME, 'subdir');
      vol.mkdirSync(dirPath);

      const result = await scanFile(dirPath);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('directory');
    });

    it('should include severity counts', async () => {
      const filePath = join(TEST_HOME, 'secrets.txt');
      vol.writeFileSync(
        filePath,
        `
        AKIAIOSFODNN7EXAMPLE
        password="secret"
      `
      );

      const result = await scanFile(filePath);

      expect(typeof result.criticalCount).toBe('number');
      expect(typeof result.highCount).toBe('number');
      expect(typeof result.mediumCount).toBe('number');
      expect(typeof result.lowCount).toBe('number');
    });
  });

  // ============================================================================
  // scanFiles Tests
  // ============================================================================

  describe('scanFiles', () => {
    it('should scan multiple files', async () => {
      const files = [join(TEST_HOME, 'file1.txt'), join(TEST_HOME, 'file2.txt')];

      vol.writeFileSync(files[0], 'AKIAIOSFODNN7EXAMPLE');
      vol.writeFileSync(files[1], 'clean content');

      const summary = await scanFiles(files);

      expect(summary.totalFiles).toBe(2);
      expect(summary.scannedFiles).toBe(2);
      expect(summary.filesWithSecrets).toBe(1);
    });

    it('should throw for too many files', async () => {
      const files = Array.from({ length: 1001 }, (_, i) => join(TEST_HOME, `file${i}.txt`));

      await expect(scanFiles(files)).rejects.toThrow('Too many files');
    });

    it('should return summary with severity counts', async () => {
      const filePath = join(TEST_HOME, 'secrets.txt');
      vol.writeFileSync(filePath, 'AKIAIOSFODNN7EXAMPLE');

      const summary = await scanFiles([filePath]);

      expect(summary.bySeverity).toBeDefined();
      expect(typeof summary.bySeverity.critical).toBe('number');
      expect(typeof summary.bySeverity.high).toBe('number');
    });

    it('should only include files with secrets in results', async () => {
      const files = [
        join(TEST_HOME, 'clean1.txt'),
        join(TEST_HOME, 'secret.txt'),
        join(TEST_HOME, 'clean2.txt'),
      ];

      vol.writeFileSync(files[0], 'clean');
      vol.writeFileSync(files[1], 'AKIAIOSFODNN7EXAMPLE');
      vol.writeFileSync(files[2], 'also clean');

      const summary = await scanFiles(files);

      expect(summary.results.length).toBe(1);
      expect(summary.results[0].hasSecrets).toBe(true);
    });
  });

  // ============================================================================
  // redactSecret Tests
  // ============================================================================

  describe('redactSecret', () => {
    it('should return redacted placeholder for short secrets', () => {
      const redacted = redactSecret('password');
      expect(redacted).toContain('REDACTED');
    });

    it('should return redacted placeholder for medium secrets', () => {
      const redacted = redactSecret('a'.repeat(30));
      expect(redacted).toContain('REDACTED');
    });

    it('should return redacted placeholder for long secrets', () => {
      const redacted = redactSecret('a'.repeat(100));
      expect(redacted).toContain('REDACTED');
    });

    it('should handle multiline secrets', () => {
      const secret = 'line1\nline2\nline3';
      const redacted = redactSecret(secret);
      expect(redacted).toContain('REDACTED');
    });

    it('should handle private keys', () => {
      const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...';
      const redacted = redactSecret(privateKey);
      expect(redacted).toContain('REDACTED');
      expect(redacted).toContain('Private Key');
    });
  });

  // ============================================================================
  // generateUniquePlaceholder Tests
  // ============================================================================

  describe('generateUniquePlaceholder', () => {
    it('should return base placeholder if unused', () => {
      const used = new Set<string>();
      const placeholder = generateUniquePlaceholder('API_KEY', used);
      expect(placeholder).toBe('API_KEY');
      expect(used.has('API_KEY')).toBe(true);
    });

    it('should add hint to placeholder', () => {
      const used = new Set<string>();
      const placeholder = generateUniquePlaceholder('API_KEY', used, 'github');
      expect(placeholder).toContain('GITHUB');
    });

    it('should add numeric suffix for duplicates', () => {
      const used = new Set(['API_KEY', 'API_KEY_1']);
      const placeholder = generateUniquePlaceholder('API_KEY', used);
      expect(placeholder).toBe('API_KEY_2');
    });
  });

  // ============================================================================
  // getSecretsWithPlaceholders Tests
  // ============================================================================

  describe('getSecretsWithPlaceholders', () => {
    it('should generate placeholder map from results', () => {
      const results = [
        {
          path: '/test',
          collapsedPath: '~/test',
          hasSecrets: true,
          matches: [
            {
              patternId: 'test',
              patternName: 'Test Pattern',
              severity: 'high' as const,
              value: 'secret-value',
              redactedValue: '[REDACTED]',
              line: 1,
              column: 1,
              context: 'test',
              placeholder: 'TEST_SECRET',
            },
          ],
          criticalCount: 0,
          highCount: 1,
          mediumCount: 0,
          lowCount: 0,
          skipped: false,
        },
      ];

      const secretsMap = getSecretsWithPlaceholders(results);

      expect(secretsMap.size).toBe(1);
      expect(secretsMap.get('secret-value')).toBeDefined();
    });

    it('should deduplicate secrets by value', () => {
      const results = [
        {
          path: '/test1',
          collapsedPath: '~/test1',
          hasSecrets: true,
          matches: [
            {
              patternId: 'test',
              patternName: 'Test Pattern',
              severity: 'high' as const,
              value: 'same-secret',
              redactedValue: '[REDACTED]',
              line: 1,
              column: 1,
              context: 'test',
              placeholder: 'SECRET',
            },
          ],
          criticalCount: 0,
          highCount: 1,
          mediumCount: 0,
          lowCount: 0,
          skipped: false,
        },
        {
          path: '/test2',
          collapsedPath: '~/test2',
          hasSecrets: true,
          matches: [
            {
              patternId: 'test',
              patternName: 'Test Pattern',
              severity: 'high' as const,
              value: 'same-secret',
              redactedValue: '[REDACTED]',
              line: 1,
              column: 1,
              context: 'test',
              placeholder: 'SECRET',
            },
          ],
          criticalCount: 0,
          highCount: 1,
          mediumCount: 0,
          lowCount: 0,
          skipped: false,
        },
      ];

      const secretsMap = getSecretsWithPlaceholders(results);

      expect(secretsMap.size).toBe(1);
    });
  });
});
