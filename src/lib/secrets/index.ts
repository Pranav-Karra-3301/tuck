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
  redactSecret,
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
  listSecrets,
  getAllSecrets,
  getSecretCount,
  ensureSecretsGitignored,
  isValidSecretName,
  normalizeSecretName,
} from './store.js';

// Re-export redactor types and functions
export {
  type RedactionResult,
  type RestorationResult,
  formatPlaceholder,
  PLACEHOLDER_REGEX,
  redactContent,
  redactFile,
  getStoredValueMap,
  getRedactedChecksum,
  redactValuesInContent,
  restoreContent,
  findPlaceholders,
  restoreFiles,
} from './redactor.js';

// Re-export value-level (SOPS-style) encryption
export {
  type EncryptValuesResult,
  type DecryptValuesResult,
  type EncryptFileResult,
  type DecryptFileResult,
  VALUE_TOKEN_REGEX,
  formatValueToken,
  parseValueToken,
  hasEncryptedValues,
  findValueTokens,
  encryptContentValues,
  decryptContentValues,
  encryptFileValues,
  decryptFileValues,
  fileHasEncryptedValues,
} from './valueEncryption.js';

// Re-export schema types
export type { SecurityConfig, CustomPattern, SecretEntry, SecretsStore } from '../../schemas/secrets.schema.js';

// Re-export MCP extraction types and functions
export {
  type McpScope,
  type McpTargetPath,
  type McpReferenceFormat,
  type McpExtraction,
  type McpExtractionResult,
  type ExtractMcpOptions,
  getMcpTargetPaths,
  discoverMcpConfigFiles,
  isCredentialKey,
  isReferenceValue,
  shouldExtractValue,
  buildReference,
  analyzeMcpConfig,
  extractMcpSecrets,
} from './mcp.js';

// Re-export external scanner types and functions
export {
  type ExternalScanner,
  isGitleaksInstalled,
  isTrufflehogInstalled,
  scanWithGitleaks,
  scanWithScanner,
} from './external.js';

// ============================================================================
// High-Level Convenience Functions
// ============================================================================

import { loadConfig } from '../config.js';
import { scanFiles, type ScanSummary, type FileScanResult } from './scanner.js';
import { setSecret, ensureSecretsGitignored, getAllSecrets } from './store.js';
import { createCustomPattern, type SecretPattern } from './patterns.js';
import type { CustomPattern } from '../../schemas/secrets.schema.js';
import { scanWithScanner, isGitleaksInstalled, isTrufflehogInstalled, type ExternalScanner } from './external.js';
import { loadAllowlist, filterSummaryWithAllowlist } from './allowlist.js';

// Re-export allowlist API from the barrel so callers use `secrets/index.js`.
export {
  getAllowlistPath,
  computeFingerprint,
  loadAllowlist,
  saveAllowlist,
  addAllowlistEntryByFingerprint,
  addAllowlistEntryForValue,
  removeAllowlistEntries,
  listAllowlistEntries,
  isMatchAllowed,
  filterSummaryWithAllowlist,
  type AddAllowlistOptions,
} from './allowlist.js';
export type { AllowlistEntry, SecretsAllowlist } from '../../schemas/secretsAllowlist.schema.js';

/**
 * Scan files for secrets using config-aware settings
 *
 * Supports external scanners (gitleaks, trufflehog) via config.
 * Falls back to built-in scanner if external tool not available.
 *
 * Findings that appear in the committed allowlist (`secrets.allow.json`) are
 * filtered out here so every caller — `tuck add`, `tuck sync`, the scan command
 * and the MCP server — honors the same centralized, auditable allowlist rather
 * than scattered inline ignore comments.
 */
export const scanForSecrets = async (
  filepaths: string[],
  tuckDir: string,
  options: {
    /**
     * Return findings even when they are allowlisted. Used by
     * `tuck secrets allow add`, which must see the same findings the gate
     * sees (same scanner, custom patterns, and pattern ids) BEFORE the
     * allowlist filter — otherwise recorded scopes never match the gate.
     */
    includeAllowlisted?: boolean;
  } = {}
): Promise<ScanSummary> => {
  const config = await loadConfig(tuckDir);
  const security = config.security || {};

  const allowlist = await loadAllowlist(tuckDir);

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
      const externalSummary = await scanWithScanner(filepaths, configuredScanner);
      return options.includeAllowlisted
        ? externalSummary
        : filterSummaryWithAllowlist(externalSummary, allowlist.entries);
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

  const summary = await scanFiles(filepaths, {
    customPatterns: customPatterns.length > 0 ? customPatterns : undefined,
    excludePatternIds: security.excludePatterns,
    minSeverity: security.minSeverity,
    maxFileSize: security.maxFileSize,
  });

  return options.includeAllowlisted
    ? summary
    : filterSummaryWithAllowlist(summary, allowlist.entries);
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

  // Seed reuse from the persisted store: same value -> same placeholder across
  // runs. With repo-only redaction the live file keeps its secrets, so the same
  // values are re-detected on every future scan; without seeding, each run would
  // mint API_KEY_1, API_KEY_2, ... and orphan the earlier names.
  const existing = await getAllSecrets(tuckDir);
  const valueToExisting = new Map<string, string>();
  // FIRST-wins inversion — this MUST match getStoredValueMap's inversion order
  // in redactor.ts. When a store holds the SAME value under two names (legacy
  // pre-fix duplicate-name bug, or `tuck secrets set` twice), redaction and
  // drift compare must pick the IDENTICAL placeholder. If they diverge (one
  // last-wins, one first-wins), redaction writes `{{API_KEY_1}}` into the repo
  // copy while drift compare redacts live content as `{{API_KEY}}`, the
  // checksums never converge, and the file is re-prompted forever.
  for (const [name, value] of Object.entries(existing)) {
    if (!valueToExisting.has(value)) valueToExisting.set(value, name);
  }
  // Reserve every stored name so a NEW distinct value can't steal it.
  for (const name of Object.keys(existing)) usedPlaceholders.add(name);

  for (const result of results) {
    const placeholderMap = new Map<string, string>();

    for (const match of result.matches) {
      // Check if we already have this value mapped
      let existingPlaceholder: string | undefined;
      
      // First check the current file's map to avoid duplicates within the same file
      if (placeholderMap.has(match.value)) {
        existingPlaceholder = placeholderMap.get(match.value);
      } else if (valueToExisting.has(match.value)) {
        // Then reuse a name already committed to the store for this exact value.
        // If the scanner now derives a nicer identifier-based placeholder than the
        // stored one, we deliberately keep the STORED name: stability of the
        // placeholder committed to the repo copy wins over nicer naming.
        existingPlaceholder = valueToExisting.get(match.value);
      } else {
        // Then check previous files
        for (const map of fileRedactionMaps.values()) {
          if (map.has(match.value)) {
            existingPlaceholder = map.get(match.value);
            break;
          }
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
