/**
 * External secret scanner integration
 *
 * Provides optional integration with external tools like gitleaks and trufflehog.
 * Falls back to built-in scanning if external tools are not available.
 */

// Security: Use execFile instead of exec to prevent command injection
// execFile doesn't use shell interpolation, so malicious filenames can't execute arbitrary commands
import { execFile } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import type { SecretMatch, FileScanResult, ScanSummary } from './scanner.js';
import { scanFiles as builtinScanFiles, redactSecret } from './scanner.js';
import type { SecretSeverity } from './patterns.js';
import { collapsePath } from '../paths.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

export type ExternalScanner = 'gitleaks' | 'trufflehog' | 'builtin';

// Security: Zod schema for validating gitleaks JSON output
// This prevents prototype pollution and ensures type safety from external tool output
const gitleaksResultSchema = z.object({
  Description: z.string(),
  StartLine: z.number(),
  EndLine: z.number(),
  StartColumn: z.number(),
  EndColumn: z.number(),
  Match: z.string(),
  Secret: z.string(),
  File: z.string(),
  SymlinkFile: z.string().optional().default(''),
  Commit: z.string().optional().default(''),
  Entropy: z.number().optional().default(0),
  Author: z.string().optional().default(''),
  Email: z.string().optional().default(''),
  Date: z.string().optional().default(''),
  Message: z.string().optional().default(''),
  Tags: z.array(z.string()).optional().default([]),
  RuleID: z.string(),
  Fingerprint: z.string().optional().default(''),
});

const gitleaksOutputSchema = z.array(gitleaksResultSchema);

type GitleaksResult = z.infer<typeof gitleaksResultSchema>;

// ============================================================================
// Scanner Detection
// ============================================================================

/**
 * Check if gitleaks is installed
 */
export const isGitleaksInstalled = async (): Promise<boolean> => {
  try {
    // Security: Use execFileAsync to prevent command injection
    await execFileAsync('gitleaks', ['version']);
    return true;
  } catch {
    return false;
  }
};

/**
 * Check if trufflehog is installed
 */
export const isTrufflehogInstalled = async (): Promise<boolean> => {
  try {
    // Security: Use execFileAsync to prevent command injection
    await execFileAsync('trufflehog', ['--version']);
    return true;
  } catch {
    return false;
  }
};

/**
 * Get available scanners
 */
export const getAvailableScanners = async (): Promise<ExternalScanner[]> => {
  const available: ExternalScanner[] = ['builtin'];

  if (await isGitleaksInstalled()) {
    available.push('gitleaks');
  }

  if (await isTrufflehogInstalled()) {
    available.push('trufflehog');
  }

  return available;
};

// ============================================================================
// Gitleaks Integration
// ============================================================================

/**
 * Map gitleaks severity/rule to our severity levels
 */
const mapGitleaksSeverity = (ruleId: string): SecretSeverity => {
  // Critical patterns
  const criticalPatterns = [
    'aws', 'gcp', 'azure', 'private-key', 'stripe', 'github',
    'gitlab', 'npm', 'pypi', 'jwt', 'oauth',
  ];

  // High severity patterns
  const highPatterns = [
    'api', 'token', 'secret', 'password', 'credential',
  ];

  const ruleIdLower = ruleId.toLowerCase();

  if (criticalPatterns.some(p => ruleIdLower.includes(p))) {
    return 'critical';
  }

  if (highPatterns.some(p => ruleIdLower.includes(p))) {
    return 'high';
  }

  return 'medium';
};

/**
 * Generate a placeholder name from gitleaks rule
 */
const generatePlaceholderFromRule = (ruleId: string): string => {
  return ruleId
    .toUpperCase()
    .replace(/-/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
};

/**
 * Scan files using gitleaks
 */
export const scanWithGitleaks = async (filepaths: string[]): Promise<ScanSummary> => {
  const results: FileScanResult[] = [];
  let totalSecrets = 0;
  let filesWithSecrets = 0;
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };

  // Run gitleaks on files in parallel batches (with concurrency limit)
  const CONCURRENCY = 5; // Lower concurrency for external process spawning

  for (let i = 0; i < filepaths.length; i += CONCURRENCY) {
    const batch = filepaths.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (filepath): Promise<FileScanResult | null> => {
      try {
        // Security: Use execFileAsync with array arguments to prevent command injection
        // This prevents malicious filenames from executing arbitrary shell commands
        const { stdout, stderr } = await execFileAsync('gitleaks', [
          'detect',
          '--source', filepath,
          '--no-git',
          '--report-format', 'json',
          '--exit-code', '0'
        ], { maxBuffer: 10 * 1024 * 1024 });

        // Check stderr for gitleaks errors (not just secret findings)
        if (stderr && stderr.trim()) {
          // Log stderr but continue - gitleaks may output warnings/errors to stderr
          console.warn(`[tuck] Gitleaks stderr for ${filepath}: ${stderr.trim()}`);
        }

        if (!stdout.trim()) return null;

        // Security: Use Zod to validate external JSON input
        // This prevents prototype pollution and ensures type safety
        let gitleaksResults: GitleaksResult[];
        try {
          const rawData = JSON.parse(stdout);
          const validated = gitleaksOutputSchema.safeParse(rawData);

          if (!validated.success) {
            console.warn(`[tuck] Warning: Invalid gitleaks output format for ${filepath}: ${validated.error.message}`);
            return null;
          }

          gitleaksResults = validated.data;
        } catch (parseError) {
          // Log parse error for debugging instead of silent failure
          console.warn(`[tuck] Warning: Failed to parse gitleaks JSON for ${filepath}`);
          return null;
        }

        if (gitleaksResults.length === 0) return null;

        const matches: SecretMatch[] = [];

        for (const finding of gitleaksResults) {
          const severity = mapGitleaksSeverity(finding.RuleID);

          // Security: Use consistent redactSecret function for better security
          const secretValue = finding.Secret || finding.Match;
          const redactedValue = redactSecret(secretValue);

          matches.push({
            patternId: `gitleaks-${finding.RuleID}`,
            patternName: finding.Description || finding.RuleID,
            severity,
            line: finding.StartLine,
            column: finding.StartColumn,
            value: secretValue,
            redactedValue,
            context: finding.Match,
            placeholder: generatePlaceholderFromRule(finding.RuleID),
          });
        }

        // Collapse home directory in path for display using utility function
        const collapsedPath = collapsePath(filepath);

        return {
          path: filepath,
          collapsedPath,
          hasSecrets: true,
          matches,
          criticalCount: matches.filter(m => m.severity === 'critical').length,
          highCount: matches.filter(m => m.severity === 'high').length,
          mediumCount: matches.filter(m => m.severity === 'medium').length,
          lowCount: matches.filter(m => m.severity === 'low').length,
          skipped: false,
        };
      } catch (execError) {
        // Log error for debugging instead of silent failure
        const errorMsg = execError instanceof Error ? execError.message : String(execError);
        console.warn(`[tuck] Warning: Gitleaks scan failed for ${filepath}: ${errorMsg}`);
        return null;
      }
    })
    );

    // Process batch results
    for (const result of batchResults) {
      if (result) {
        results.push(result);
        filesWithSecrets++;
        totalSecrets += result.matches.length;
        for (const match of result.matches) {
          bySeverity[match.severity]++;
        }
      }
    }
  }

  return {
    results,
    totalFiles: filepaths.length,
    scannedFiles: filepaths.length,
    skippedFiles: 0,
    filesWithSecrets,
    totalSecrets,
    bySeverity,
  };
};

// ============================================================================
// Scanner Factory
// ============================================================================

/**
 * Scan files using the specified scanner (or fallback to builtin)
 */
export const scanWithScanner = async (
  filepaths: string[],
  scanner: ExternalScanner = 'builtin'
): Promise<ScanSummary> => {
  if (scanner === 'gitleaks') {
    const isInstalled = await isGitleaksInstalled();
    if (isInstalled) {
      return scanWithGitleaks(filepaths);
    }
    // Fall back to builtin if gitleaks not available
    console.warn('gitleaks not found, falling back to built-in scanner');
  }

  if (scanner === 'trufflehog') {
    // Trufflehog integration could be added here
    // For now, fall back to builtin
    console.warn('trufflehog integration not yet implemented, using built-in scanner');
  }

  // Use built-in scanner
  return builtinScanFiles(filepaths);
};
