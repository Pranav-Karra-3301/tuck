/**
 * Secret scanner benchmarks for tuck.
 *
 * The secret scanner runs regex patterns against file content.
 * Performance concerns:
 * - 60+ patterns to check per file
 * - Large files can be slow
 * - ReDoS-vulnerable patterns can hang
 *
 * Target performance:
 * - 10KB file: < 50ms
 * - 100KB file: < 200ms
 * - No pattern should take > 5s (ReDoS protection)
 *
 * IMPORTANT: Fixtures are created at module level, not in beforeAll,
 * due to vitest bench variable sharing issues.
 */

import { describe, bench, expect } from 'vitest';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import {
  createTempDir,
  generateFileWithSecrets,
  generateDotfileContent,
} from './setup.js';

// Import scanner functions
import { scanContent, scanFile, scanFiles } from '../../src/lib/secrets/scanner.js';
import {
  ALL_SECRET_PATTERNS,
  CLOUD_PROVIDER_PATTERNS,
  API_TOKEN_PATTERNS,
} from '../../src/lib/secrets/patterns.js';

// ============================================================================
// Create fixtures at module level (synchronously)
// ============================================================================

const tempDir = createTempDir('scanner-bench-');

// Generate content strings
const smallContent = generateDotfileContent(100);
const mediumContent = generateDotfileContent(1000);
const largeContent = generateDotfileContent(10000);

// Content with realistic secrets
const contentWithSecrets = `
# Configuration file with secrets
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
api_key = "sk-1234567890abcdef1234567890abcdef"
DATABASE_URL=postgres://user:password123@localhost:5432/mydb
# More config
${mediumContent}
`;

// Create test files
const cleanFile = join(tempDir, 'clean.txt');
writeFileSync(cleanFile, mediumContent);

const fileWithSecrets = join(tempDir, 'secrets.txt');
writeFileSync(fileWithSecrets, contentWithSecrets);

const largeCleanFile = join(tempDir, 'large_clean.txt');
writeFileSync(largeCleanFile, largeContent);

const largeFileWithSecrets = join(tempDir, 'large_secrets.txt');
generateFileWithSecrets(largeFileWithSecrets, 50);

// Create many files for batch scanning
const manyFilesDir = join(tempDir, 'many');
mkdirSync(manyFilesDir, { recursive: true });
for (let i = 0; i < 100; i++) {
  const path = join(manyFilesDir, `file_${i}.txt`);
  if (i % 10 === 0) {
    generateFileWithSecrets(path, 5);
  } else {
    writeFileSync(path, generateDotfileContent(50));
  }
}

// Pre-generate file list for batch scans
const manyFilesList = Array.from({ length: 100 }, (_, i) => join(manyFilesDir, `file_${i}.txt`));
const tenFilesList = manyFilesList.slice(0, 10);

// ============================================================================
// Benchmarks
// ============================================================================

describe('Secret Scanner Benchmarks', () => {
  // ============================================================================
  // Content Scanning Benchmarks
  // ============================================================================

  describe('scanContent', () => {
    bench('scan small content (100 lines) - clean', () => {
      scanContent(smallContent);
    });

    bench('scan medium content (1000 lines) - clean', () => {
      scanContent(mediumContent);
    });

    bench('scan large content (10000 lines) - clean', () => {
      scanContent(largeContent);
    });

    bench('scan content with secrets', () => {
      scanContent(contentWithSecrets);
    });

    bench('scan with cloud provider patterns only', () => {
      scanContent(contentWithSecrets, { patterns: CLOUD_PROVIDER_PATTERNS });
    });

    bench('scan with API token patterns only', () => {
      scanContent(contentWithSecrets, { patterns: API_TOKEN_PATTERNS });
    });

    bench('scan with all patterns', () => {
      scanContent(contentWithSecrets, { patterns: ALL_SECRET_PATTERNS });
    });
  });

  // ============================================================================
  // File Scanning Benchmarks
  // ============================================================================

  describe('scanFile', () => {
    bench('scan clean file', async () => {
      await scanFile(cleanFile);
    });

    bench('scan file with secrets', async () => {
      await scanFile(fileWithSecrets);
    });

    bench('scan large clean file', async () => {
      await scanFile(largeCleanFile);
    });

    bench('scan large file with secrets', async () => {
      await scanFile(largeFileWithSecrets);
    });
  });

  // ============================================================================
  // Batch Scanning Benchmarks
  // ============================================================================

  describe('scanFiles', () => {
    bench('scan 100 files', async () => {
      await scanFiles(manyFilesList);
    });

    bench('scan 10 files in parallel (simulated)', async () => {
      await Promise.all(tenFilesList.map((f) => scanFile(f)));
    });
  });

  // ============================================================================
  // Individual Pattern Performance
  // ============================================================================

  describe('Individual Pattern Performance', () => {
    // Test each pattern category separately
    bench('AWS patterns', () => {
      const patterns = ALL_SECRET_PATTERNS.filter((p) => p.id.startsWith('aws'));
      scanContent(contentWithSecrets, { patterns });
    });

    bench('GitHub patterns', () => {
      const patterns = ALL_SECRET_PATTERNS.filter((p) => p.id.startsWith('github'));
      scanContent(contentWithSecrets, { patterns });
    });

    bench('Generic patterns (passwords, tokens)', () => {
      const patterns = ALL_SECRET_PATTERNS.filter(
        (p) => p.id.includes('password') || p.id.includes('token')
      );
      scanContent(contentWithSecrets, { patterns });
    });

    bench('Database connection patterns', () => {
      const patterns = ALL_SECRET_PATTERNS.filter(
        (p) => p.id.includes('postgres') || p.id.includes('mysql') || p.id.includes('mongo')
      );
      scanContent(contentWithSecrets, { patterns });
    });
  });

  // ============================================================================
  // ReDoS Resistance Tests
  // ============================================================================

  describe('ReDoS Resistance', () => {
    // These inputs are designed to potentially trigger ReDoS
    const redosInputs = [
      'a'.repeat(10000),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
      '='.repeat(1000) + 'x',
      '"' + 'a'.repeat(1000) + '"',
      'password=' + '"'.repeat(100),
    ];

    bench('pathological input - repeated chars', () => {
      scanContent(redosInputs[0]);
    });

    bench('pathological input - near-match', () => {
      scanContent(redosInputs[1]);
    });

    bench('pathological input - delimiter flood', () => {
      scanContent(redosInputs[2]);
    });
  });

  // ============================================================================
  // Performance Requirements
  // ============================================================================

  describe('Performance Requirements', () => {
    bench('medium content scan < 100ms', () => {
      const start = performance.now();
      scanContent(mediumContent);
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(100);
    });

    bench('large content scan < 500ms', () => {
      const start = performance.now();
      scanContent(largeContent);
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(500);
    });
  });
});
