/**
 * Secret scanning engine for tuck
 *
 * Provides functions to scan file content for secrets using pattern matching.
 */

import { readFile, stat } from 'fs/promises';
import { expandPath, collapsePath, pathExists } from '../paths.js';
import {
  ALL_SECRET_PATTERNS,
  GENERIC_PATTERN_IDS,
  assertSafeCustomRegex,
  getPatternsAboveSeverity,
  shouldSkipFile,
  type SecretPattern,
  type SecretSeverity,
} from './patterns.js';

// Maximum file size to scan (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Security: File count limits to prevent resource exhaustion
const MAX_FILES_PER_SCAN = 1000; // Hard limit on files per scan
const WARN_FILES_THRESHOLD = 100; // Warn user when scanning many files

// Security: Timeout protection to prevent DoS from pathological patterns
const SCAN_TIMEOUT_MS = 30000; // 30 seconds max for entire content scan
const PATTERN_TIMEOUT_MS = 5000; // 5 seconds max per pattern

// ============================================================================
// Types
// ============================================================================

export interface SecretMatch {
  patternId: string;
  patternName: string;
  severity: SecretSeverity;
  value: string;
  redactedValue: string;
  line: number;
  column: number;
  context: string;
  placeholder: string;
  /**
   * Content offsets of the captured value: `start` is its index in the scanned
   * content and `end` is `start + value.length`. For matches produced by
   * `scanContent` (`offsetsExact === true`), `content.slice(start, end)`
   * reproduces `value` exactly. For matches from other producers (e.g.
   * `external.ts`/gitleaks, which report only 1-based line/column and lack the
   * whole-content offset) these are a best-effort APPROXIMATION and the slice
   * equality does NOT hold. Used by overlap resolution (issue #100 Task 3).
   */
  start: number;
  end: number;
  /**
   * True only when `start`/`end` are exact content offsets satisfying
   * `content.slice(start, end) === value` (set by `scanContent`). Absent/false
   * means the offsets are approximate. Overlap- and offset-based consumers MUST
   * ignore matches without `offsetsExact === true`.
   */
  offsetsExact?: boolean;
}

export interface FileScanResult {
  path: string;
  collapsedPath: string;
  hasSecrets: boolean;
  matches: SecretMatch[];
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  skipped: boolean;
  skipReason?: string;
}

export interface ScanOptions {
  patterns?: SecretPattern[];
  customPatterns?: SecretPattern[];
  excludePatternIds?: string[];
  minSeverity?: SecretSeverity;
  maxFileSize?: number;
}

export interface ScanSummary {
  totalFiles: number;
  scannedFiles: number;
  skippedFiles: number;
  filesWithSecrets: number;
  totalSecrets: number;
  bySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  results: FileScanResult[];
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Redact a secret value for display
 * Security: NEVER show any actual characters from the secret to prevent information leakage.
 * Only show length indicators and type hints.
 */
export const redactSecret = (value: string): string => {
  // Handle empty or undefined values
  if (!value || value.length === 0) {
    return '[EMPTY]';
  }

  // For multiline values (like private keys), show type hint only
  if (value.includes('\n')) {
    const lines = value.split('\n');
    const firstLine = lines.length > 0 ? lines[0] : '';
    if (firstLine.startsWith('-----BEGIN')) {
      // Show only the header type, no actual content
      return firstLine + '\n[REDACTED - Private Key]';
    }
    return '[REDACTED MULTILINE SECRET]';
  }

  // Security: Never show any actual characters from the secret
  // Only show length indicator to help identify which secret it is
  if (value.length <= 20) {
    return '[REDACTED]';
  } else if (value.length <= 50) {
    return '[REDACTED SECRET]';
  } else {
    return '[REDACTED LONG SECRET]';
  }
};

/**
 * Get line and column number from string index
 */
const getPosition = (content: string, index: number): { line: number; column: number } => {
  // Handle edge cases: empty content or invalid index
  if (!content || content.length === 0 || index < 0) {
    return { line: 1, column: 1 };
  }

  // Clamp index to valid range
  const safeIndex = Math.min(index, content.length);
  const beforeMatch = content.slice(0, safeIndex);
  const lines = beforeMatch.split('\n');

  // Handle edge case of empty lines array (shouldn't happen, but defensive)
  if (lines.length === 0) {
    return { line: 1, column: 1 };
  }

  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
};

/**
 * Get the line containing the match with secret redacted
 * Security: Ensures the secret is always fully redacted in the context,
 * with fallback to fully redacting the line if replacement fails.
 */
const getContext = (content: string, lineNum: number, secretValue: string): string => {
  // Handle empty content or invalid line number
  if (!content || content.length === 0 || lineNum < 1) {
    return '[Context redacted for security]';
  }

  const lines = content.split('\n');

  // Handle edge case of empty lines array or invalid line number
  if (lines.length === 0 || lineNum > lines.length) {
    return '[Context redacted for security]';
  }

  const line = lines[lineNum - 1] || '';

  try {
    // Redact the secret in the context
    let contextLine: string;
    const secretToFind = secretValue.includes('\n') ? secretValue.split('\n')[0] : secretValue;

    // Security: Escape regex special characters in secret value
    const escaped = secretToFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    contextLine = line.replace(regex, '[REDACTED]');

    // Security: If the replacement didn't change the line but it might contain part of the secret,
    // fully redact the line to prevent any potential leakage
    if (contextLine === line && secretToFind.length > 4) {
      // Check if any significant portion of the secret might be in the line
      const partialSecret = secretToFind.slice(0, Math.min(8, secretToFind.length));
      if (line.includes(partialSecret)) {
        return '[Line contains secret - REDACTED]';
      }
    }

    // Truncate long lines
    if (contextLine.length > 100) {
      contextLine = contextLine.slice(0, 97) + '...';
    }

    return contextLine.trim();
  } catch {
    // Security: On any error, return fully redacted context
    return '[Context redacted for security]';
  }
};

/**
 * Clone a regex pattern to reset its lastIndex
 */
const clonePattern = (pattern: RegExp): RegExp => {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
};

/**
 * Placeholder for a match: the full captured identifier when the pattern
 * exposes one (e.g. LAMBDA_API_KEY -> {{LAMBDA_API_KEY}}), else the pattern
 * default. Sanitized to match PLACEHOLDER_REGEX ([A-Z][A-Z0-9_]*).
 */
const derivePlaceholder = (name: string | undefined, fallback: string): string => {
  if (!name) return fallback;
  let p = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!/^[A-Z]/.test(p)) p = `SECRET_${p}`;
  return p;
};

// Values that are clearly not literal secrets: env-var references, home/abs/rel
// paths, and already-redacted placeholders. Broad unquoted classes (issue #100
// Task 2) would otherwise flag `KEY_FILE=/path/to/key.pem` or `KEY=$OTHER_VAR`.
//
// Scope (deliberately narrow): this guard is applied ONLY to values captured
// from the UNQUOTED named `value` group of a GENERIC pattern. It must NOT run
// for vendor patterns or for quoted (`qvalue`) captures. Rationale: a false
// negative here commits a real secret in cleartext (e.g. an AWS secret key
// `[A-Za-z0-9/+=]{40}` legitimately starting with `/`, or a quoted
// `password="$uper$ecret"` whose `$` cannot be an env-var reference inside
// quotes), whereas a false positive merely prompts the user. The env-var/path
// heuristic is only sound for a bare, unquoted generic assignment RHS.
const NON_SECRET_PREFIXES = ['$', '~', '/', './', '{{'] as const;
const isLikelyNonSecret = (value: string): boolean =>
  NON_SECRET_PREFIXES.some((p) => value.startsWith(p));

// ============================================================================
// Core Scanning Functions
// ============================================================================

/**
 * Scan content string for secrets
 */
export const scanContent = (content: string, options: ScanOptions = {}): SecretMatch[] => {
  const matches: SecretMatch[] = [];
  const seenMatches = new Set<string>(); // Deduplicate matches

  // Security: Track scan start time for timeout protection
  const scanStartTime = Date.now();

  // Determine which patterns to use
  let patterns: SecretPattern[];

  if (options.patterns) {
    patterns = options.patterns;
  } else if (options.minSeverity) {
    patterns = getPatternsAboveSeverity(options.minSeverity);
  } else {
    patterns = ALL_SECRET_PATTERNS;
  }

  // Add custom patterns
  if (options.customPatterns) {
    for (const customPattern of options.customPatterns) {
      assertSafeCustomRegex(customPattern.pattern.source);
    }
    patterns = [...patterns, ...options.customPatterns];
  }

  // Exclude specific pattern IDs
  if (options.excludePatternIds && options.excludePatternIds.length > 0) {
    const excludeSet = new Set(options.excludePatternIds);
    patterns = patterns.filter((p) => !excludeSet.has(p.id));
  }

  // Scan with each pattern
  for (const pattern of patterns) {
    // Security: Check total scan timeout
    if (Date.now() - scanStartTime > SCAN_TIMEOUT_MS) {
      console.warn('[tuck] Warning: Scan timeout reached, some patterns may not have been checked');
      break;
    }

    // Clone the pattern to reset lastIndex
    const regex = clonePattern(pattern.pattern);

    // Security: Track pattern start time
    const patternStartTime = Date.now();

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      // Security: Check pattern timeout to prevent ReDoS
      if (Date.now() - patternStartTime > PATTERN_TIMEOUT_MS) {
        console.warn(`[tuck] Warning: Pattern ${pattern.id} timed out, skipping remaining matches`);
        break;
      }

      // Extract the secret value. Named-group convention (new patterns): `qvalue`
      // (quoted) / `value` (unquoted). Numbered-group convention (legacy + custom
      // patterns): first DEFINED group. `??`-chains so an empty-string capture never
      // falls through to match[0] (which would include the identifier context and
      // make redaction eat surrounding text — issue #100 root cause 1).
      const groups = match.groups;
      const qvalue = groups?.['qvalue'];
      const namedValue = groups?.['value'];
      const value =
        qvalue ??
        namedValue ??
        match.slice(1).find((g): g is string => g !== undefined) ??
        match[0];

      // Skip empty or very short matches
      if (!value || value.length < 4) {
        continue;
      }

      // The value came from an UNQUOTED generic-pattern capture iff it resolved
      // to the named `value` group (not `qvalue`, not a numbered/legacy group,
      // not match[0]) AND the pattern is one of the low-specificity generics.
      const fromUnquotedGenericValue =
        qvalue === undefined &&
        namedValue !== undefined &&
        value === namedValue &&
        GENERIC_PATTERN_IDS.has(pattern.id);

      // Skip env-var references, paths, and already-redacted placeholders —
      // but ONLY for unquoted generic captures (see isLikelyNonSecret above).
      if (fromUnquotedGenericValue && isLikelyNonSecret(value)) {
        continue;
      }

      // Create unique key for deduplication
      const matchKey = `${pattern.id}:${match.index}:${value.length}`;
      if (seenMatches.has(matchKey)) {
        continue;
      }
      seenMatches.add(matchKey);

      const position = getPosition(content, match.index);

      // Value range for downstream overlap resolution (issue #100 Task 3).
      const valueOffset = match[0].indexOf(value); // value is always a substring of match[0]
      const start = match.index + (valueOffset >= 0 ? valueOffset : 0);

      matches.push({
        patternId: pattern.id,
        patternName: pattern.name,
        severity: pattern.severity,
        value,
        redactedValue: redactSecret(value),
        line: position.line,
        column: position.column,
        context: getContext(content, position.line, value),
        placeholder: derivePlaceholder(groups?.['name'], pattern.placeholder),
        start,
        end: start + value.length,
        offsetsExact: true,
      });

      // Prevent infinite loops for zero-width matches
      if (match.index === regex.lastIndex) {
        regex.lastIndex++;
      }
    }
  }

  // Cross-pattern overlap resolution: one secret must yield ONE match. Vendor
  // (specific) patterns beat GENERIC_PATTERN_IDS; then the longer captured value
  // wins (a truncated generic capture must not shadow a fuller one); then the
  // earlier match. Without this, a GitHub PAT is ALSO reported by the generic
  // token pattern and can end up stored under a generic placeholder (issue #100).
  const isGeneric = (m: SecretMatch): number => (GENERIC_PATTERN_IDS.has(m.patternId) ? 1 : 0);
  const byPriority = [...matches].sort(
    (a, b) => isGeneric(a) - isGeneric(b) || b.end - b.start - (a.end - a.start) || a.start - b.start
  );
  const kept: SecretMatch[] = [];
  for (const m of byPriority) {
    // Defensive: only exact offsets (set by scanContent) are trustworthy for
    // overlap comparison. External producers (e.g. gitleaks via external.ts)
    // approximate start/end; a phantom overlap there would silently DROP a real
    // secret. So never drop, and never compare against, a non-exact match.
    if (m.offsetsExact !== true) {
      kept.push(m);
      continue;
    }
    if (kept.some((k) => k.offsetsExact === true && m.start < k.end && k.start < m.end)) {
      continue;
    }
    kept.push(m);
  }
  matches.length = 0;
  matches.push(...kept);

  // Sort by line number, then column
  matches.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  return matches;
};

/**
 * Scan a single file for secrets
 */
export const scanFile = async (filepath: string, options: ScanOptions = {}): Promise<FileScanResult> => {
  const expandedPath = expandPath(filepath);
  const collapsedPath = collapsePath(expandedPath);
  const maxSize = options.maxFileSize || MAX_FILE_SIZE;

  // Check if file exists
  if (!(await pathExists(expandedPath))) {
    return {
      path: expandedPath,
      collapsedPath,
      hasSecrets: false,
      matches: [],
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      skipped: true,
      skipReason: 'File not found',
    };
  }

  // Check if it's a binary file by extension
  if (shouldSkipFile(expandedPath)) {
    return {
      path: expandedPath,
      collapsedPath,
      hasSecrets: false,
      matches: [],
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      skipped: true,
      skipReason: 'Binary file',
    };
  }

  // Check file size
  try {
    const stats = await stat(expandedPath);
    if (stats.size > maxSize) {
      return {
        path: expandedPath,
        collapsedPath,
        hasSecrets: false,
        matches: [],
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        skipped: true,
        skipReason: `File too large (${Math.round(stats.size / 1024 / 1024)}MB > ${Math.round(maxSize / 1024 / 1024)}MB)`,
      };
    }

    // Skip directories
    if (stats.isDirectory()) {
      return {
        path: expandedPath,
        collapsedPath,
        hasSecrets: false,
        matches: [],
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        skipped: true,
        skipReason: 'Is a directory',
      };
    }
  } catch {
    return {
      path: expandedPath,
      collapsedPath,
      hasSecrets: false,
      matches: [],
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      skipped: true,
      skipReason: 'Cannot read file stats',
    };
  }

  // Read and scan file content
  try {
    const content = await readFile(expandedPath, 'utf-8');
    const matches = scanContent(content, options);

    return {
      path: expandedPath,
      collapsedPath,
      hasSecrets: matches.length > 0,
      matches,
      criticalCount: matches.filter((m) => m.severity === 'critical').length,
      highCount: matches.filter((m) => m.severity === 'high').length,
      mediumCount: matches.filter((m) => m.severity === 'medium').length,
      lowCount: matches.filter((m) => m.severity === 'low').length,
      skipped: false,
    };
  } catch (error) {
    // Handle encoding errors (likely binary content)
    return {
      path: expandedPath,
      collapsedPath,
      hasSecrets: false,
      matches: [],
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      skipped: true,
      skipReason: 'Cannot read file (possibly binary)',
    };
  }
};

/**
 * Scan multiple files for secrets
 */
export const scanFiles = async (filepaths: string[], options: ScanOptions = {}): Promise<ScanSummary> => {
  // Security: Check file count limits to prevent resource exhaustion
  if (filepaths.length > MAX_FILES_PER_SCAN) {
    throw new Error(
      `Too many files to scan (${filepaths.length} > ${MAX_FILES_PER_SCAN}). ` +
        'Please scan in smaller batches or use --exclude patterns to reduce scan scope.'
    );
  }

  if (filepaths.length > WARN_FILES_THRESHOLD) {
    console.warn(
      `[tuck] Warning: Scanning ${filepaths.length} files may take a while. ` +
        'Consider using --exclude patterns to reduce scan scope if this is slow.'
    );
  }

  const results: FileScanResult[] = [];

  // Scan files in parallel batches (with concurrency limit)
  const CONCURRENCY = 10;
  for (let i = 0; i < filepaths.length; i += CONCURRENCY) {
    const batch = filepaths.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((path) => scanFile(path, options)));
    results.push(...batchResults);
  }

  // Build summary
  const summary: ScanSummary = {
    totalFiles: filepaths.length,
    scannedFiles: results.filter((r) => !r.skipped).length,
    skippedFiles: results.filter((r) => r.skipped).length,
    filesWithSecrets: results.filter((r) => r.hasSecrets).length,
    totalSecrets: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    results: results.filter((r) => r.hasSecrets), // Only include files with secrets
  };

  for (const result of results) {
    summary.totalSecrets += result.matches.length;
    summary.bySeverity.critical += result.criticalCount;
    summary.bySeverity.high += result.highCount;
    summary.bySeverity.medium += result.mediumCount;
    summary.bySeverity.low += result.lowCount;
  }

  return summary;
};

/**
 * Generate unique placeholder names when there are duplicates
 */
export const generateUniquePlaceholder = (
  basePlaceholder: string,
  existingPlaceholders: Set<string>,
  hint?: string
): string => {
  let placeholder = basePlaceholder;

  // Add hint to make it more descriptive
  if (hint) {
    const sanitizedHint = hint.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    placeholder = `${basePlaceholder}_${sanitizedHint}`;
  }

  // Ensure uniqueness
  if (!existingPlaceholders.has(placeholder)) {
    existingPlaceholders.add(placeholder);
    return placeholder;
  }

  // Add numeric suffix
  let counter = 1;
  while (existingPlaceholders.has(`${placeholder}_${counter}`)) {
    counter++;
  }

  const uniquePlaceholder = `${placeholder}_${counter}`;
  existingPlaceholders.add(uniquePlaceholder);
  return uniquePlaceholder;
};

/**
 * Get all unique secret values from scan results with their placeholders
 */
export const getSecretsWithPlaceholders = (
  results: FileScanResult[]
): Map<string, { placeholder: string; pattern: string; severity: SecretSeverity }> => {
  const secrets = new Map<string, { placeholder: string; pattern: string; severity: SecretSeverity }>();
  const usedPlaceholders = new Set<string>();

  for (const result of results) {
    for (const match of result.matches) {
      // Skip if we already have this exact secret value
      if (secrets.has(match.value)) {
        continue;
      }

      // Generate unique placeholder
      const placeholder = generateUniquePlaceholder(match.placeholder, usedPlaceholders);

      secrets.set(match.value, {
        placeholder,
        pattern: match.patternName,
        severity: match.severity,
      });
    }
  }

  return secrets;
};
