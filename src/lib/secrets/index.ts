/**
 * Secret scanning and management for tuck
 *
 * This module provides comprehensive secret detection, redaction,
 * and management capabilities for dotfiles.
 */

// Re-export pattern types and helpers
export {
  type SecretPattern,
  type SecretSeverity,
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
} from './patterns.js';

// Re-export scanner types and functions
export {
  type SecretMatch,
  type FileScanResult,
  type ScanOptions,
  type ScanSummary,
  scanContent,
  scanFile,
  scanFiles,
  generateUniquePlaceholder,
  getSecretsWithPlaceholders,
} from './scanner.js';

// Re-export store types and functions
export {
  getSecretsPath,
  loadSecretsStore,
  saveSecretsStore,
  setSecret,
  getSecret,
  unsetSecret,
  hasSecret,
  listSecrets,
  getAllSecrets,
  getSecretCount,
  setSecrets,
  touchSecrets,
  ensureSecretsGitignored,
  isValidSecretName,
  normalizeSecretName,
} from './store.js';

// Re-export redactor types and functions
export {
  type RedactionResult,
  type RestorationResult,
  formatPlaceholder,
  parsePlaceholder,
  PLACEHOLDER_REGEX,
  redactContent,
  redactFile,
  restoreContent,
  restoreFile,
  findPlaceholders,
  findUnresolvedPlaceholders,
  hasPlaceholders,
  countPlaceholders,
  restoreFiles,
  previewRestoration,
} from './redactor.js';

// Re-export schema types
export type { SecurityConfig, CustomPattern, SecretEntry, SecretsStore } from '../../schemas/secrets.schema.js';

// Re-export external scanner types and functions
export {
  type ExternalScanner,
  isGitleaksInstalled,
  isTrufflehogInstalled,
  getAvailableScanners,
  scanWithGitleaks,
  scanWithScanner,
} from './external.js';

// ============================================================================
// High-Level Convenience Functions
// ============================================================================

import { loadConfig } from '../config.js';
import { scanFiles, type ScanSummary, type FileScanResult } from './scanner.js';
import { setSecret, ensureSecretsGitignored } from './store.js';
import { createCustomPattern, type SecretPattern } from './patterns.js';
import type { CustomPattern } from '../../schemas/secrets.schema.js';
import { scanWithScanner, isGitleaksInstalled, isTrufflehogInstalled, type ExternalScanner } from './external.js';

/**
 * Scan files for secrets using config-aware settings
 *
 * Supports external scanners (gitleaks, trufflehog) via config.
 * Falls back to built-in scanner if external tool not available.
 */
export const scanForSecrets = async (filepaths: string[], tuckDir: string): Promise<ScanSummary> => {
  const config = await loadConfig(tuckDir);
  const security = config.security || {};

  // Check if an external scanner is configured
  const configuredScanner = (security.scanner || 'builtin') as ExternalScanner;

  // If external scanner configured, try to use it
  if (configuredScanner !== 'builtin') {
    // Check availability
    let useExternal = false;
    if (configuredScanner === 'gitleaks' && await isGitleaksInstalled()) {
      useExternal = true;
    } else if (configuredScanner === 'trufflehog' && await isTrufflehogInstalled()) {
      useExternal = true;
    }

    if (useExternal) {
      return scanWithScanner(filepaths, configuredScanner);
    }
    // Fall through to built-in if external not available
  }

  // Use built-in scanner with custom patterns
  const customPatterns: SecretPattern[] = (security.customPatterns || []).map((p: CustomPattern, i: number) =>
    createCustomPattern(`config-${i}`, p.name || `Custom Pattern ${i + 1}`, p.pattern, {
      severity: p.severity,
      description: p.description,
      placeholder: p.placeholder,
      flags: p.flags,
    })
  );

  return scanFiles(filepaths, {
    customPatterns: customPatterns.length > 0 ? customPatterns : undefined,
    excludePatternIds: security.excludePatterns,
    minSeverity: security.minSeverity,
    maxFileSize: security.maxFileSize,
  });
};

/**
 * Process scan results: store secrets and return placeholder mapping
 */
export const processSecretsForRedaction = async (
  results: FileScanResult[],
  tuckDir: string
): Promise<Map<string, Map<string, string>>> => {
  await ensureSecretsGitignored(tuckDir);

  // Map of filepath -> (secret value -> placeholder name)
  const fileRedactionMaps = new Map<string, Map<string, string>>();

  // Track used placeholders to ensure uniqueness
  const usedPlaceholders = new Set<string>();

  for (const result of results) {
    const placeholderMap = new Map<string, string>();

    for (const match of result.matches) {
      // Check if we already have this value mapped
      let existingPlaceholder: string | undefined;
      for (const map of fileRedactionMaps.values()) {
        if (map.has(match.value)) {
          existingPlaceholder = map.get(match.value);
          break;
        }
      }

      let placeholder: string;
      if (existingPlaceholder) {
        // Reuse existing placeholder for same value
        placeholder = existingPlaceholder;
      } else {
        // Generate unique placeholder
        placeholder = match.placeholder;
        let counter = 1;
        while (usedPlaceholders.has(placeholder)) {
          placeholder = `${match.placeholder}_${counter}`;
          counter++;
        }
        usedPlaceholders.add(placeholder);

        // Store the secret
        await setSecret(tuckDir, placeholder, match.value, {
          description: match.patternName,
          source: result.collapsedPath,
        });
      }

      placeholderMap.set(match.value, placeholder);
    }

    fileRedactionMaps.set(result.path, placeholderMap);
  }

  return fileRedactionMaps;
};

/**
 * Check if secret scanning is enabled in config
 */
export const isSecretScanningEnabled = async (tuckDir: string): Promise<boolean> => {
  try {
    const config = await loadConfig(tuckDir);
    return config.security?.scanSecrets !== false;
  } catch (error) {
    // Log error for debugging instead of silent failure
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[tuck] Warning: Failed to load config for scanning check: ${errorMsg}`);
    // Default to enabled if config can't be loaded (safe default)
    return true;
  }
};

/**
 * Check if operations should be blocked when secrets are detected
 */
export const shouldBlockOnSecrets = async (tuckDir: string): Promise<boolean> => {
  try {
    const config = await loadConfig(tuckDir);
    return config.security?.blockOnSecrets !== false;
  } catch (error) {
    // Log error for debugging instead of silent failure
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[tuck] Warning: Failed to load config for blocking check: ${errorMsg}`);
    // Default to blocking if config can't be loaded (safe default)
    return true;
  }
};
