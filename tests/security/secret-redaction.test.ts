/**
 * Secret Redaction Security Tests
 *
 * These tests verify that secrets are properly redacted and never
 * exposed in logs, error messages, or user-facing output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import {
  redactSecret,
  scanContent,
  scanFile,
  getSecretsWithPlaceholders,
} from '../../src/lib/secrets/scanner.js';
import { TEST_HOME } from '../setup.js';

describe('Secret Redaction Security', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // redactSecret Function Tests
  // ============================================================================

  describe('redactSecret', () => {
    it('should never expose actual secret characters', () => {
      const secrets = [
        'my-super-secret-password-123',
        'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        'AKIAIOSFODNN7EXAMPLE',
        'sk-1234567890abcdef1234567890abcdef',
      ];

      for (const secret of secrets) {
        const redacted = redactSecret(secret);

        // Should not contain any substring of the secret longer than 3 chars
        for (let i = 0; i < secret.length - 3; i++) {
          const substring = secret.slice(i, i + 4);
          expect(redacted).not.toContain(substring);
        }
      }
    });

    it('should return consistent redaction format', () => {
      const shortSecret = 'password';
      const mediumSecret = 'my-medium-length-secret-key';
      const longSecret = 'a'.repeat(100);

      expect(redactSecret(shortSecret)).toMatch(/^\[REDACTED.*\]$/);
      expect(redactSecret(mediumSecret)).toMatch(/^\[REDACTED.*\]$/);
      expect(redactSecret(longSecret)).toMatch(/^\[REDACTED.*\]$/);
    });

    it('should handle private key content', () => {
      const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyf8bqMxLwOdGrF4Z...
-----END RSA PRIVATE KEY-----`;

      const redacted = redactSecret(privateKey);

      // Should not contain actual key content
      expect(redacted).not.toContain('MIIEpAIBAAKCAQEA');
      expect(redacted).toContain('REDACTED');
    });

    it('should handle multiline secrets', () => {
      const multilineSecret = 'line1\nline2\nline3';
      const redacted = redactSecret(multilineSecret);

      expect(redacted).not.toContain('line1');
      expect(redacted).not.toContain('line2');
      expect(redacted).toContain('REDACTED');
    });

    it('should not leak information through redaction length', () => {
      // Redaction should not reveal secret length too precisely
      const short = 'short123';
      const long = 'a'.repeat(500);

      const redactedShort = redactSecret(short);
      const redactedLong = redactSecret(long);

      // Both should use generic indicators
      expect(redactedShort.length).toBeLessThan(50);
      expect(redactedLong.length).toBeLessThan(50);
    });
  });

  // ============================================================================
  // scanContent Redaction Tests
  // ============================================================================

  describe('scanContent - Redaction in Results', () => {
    it('should redact secrets in match results', () => {
      const content = `
        export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
        export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
      `;

      const matches = scanContent(content);

      for (const match of matches) {
        // The redactedValue should never contain the actual secret
        expect(match.redactedValue).not.toBe(match.value);
        expect(match.redactedValue).toContain('REDACTED');

        // Context should also be redacted
        expect(match.context).not.toContain(match.value);
      }
    });

    it('should redact secrets in context lines', () => {
      const apiKey = 'sk-1234567890abcdef1234567890abcdef';
      const content = `
        # API Configuration
        API_KEY="${apiKey}"
        DEBUG=false
      `;

      const matches = scanContent(content);

      for (const match of matches) {
        // Context should not expose the secret
        expect(match.context).not.toContain(apiKey);
      }
    });

    it('should handle partial secret exposure in context', () => {
      const secret = 'super-secret-value-12345';
      const content = `config: ${secret}`;

      const matches = scanContent(content);

      // Even partial secrets in context should be redacted
      for (const match of matches) {
        const secretParts = secret.match(/.{1,8}/g) || [];
        for (const part of secretParts) {
          if (part.length > 4) {
            expect(match.context).not.toContain(part);
          }
        }
      }
    });
  });

  // ============================================================================
  // Console Output Safety
  // ============================================================================

  describe('Console Output Safety', () => {
    it('should not log raw secrets', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = `
        password="super-secret-123"
        api_key="ghp_realtoken12345678901234567890123456"
      `;

      scanContent(content);

      // Check that any console output does not contain secrets
      for (const call of consoleWarnSpy.mock.calls) {
        const output = call.join(' ');
        expect(output).not.toContain('super-secret-123');
        expect(output).not.toContain('ghp_realtoken');
      }

      consoleWarnSpy.mockRestore();
    });
  });

  // ============================================================================
  // Error Message Safety
  // ============================================================================

  describe('Error Message Safety', () => {
    it('should not include secrets in error messages', async () => {
      const filePath = join(TEST_HOME, 'secret-file.txt');
      vol.writeFileSync(filePath, 'api_key="secret_value_here"');

      try {
        const result = await scanFile(filePath);

        // Even in results, actual values should be redacted in user-facing fields
        for (const match of result.matches) {
          expect(match.redactedValue).not.toBe(match.value);
        }
      } catch (error) {
        // Any error message should not contain the secret
        expect(String(error)).not.toContain('secret_value_here');
      }
    });
  });

  // ============================================================================
  // getSecretsWithPlaceholders Tests
  // ============================================================================

  describe('getSecretsWithPlaceholders', () => {
    it('should generate safe placeholders', () => {
      const content = `
        AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
        password="my-secret-password"
      `;

      const matches = scanContent(content);
      const results = [
        {
          path: '/test',
          collapsedPath: '~/test',
          hasSecrets: true,
          matches,
          criticalCount: 1,
          highCount: 1,
          mediumCount: 0,
          lowCount: 0,
          skipped: false,
        },
      ];

      const secretsMap = getSecretsWithPlaceholders(results);

      // Placeholders should not contain actual secret values
      for (const [secret, info] of secretsMap) {
        expect(info.placeholder).not.toContain(secret);
        expect(info.placeholder).toMatch(/^[A-Z_]+$/);
      }
    });

    it('should generate unique placeholders for duplicates', () => {
      // When same pattern matches multiple times, placeholders should be unique
      const content = `
        API_KEY_1="key-one-value"
        API_KEY_2="key-two-value"
      `;

      const matches = scanContent(content);
      const results = [
        {
          path: '/test',
          collapsedPath: '~/test',
          hasSecrets: true,
          matches,
          criticalCount: 0,
          highCount: matches.length,
          mediumCount: 0,
          lowCount: 0,
          skipped: false,
        },
      ];

      const secretsMap = getSecretsWithPlaceholders(results);
      const placeholders = Array.from(secretsMap.values()).map((v) => v.placeholder);
      const uniquePlaceholders = new Set(placeholders);

      expect(placeholders.length).toBe(uniquePlaceholders.size);
    });
  });

  // ============================================================================
  // Known Secret Pattern Coverage
  // ============================================================================

  describe('Known Secret Patterns Are Redacted', () => {
    const secretPatterns = [
      { name: 'AWS Access Key', value: 'AKIAIOSFODNN7EXAMPLE' },
      { name: 'GitHub PAT', value: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      {
        name: 'OpenAI Key',
        value:
          'sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      },
      // Note: Using fake patterns that don't trigger GitHub secret scanning but still test redaction
      { name: 'Password in URL', value: 'https://admin:secretpassword123@example.com/api' },
      { name: 'Password Assignment', value: 'password="my_super_secret_password_12345"' },
      { name: 'Private Key Header', value: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' },
    ];

    secretPatterns.forEach(({ name, value }) => {
      it(`should redact ${name}`, () => {
        const content = `SECRET=${value}`;
        const matches = scanContent(content);

        if (matches.length > 0) {
          for (const match of matches) {
            expect(match.redactedValue).toContain('REDACTED');
            expect(match.context).not.toContain(value.slice(0, 20));
          }
        }
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Redaction Edge Cases', () => {
    it('should handle empty strings', () => {
      const redacted = redactSecret('');
      expect(redacted).toBe('[EMPTY]');
    });

    it('should handle very long secrets', () => {
      const longSecret = 'a'.repeat(10000);
      const redacted = redactSecret(longSecret);

      expect(redacted.length).toBeLessThan(100);
      expect(redacted).toContain('REDACTED');
    });

    it('should handle secrets with special characters', () => {
      const specialSecret = 'pass!@#$%^&*(){}[]|\\:";\'<>?,./';
      const redacted = redactSecret(specialSecret);

      expect(redacted).toContain('REDACTED');
      expect(redacted).not.toContain('!@#$');
    });

    it('should handle secrets with unicode', () => {
      const unicodeSecret = 'password\u00e9\u00e8\u00ea123';
      const redacted = redactSecret(unicodeSecret);

      expect(redacted).toContain('REDACTED');
    });

    it('should handle secrets with newlines and tabs', () => {
      const whitespaceSecret = 'secret\n\t\r\nvalue';
      const redacted = redactSecret(whitespaceSecret);

      expect(redacted).toContain('REDACTED');
      expect(redacted).not.toContain('\n');
      expect(redacted).not.toContain('\t');
    });
  });
});
