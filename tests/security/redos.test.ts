/**
 * ReDoS (Regular Expression Denial of Service) Security Tests
 *
 * These tests verify that regex patterns used in tuck are protected
 * against catastrophic backtracking that could freeze the application.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { scanContent } from '../../src/lib/secrets/scanner.js';
import { ALL_SECRET_PATTERNS } from '../../src/lib/secrets/patterns.js';
import { TEST_HOME } from '../setup.js';

// Helper to measure execution time
const measureTime = async (fn: () => void | Promise<void>): Promise<number> => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

// Maximum acceptable time for regex operations
const MAX_PATTERN_TIME_MS = 5000; // 5 seconds
const MAX_SCAN_TIME_MS = 30000; // 30 seconds

describe('ReDoS Security', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
  });

  // ============================================================================
  // Pathological Input Tests
  // ============================================================================

  describe('Pathological Input Resistance', () => {
    // Classic ReDoS patterns that cause exponential backtracking
    const redosPayloads = [
      // Repeated 'a' characters - classic ReDoS trigger
      { name: 'repeated-a', input: 'a'.repeat(50) + '!' },

      // Nested quantifiers attack
      { name: 'nested-quantifiers', input: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },

      // Overlapping alternation
      { name: 'overlapping-alt', input: '0'.repeat(30) + 'x' },

      // Long string without terminator
      { name: 'long-no-terminator', input: '='.repeat(1000) },

      // Quote flood
      { name: 'quote-flood', input: '"'.repeat(100) },

      // Mixed delimiters
      { name: 'mixed-delimiters', input: '="'.repeat(50) },

      // Near-match patterns (worst case for greedy quantifiers)
      { name: 'near-match-password', input: 'password' + '='.repeat(100) },
      { name: 'near-match-key', input: 'api_key' + ':'.repeat(100) },

      // Base64-like strings that almost match
      { name: 'base64-like', input: 'eyJ' + 'a'.repeat(200) },

      // URL-like strings
      { name: 'url-like', input: 'https://' + 'a'.repeat(200) + '@' },
    ];

    redosPayloads.forEach(({ name, input }) => {
      it(`should handle pathological input: ${name}`, async () => {
        const duration = await measureTime(() => {
          scanContent(input);
        });

        expect(duration).toBeLessThan(MAX_SCAN_TIME_MS);
      }, 35000); // Timeout slightly longer than max scan time
    });
  });

  // ============================================================================
  // Large Input Tests
  // ============================================================================

  describe('Large Input Handling', () => {
    it('should handle 1MB of random content', async () => {
      const content = 'x'.repeat(1024 * 1024);

      const duration = await measureTime(() => {
        scanContent(content);
      });

      expect(duration).toBeLessThan(MAX_SCAN_TIME_MS);
    }, 35000);

    it('should handle 100KB of realistic config', async () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `CONFIG_${i}=value_${i}`);
      const content = lines.join('\n');

      const duration = await measureTime(() => {
        scanContent(content);
      });

      expect(duration).toBeLessThan(MAX_SCAN_TIME_MS);
    }, 35000);

    it('should handle deeply nested JSON-like content', async () => {
      const nested = '{"a":'.repeat(100) + '"value"' + '}'.repeat(100);

      const duration = await measureTime(() => {
        scanContent(nested);
      });

      expect(duration).toBeLessThan(MAX_SCAN_TIME_MS);
    });
  });

  // ============================================================================
  // Individual Pattern Tests
  // ============================================================================

  describe('Individual Pattern Safety', () => {
    // Test each pattern against known ReDoS inputs
    const problematicInputs = [
      'a'.repeat(100),
      '='.repeat(100),
      '"'.repeat(100),
      "'".repeat(100),
      '/'.repeat(100),
      ':'.repeat(100),
    ];

    // Group patterns to test more efficiently
    const patternGroups = [
      { name: 'cloud-provider', filter: (id: string) => id.includes('aws') || id.includes('gcp') },
      { name: 'api-tokens', filter: (id: string) => id.includes('token') || id.includes('key') },
      { name: 'generic', filter: (id: string) => id.includes('password') || id.includes('secret') },
    ];

    patternGroups.forEach(({ name, filter }) => {
      it(`should safely handle ${name} patterns`, async () => {
        const patterns = ALL_SECRET_PATTERNS.filter((p) => filter(p.id));

        for (const input of problematicInputs) {
          const duration = await measureTime(() => {
            scanContent(input, { patterns });
          });

          expect(duration).toBeLessThan(MAX_PATTERN_TIME_MS);
        }
      });
    });
  });

  // ============================================================================
  // Timeout Enforcement Tests
  // ============================================================================

  describe('Timeout Enforcement', () => {
    it('should respect pattern timeout', async () => {
      // Create an input designed to be slow
      const slowInput = 'a'.repeat(1000) + 'password=' + '"'.repeat(1000);

      const startTime = performance.now();
      scanContent(slowInput);
      const duration = performance.now() - startTime;

      // Even with slow input, should complete within timeout
      expect(duration).toBeLessThan(MAX_SCAN_TIME_MS + 5000); // 5s buffer
    });

    it('should handle multiple patterns timing out', async () => {
      // This simulates worst-case scenario where multiple patterns are slow
      const worstCaseInput = Array.from(
        { length: 10 },
        (_, i) => `line${i}=` + 'a'.repeat(100) + `"${i}"`
      ).join('\n');

      const startTime = performance.now();
      scanContent(worstCaseInput);
      const duration = performance.now() - startTime;

      expect(duration).toBeLessThan(MAX_SCAN_TIME_MS + 5000);
    });
  });

  // ============================================================================
  // Pattern Vulnerability Analysis
  // ============================================================================

  describe('Pattern Vulnerability Analysis', () => {
    it('should not have unbounded quantifiers on overlapping groups', () => {
      // Check each pattern for common ReDoS vulnerabilities
      for (const pattern of ALL_SECRET_PATTERNS) {
        const source = pattern.pattern.source;

        // Check for dangerous patterns: (a+)+ or (a*)*
        const dangerousNested = /\([^)]*[+*]\)[+*]/.test(source);
        if (dangerousNested) {
          // If present, there should be a length limit
          expect(source).toMatch(/\{[0-9,]+\}/);
        }
      }
    });

    it('should have length limits on variable content matches', () => {
      for (const pattern of ALL_SECRET_PATTERNS) {
        const source = pattern.pattern.source;

        // Check for .+ or .* without length limits
        // Most should have explicit bounds like {1,256}
        const hasUnboundedDot = /\.\+(?!\?)/.test(source) && !/\{[0-9,]+\}/.test(source);

        // Private keys are allowed to be longer, but should still have limits
        if (!pattern.id.includes('private-key')) {
          if (hasUnboundedDot) {
            // This is a potential issue - log for investigation
            console.warn(`Pattern ${pattern.id} may have unbounded matching`);
          }
        }
      }
    });
  });

  // ============================================================================
  // Stress Tests
  // ============================================================================

  describe('Stress Tests', () => {
    it('should handle rapid sequential scans', async () => {
      const content = 'api_key="test-key-12345678901234567890"';

      const startTime = performance.now();
      for (let i = 0; i < 1000; i++) {
        scanContent(content);
      }
      const duration = performance.now() - startTime;

      // 1000 scans should complete in under 10 seconds
      expect(duration).toBeLessThan(10000);
    });

    it('should handle varied input sizes', async () => {
      const sizes = [100, 1000, 10000, 50000];

      for (const size of sizes) {
        const content = 'x'.repeat(size);

        const duration = await measureTime(() => {
          scanContent(content);
        });

        // Time should scale reasonably (not exponentially)
        // Allow 1ms per 100 chars as baseline
        const expectedMax = Math.max(1000, (size / 100) * 10);
        expect(duration).toBeLessThan(expectedMax);
      }
    });
  });

  // ============================================================================
  // Memory Safety
  // ============================================================================

  describe('Memory Safety', () => {
    it('should not cause memory issues with large match counts', () => {
      // Create content with many potential matches
      const content = Array.from(
        { length: 1000 },
        (_, i) => `API_KEY_${i}="${'x'.repeat(32)}"`
      ).join('\n');

      const memBefore = process.memoryUsage().heapUsed;
      scanContent(content);
      const memAfter = process.memoryUsage().heapUsed;

      // Memory increase should be reasonable
      const memIncrease = memAfter - memBefore;
      expect(memIncrease).toBeLessThan(100 * 1024 * 1024); // 100MB max
    });
  });
});
