/**
 * tuck secrets - Manage local secrets for placeholder replacement
 *
 * Commands:
 *   tuck secrets list          - List all stored secrets (values hidden)
 *   tuck secrets set <n>       - Set a secret value
 *   tuck secrets unset <name>  - Remove a secret
 *   tuck secrets path          - Show path to secrets file
 *   tuck secrets scan-history  - Scan git history for leaked secrets
 *   tuck secrets backend       - Manage secret backends (1Password, Bitwarden, pass)
 *   tuck secrets map           - Map placeholder to backend path
 *   tuck secrets mappings      - List all mappings
 *   tuck secrets test          - Test backend connectivity
 */

import { readFile } from 'fs/promises';
import { Command } from 'commander';
import { prompts, logger, colors as c } from '../ui/index.js';
import { getTuckDir, expandPath, collapsePath, pathExists } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles } from '../lib/manifest.js';
import { loadConfig, saveConfig } from '../lib/config.js';
import { atomicWriteFile } from '../lib/files.js';
import { createSnapshot } from '../lib/timemachine.js';
import {
  listSecrets,
  setSecret,
  unsetSecret,
  getSecretsPath,
  isValidSecretName,
  normalizeSecretName,
  scanForSecrets,
  redactSecret,
  discoverMcpConfigFiles,
  extractMcpSecrets,
  type ScanSummary,
  type McpExtraction,
  type McpReferenceFormat,
  computeFingerprint,
  addAllowlistEntryByFingerprint,
  removeAllowlistEntries,
  listAllowlistEntries,
  getAllowlistPath,
  type AllowlistEntry,
} from '../lib/secrets/index.js';
import {
  createResolver,
  setMapping,
  listMappings,
  CONFIGURABLE_BACKEND_NAMES,
  type ConfiguredBackendName,
} from '../lib/secretBackends/index.js';
import { NotInitializedError, TuckError, ValidationError } from '../errors.js';
import { logSecretAllowlisted, logSecretAllowlistRemoved } from '../lib/audit.js';
import { getLog } from '../lib/git.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';

const isConfiguredBackendName = (value: string): value is ConfiguredBackendName => {
  return (CONFIGURABLE_BACKEND_NAMES as readonly string[]).includes(value);
};

/**
 * Validate URL format (basic validation)
 */
const isValidUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

// ============================================================================
// List Command
// ============================================================================

interface JsonOptions {
  json?: boolean;
}

const runSecretsList = async (options: JsonOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets list');

  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const secrets = await listSecrets(tuckDir);

  if (isJsonMode()) {
    // SECURITY: listSecrets never returns raw values; emit only the redacted
    // metadata (name, placeholder, description, source, timestamps).
    emitJsonOk({
      secrets: secrets.map((secret) => ({
        name: secret.name,
        placeholder: secret.placeholder,
        ...(secret.description !== undefined ? { description: secret.description } : {}),
        ...(secret.source !== undefined ? { source: secret.source } : {}),
        addedAt: secret.addedAt,
        ...(secret.lastUsed !== undefined ? { lastUsed: secret.lastUsed } : {}),
      })),
    });
    return;
  }

  if (secrets.length === 0) {
    logger.info('No secrets stored');
    logger.dim(`Secrets file: ${getSecretsPath(tuckDir)}`);
    console.log();
    logger.dim('Secrets are stored when you choose to replace detected secrets with placeholders.');
    logger.dim('You can also manually add secrets with: tuck secrets set <NAME>');
    return;
  }

  console.log();
  console.log(c.bold.cyan(`Stored Secrets (${secrets.length})`));
  console.log(c.dim('─'.repeat(50)));
  console.log();

  for (const secret of secrets) {
    console.log(`  ${c.green(secret.name)}`);
    console.log(`    ${c.dim('Placeholder:')} ${c.cyan(secret.placeholder)}`);
    if (secret.description) {
      console.log(`    ${c.dim('Type:')} ${secret.description}`);
    }
    if (secret.source) {
      console.log(`    ${c.dim('Source:')} ${secret.source}`);
    }
    console.log(`    ${c.dim('Added:')} ${new Date(secret.addedAt).toLocaleDateString()}`);
    console.log();
  }

  logger.dim(`Secrets file: ${getSecretsPath(tuckDir)}`);
};

// ============================================================================
// Set Command
// ============================================================================

interface SecretsSetOptions {
  json?: boolean;
  yes?: boolean;
}

const runSecretsSet = async (name: string, options: SecretsSetOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets set');

  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Validate or normalize name
  if (!isValidSecretName(name)) {
    const normalized = normalizeSecretName(name);
    if (!isJsonMode()) {
      logger.warning(`Secret name normalized to: ${normalized}`);
      logger.dim('Secret names must be uppercase alphanumeric with underscores (e.g., API_KEY)');
    }
    name = normalized;
  }

  // In non-interactive mode (--json/--yes) we cannot prompt. Accept the value
  // from TUCK_SECRET_VALUE so it never lands in argv/shell history, mirroring
  // the interactive password prompt's "no value on the command line" rule.
  let secretValue: string;
  if (isJsonMode() || options.yes) {
    secretValue = process.env.TUCK_SECRET_VALUE ?? '';
    if (!secretValue || secretValue.trim().length === 0) {
      throw new TuckError(
        'Secret value not provided',
        'SECRET_VALUE_REQUIRED',
        ['Set TUCK_SECRET_VALUE in the environment before running with --json/--yes']
      );
    }
  } else {
    // Security: Always prompt for secret value interactively
    // Never accept via command-line to prevent exposure in shell history and process list
    // Note: Cancellation or empty input is handled below by validating the returned value.
    secretValue = await prompts.password(`Enter value for ${name}:`);

    if (!secretValue || secretValue.trim().length === 0) {
      logger.error('Secret value cannot be empty');
      return;
    }
  }

  await setSecret(tuckDir, name, secretValue);

  if (isJsonMode()) {
    // SECURITY: never echo the value back; only confirm the name and outcome.
    emitJsonOk({ name, set: true });
    return;
  }

  logger.success(`Secret '${name}' set`);
  console.log();
  logger.dim(`Use {{${name}}} as placeholder in your dotfiles`);
};

// ============================================================================
// Unset Command
// ============================================================================

const runSecretsUnset = async (name: string, options: JsonOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets unset');

  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const removed = await unsetSecret(tuckDir, name);

  if (isJsonMode()) {
    emitJsonOk({ name, unset: removed });
    return;
  }

  if (removed) {
    logger.success(`Secret '${name}' removed`);
  } else {
    logger.warning(`Secret '${name}' not found`);
    logger.dim('Run `tuck secrets list` to see stored secrets');
  }
};

// ============================================================================
// Path Command
// ============================================================================

const runSecretsPath = async (options: JsonOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets path');

  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const path = getSecretsPath(tuckDir);

  if (isJsonMode()) {
    emitJsonOk({ path });
    return;
  }

  console.log(path);
};

// ============================================================================
// Scan History Command
// ============================================================================

interface HistoryScanResult {
  commit: string;
  author: string;
  date: string;
  message: string;
  secrets: Array<{
    file: string;
    pattern: string;
    severity: string;
    redactedValue: string;
  }>;
}

const runScanHistory = async (options: { since?: string; limit?: string }): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 50;

  prompts.intro('tuck secrets scan-history');

  const spinner = prompts.spinner();
  spinner.start('Scanning git history for secrets...');

  try {
    // Get commit log using existing function
    const logEntries = await getLog(tuckDir, {
      maxCount: limit,
      since: options.since,
    });

    if (logEntries.length === 0) {
      spinner.stop('No commits found');
      return;
    }

    // Import simpleGit directly for diff operations
    let simpleGit;
    try {
      simpleGit = (await import('simple-git')).default;
    } catch (importError) {
      spinner.stop('Git integration is unavailable (simple-git module could not be loaded).');
      const errorMsg = importError instanceof Error ? importError.message : String(importError);
      logger.error(`Failed to load simple-git for scan-history: ${errorMsg}`);
      return;
    }
    const git = simpleGit(tuckDir);

    const results: HistoryScanResult[] = [];
    let scannedCommits = 0;

    for (const entry of logEntries) {
      scannedCommits++;
      spinner.message(`Scanning commit ${scannedCommits}/${logEntries.length}...`);

      // Get diff for this commit
      try {
        const diff = await git.diff([`${entry.hash}^`, entry.hash]);

        if (diff) {
          // Extract added lines (those starting with +)
          const addedLines = diff
            .split('\n')
            .filter((line: string) => line.startsWith('+') && !line.startsWith('+++'))
            .map((line: string) => line.slice(1))
            .join('\n');

          if (addedLines) {
            // Scan the added content
            const { scanContent } = await import('../lib/secrets/scanner.js');
            const matches = scanContent(addedLines);

            if (matches.length > 0) {
              results.push({
                commit: entry.hash.slice(0, 8),
                author: entry.author,
                date: entry.date,
                message: entry.message.slice(0, 50),
                secrets: matches.map((m) => ({
                  file: 'diff',
                  pattern: m.patternName,
                  severity: m.severity,
                  redactedValue: m.redactedValue,
                })),
              });
            }
          }
        }
      } catch (error) {
        // Skip commits that can't be diffed (e.g., initial commit), but log for visibility
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warning(
          `Skipping commit ${entry.hash.slice(
            0,
            8
          )}: unable to diff against parent (possibly initial/root commit). ${errorMsg}`
        );
        continue;
      }
    }

    spinner.stop(`Scanned ${scannedCommits} commits`);

    if (results.length === 0) {
      console.log();
      logger.success('No secrets found in git history');
      prompts.outro('Clean history!');
      return;
    }

    // Display results
    console.log();
    console.log(c.bold.red(`Found potential secrets in ${results.length} commits`));
    console.log(c.dim('─'.repeat(60)));
    console.log();

    for (const result of results) {
      console.log(c.yellow(`Commit: ${result.commit}`));
      console.log(c.dim(`  Author: ${result.author}`));
      console.log(c.dim(`  Date: ${result.date}`));
      console.log(c.dim(`  Message: ${result.message}`));
      console.log();

      for (const secret of result.secrets) {
        const severityColor =
          secret.severity === 'critical' ? c.red : secret.severity === 'high' ? c.yellow : c.dim;
        console.log(`    ${severityColor(`[${secret.severity}]`)} ${secret.pattern}`);
        console.log(c.dim(`      Value: ${secret.redactedValue}`));
      }
      console.log();
    }

    console.log(c.dim('─'.repeat(60)));
    console.log();
    logger.warning('If these secrets are still valid, rotate them immediately!');
    console.log();
    logger.dim('To remove secrets from git history, consider using:');
    logger.dim('  - git filter-branch');
    logger.dim('  - BFG Repo-Cleaner (https://rtyley.github.io/bfg-repo-cleaner/)');

    prompts.outro(c.red(`${results.length} commits with potential secrets`));
  } catch (error) {
    spinner.stop('Scan failed');
    throw error;
  }
};

// ============================================================================
// Interactive Scan Command
// ============================================================================

interface ScanFilesOptions {
  json?: boolean;
}

/**
 * Build a REDACTED summary of a scan suitable for JSON output.
 *
 * SECURITY-CRITICAL: this MUST NEVER include raw secret values, raw matched
 * lines, or surrounding context. Only emit aggregate counts and a per-file
 * `{ path, secretCount }` summary. Do not pass through `match.value`,
 * `match.context`, or `match.redactedValue` (the file-level count is enough).
 */
const buildRedactedScanSummary = (summary: ScanSummary) => ({
  totalFiles: summary.totalFiles,
  scannedFiles: summary.scannedFiles,
  skippedFiles: summary.skippedFiles,
  filesWithSecrets: summary.filesWithSecrets,
  totalSecrets: summary.totalSecrets,
  bySeverity: {
    critical: summary.bySeverity.critical,
    high: summary.bySeverity.high,
    medium: summary.bySeverity.medium,
    low: summary.bySeverity.low,
  },
  files: summary.results
    .filter((result) => result.hasSecrets)
    .map((result) => ({
      path: result.collapsedPath,
      secretCount: result.matches.length,
    })),
});

const runScanFiles = async (paths: string[], options: ScanFilesOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets scan');

  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const expandedPaths =
    paths.length > 0
      ? paths.map((path) => expandPath(path))
      : Array.from(
          new Set(
            Object.values(await getAllTrackedFiles(tuckDir)).map((file) => expandPath(file.source))
          )
        );

  if (expandedPaths.length === 0) {
    if (isJsonMode()) {
      emitJsonOk(
        buildRedactedScanSummary({
          totalFiles: 0,
          scannedFiles: 0,
          skippedFiles: 0,
          filesWithSecrets: 0,
          totalSecrets: 0,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
          results: [],
        })
      );
      return;
    }
    logger.warning('No tracked files to scan');
    logger.dim("Run 'tuck add <path>' to start tracking files first");
    return;
  }

  // Check files exist
  for (const path of expandedPaths) {
    if (!(await pathExists(path))) {
      if (!isJsonMode()) logger.warning(`File not found: ${path}`);
    }
  }

  const existingPaths = [];
  for (const path of expandedPaths) {
    if (await pathExists(path)) {
      existingPaths.push(path);
    }
  }

  if (existingPaths.length === 0) {
    if (isJsonMode()) {
      emitJsonOk(
        buildRedactedScanSummary({
          totalFiles: 0,
          scannedFiles: 0,
          skippedFiles: 0,
          filesWithSecrets: 0,
          totalSecrets: 0,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
          results: [],
        })
      );
      return;
    }
    logger.error('No valid files to scan');
    return;
  }

  // Skip the clack spinner in JSON mode — its ANSI frames would land on stdout
  // ahead of the envelope and break JSON.parse for the consuming agent/CI.
  const spinner = isJsonMode() ? null : prompts.spinner();
  spinner?.start(`Scanning ${existingPaths.length} file(s)...`);

  const summary = await scanForSecrets(existingPaths, tuckDir);

  spinner?.stop('Scan complete');

  if (isJsonMode()) {
    emitJsonOk(buildRedactedScanSummary(summary));
    return;
  }

  if (summary.filesWithSecrets === 0) {
    console.log();
    logger.success('No secrets detected');
    return;
  }

  // Display results
  displayScanResults(summary);
};

/**
 * Display scan results in a formatted way
 */
export const displayScanResults = (summary: ScanSummary): void => {
  console.log();
  console.log(
    c.bold.red(
      `Found ${summary.totalSecrets} potential secret(s) in ${summary.filesWithSecrets} file(s)`
    )
  );
  console.log(c.dim('─'.repeat(60)));
  console.log();

  // Summary by severity
  if (summary.bySeverity.critical > 0) {
    console.log(c.red(`  Critical: ${summary.bySeverity.critical}`));
  }
  if (summary.bySeverity.high > 0) {
    console.log(c.yellow(`  High: ${summary.bySeverity.high}`));
  }
  if (summary.bySeverity.medium > 0) {
    console.log(c.blue(`  Medium: ${summary.bySeverity.medium}`));
  }
  if (summary.bySeverity.low > 0) {
    console.log(c.dim(`  Low: ${summary.bySeverity.low}`));
  }
  console.log();

  // Details by file
  for (const result of summary.results) {
    console.log(c.cyan(result.collapsedPath));

    for (const match of result.matches) {
      const severityColor =
        match.severity === 'critical'
          ? c.red
          : match.severity === 'high'
            ? c.yellow
            : match.severity === 'medium'
              ? c.blue
              : c.dim;

      console.log(
        `  ${c.dim(`Line ${match.line}:`)} ${severityColor(`[${match.severity}]`)} ${match.patternName}`
      );
      console.log(c.dim(`    ${match.context}`));
    }
    console.log();
  }
};

// ============================================================================
// Backend Commands
// ============================================================================

interface BackendSetOptions {
  vault?: string;
  serverUrl?: string;
  storePath?: string;
}

const runBackendSet = async (backend: string, options: BackendSetOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Validate backend name using type guard
  if (!isConfiguredBackendName(backend)) {
    logger.error(`Invalid backend: ${backend}`);
    logger.dim(`Valid backends: ${CONFIGURABLE_BACKEND_NAMES.join(', ')}`);
    return;
  }

  // Validate backend-specific options
  if (backend === 'bitwarden' && options.serverUrl) {
    if (!isValidUrl(options.serverUrl)) {
      logger.error(`Invalid server URL: ${options.serverUrl}`);
      logger.dim('URL must be a valid URL (e.g., https://vault.example.com)');
      return;
    }
    // Warn if a non-HTTPS URL is provided, as HTTPS is recommended for Bitwarden
    try {
      const parsedUrl = new URL(options.serverUrl);
      if (parsedUrl.protocol !== 'https:') {
        logger.warning(`Bitwarden server URL is not using HTTPS: ${options.serverUrl}`);
        logger.dim('Using HTTPS is strongly recommended for Bitwarden to protect your secrets.');
      }
    } catch {
      // isValidUrl already validated the URL; this is a safety net
    }
  }

  if (backend === 'pass' && options.storePath) {
    const expandedPath = expandPath(options.storePath);
    if (!(await pathExists(expandedPath))) {
      logger.warning(`Password store path does not exist: ${options.storePath}`);
      logger.dim('The path will be used anyway, but make sure it exists before using pass.');
    }
  }

  const config = await loadConfig(tuckDir);

  // Build updated security config
  const existingBackends = config.security.backends || {};
  const updatedBackends: Record<string, Record<string, unknown>> = {};

  // Add backend-specific config
  if (backend === '1password' && options.vault) {
    updatedBackends['1password'] = {
      ...(existingBackends['1password'] || {}),
      vault: options.vault,
    };
  }
  if (backend === 'bitwarden' && options.serverUrl) {
    updatedBackends.bitwarden = {
      ...(existingBackends.bitwarden || {}),
      serverUrl: options.serverUrl,
    };
  }
  if (backend === 'pass' && options.storePath) {
    updatedBackends.pass = {
      ...(existingBackends.pass || {}),
      storePath: options.storePath,
    };
  }

  const updatedSecurity = {
    ...config.security,
    secretBackend: backend,
    ...(Object.keys(updatedBackends).length > 0 ? { backends: { ...existingBackends, ...updatedBackends } } : {}),
  };

  // Save updated security configuration
  await saveConfig({ security: updatedSecurity }, tuckDir);
  logger.success(`Secret backend set to: ${backend}`);

  // Show setup instructions if not local
  if (backend !== 'local' && backend !== 'auto') {
    const resolver = createResolver(tuckDir, { ...config.security, secretBackend: backend });
    const backendImpl = resolver.getBackend(backend);
    if (backendImpl) {
      console.log();
      console.log(c.dim(backendImpl.getSetupInstructions()));
    }
  }
};

const runBackendStatus = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const config = await loadConfig(tuckDir);
  const resolver = createResolver(tuckDir, config.security);
  const statuses = await resolver.getBackendStatuses();
  const configuredBackend = resolver.getConfiguredBackendName();
  const effectiveBackend = await resolver.getEffectiveBackendName();

  console.log();
  console.log(c.bold.cyan('Secret Backend Status'));
  console.log(c.dim('─'.repeat(50)));
  console.log();

  for (const status of statuses) {
    const primaryMark = status.isPrimary ? c.cyan(' (active)') : '';
    const availableIcon = status.available ? c.green('✓') : c.red('✗');
    const authIcon = status.authenticated ? c.green('✓') : c.yellow('○');

    console.log(`  ${status.displayName}${primaryMark}`);
    console.log(`    ${availableIcon} CLI installed: ${status.available ? 'Yes' : 'No'}`);
    if (status.available) {
      console.log(`    ${authIcon} Authenticated: ${status.authenticated ? 'Yes' : 'No'}`);
    }
    console.log();
  }

  if (configuredBackend === 'auto') {
    console.log(c.dim(`Current backend: auto (resolved to ${effectiveBackend})`));
  } else {
    console.log(c.dim(`Current backend: ${configuredBackend}`));
  }
};

const runBackendList = async (): Promise<void> => {
  console.log();
  console.log(c.bold.cyan('Available Secret Backends'));
  console.log(c.dim('─'.repeat(50)));
  console.log();

  const backends = [
    {
      name: 'auto',
      desc: 'Auto-detect the best available external backend, then fall back to local',
    },
    { name: 'local', desc: 'Local secrets file (explicit fallback)' },
    { name: '1password', desc: '1Password password manager' },
    { name: 'bitwarden', desc: 'Bitwarden password manager' },
    { name: 'pass', desc: 'Standard Unix password store' },
  ];

  for (const b of backends) {
    console.log(`  ${c.green(b.name)}`);
    console.log(`    ${c.dim(b.desc)}`);
    console.log();
  }

  console.log(c.dim('Set backend with: tuck secrets backend set <name>'));
};

// ============================================================================
// Mapping Commands
// ============================================================================

interface MapOptions {
  '1password'?: string;
  bitwarden?: string;
  pass?: string;
  local?: boolean;
}

const runMap = async (name: string, options: MapOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Validate name
  if (!isValidSecretName(name)) {
    const normalized = normalizeSecretName(name);
    logger.warning(`Secret name normalized to: ${normalized}`);
    name = normalized;
  }

  let mappingsAdded = 0;

  if (options['1password']) {
    await setMapping(tuckDir, name, '1password', options['1password']);
    logger.success(`Mapped ${name} → 1Password: ${options['1password']}`);
    mappingsAdded++;
  }

  if (options.bitwarden) {
    await setMapping(tuckDir, name, 'bitwarden', options.bitwarden);
    logger.success(`Mapped ${name} → Bitwarden: ${options.bitwarden}`);
    mappingsAdded++;
  }

  if (options.pass) {
    await setMapping(tuckDir, name, 'pass', options.pass);
    logger.success(`Mapped ${name} → pass: ${options.pass}`);
    mappingsAdded++;
  }

  if (options.local) {
    await setMapping(tuckDir, name, 'local', true);
    logger.success(`Mapped ${name} → local store`);
    mappingsAdded++;
  }

  if (mappingsAdded === 0) {
    logger.error('No backend specified');
    logger.dim('Usage: tuck secrets map <name> --1password "op://..." --bitwarden "..." --pass "..."');
  }
};

const runMappings = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const mappings = await listMappings(tuckDir);
  const entries = Object.entries(mappings);

  if (entries.length === 0) {
    logger.info('No secret mappings configured');
    console.log();
    logger.dim('Add mappings with: tuck secrets map <name> --1password "op://..."');
    return;
  }

  console.log();
  console.log(c.bold.cyan(`Secret Mappings (${entries.length})`));
  console.log(c.dim('─'.repeat(50)));
  console.log();

  for (const [name, mapping] of entries) {
    console.log(`  ${c.green(name)}`);
    if (mapping['1password']) {
      console.log(`    ${c.dim('1Password:')} ${mapping['1password']}`);
    }
    if (mapping.bitwarden) {
      console.log(`    ${c.dim('Bitwarden:')} ${mapping.bitwarden}`);
    }
    if (mapping.pass) {
      console.log(`    ${c.dim('pass:')} ${mapping.pass}`);
    }
    if (mapping.local) {
      console.log(`    ${c.dim('local:')} yes`);
    }
    console.log();
  }
};

// ============================================================================
// Test Command
// ============================================================================

interface TestOptions {
  backend?: string;
}

const runTest = async (options: TestOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const config = await loadConfig(tuckDir);
  const resolver = createResolver(tuckDir, config.security);

  // Validate and narrow backend name
  const rawBackendName = options.backend || config.security.secretBackend || 'auto';
  if (!isConfiguredBackendName(rawBackendName)) {
    logger.error(`Invalid backend: ${rawBackendName}`);
    logger.dim(`Valid backends: ${CONFIGURABLE_BACKEND_NAMES.join(', ')}`);
    return;
  }
  const backendName =
    rawBackendName === 'auto' ? await resolver.getEffectiveBackendName() : rawBackendName;

  prompts.intro(
    rawBackendName === 'auto'
      ? `tuck secrets test (auto -> ${backendName})`
      : `tuck secrets test (${backendName})`
  );

  const spinner = prompts.spinner();
  spinner.start('Checking backend availability...');

  const backend = resolver.getBackend(backendName);
  if (!backend) {
    spinner.stop('Unknown backend');
    logger.error(`Unknown backend: ${backendName}`);
    return;
  }

  // Check availability
  const available = await backend.isAvailable();
  if (!available) {
    spinner.stop('Backend not available');
    console.log();
    logger.error(`${backend.displayName} CLI is not installed`);
    console.log();
    console.log(c.dim(backend.getSetupInstructions()));
    return;
  }

  spinner.message('Checking authentication...');

  // Check authentication
  const authenticated = await backend.isAuthenticated();
  if (!authenticated) {
    spinner.stop('Not authenticated');
    console.log();
    logger.warning(`Not authenticated with ${backend.displayName}`);
    console.log();
    console.log(c.dim(backend.getSetupInstructions()));
    return;
  }

  spinner.stop('Backend ready');
  console.log();
  logger.success(`${backend.displayName} is available and authenticated`);

  // Try to list secrets if supported
  if (backend.listSecrets) {
    const secrets = await backend.listSecrets();
    if (secrets.length > 0) {
      console.log();
      logger.info(`Found ${secrets.length} secret(s) in ${backend.displayName}`);
    }
  }

  prompts.outro('Backend test passed!');
};

// ============================================================================
// Extract Command (MCP secrets)
// ============================================================================

interface ExtractOptions {
  mcp?: boolean;
  format?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** A single file's extraction outcome (kept together for reporting). */
interface FileExtraction {
  path: string; // expanded
  collapsedPath: string;
  rewritten: string;
  original: string;
  extractions: McpExtraction[];
}

const isReferenceFormat = (value: string): value is McpReferenceFormat =>
  value === 'placeholder' || value === 'env';

/**
 * Resolve the set of files to scan for MCP secrets.
 *
 * Explicit paths are always included; `--mcp` adds every known MCP config file
 * that currently exists on disk.
 */
const resolveExtractTargets = async (
  explicitPaths: string[],
  useMcp: boolean
): Promise<string[]> => {
  const targets = new Set<string>();

  for (const p of explicitPaths) {
    targets.add(expandPath(p));
  }

  if (useMcp) {
    const discovered = await discoverMcpConfigFiles();
    for (const target of discovered) {
      targets.add(target.expandedPath);
    }
  }

  return [...targets];
};

export const runExtract = async (paths: string[], options: ExtractOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets extract');

  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Only MCP extraction is supported today; require --mcp (or explicit paths)
  // so the flag stays meaningful as more extractors are added.
  const useMcp = options.mcp === true;
  if (!useMcp && paths.length === 0) {
    if (isJsonMode()) {
      throw new TuckError(
        'Nothing to extract',
        'EXTRACT_NO_TARGET',
        ['Pass --mcp to scan known MCP config files, or provide explicit paths']
      );
    }
    logger.error('Nothing to extract');
    logger.dim('Pass --mcp to scan known MCP config files, or provide explicit file paths.');
    return;
  }

  const format: McpReferenceFormat = (() => {
    const raw = options.format ?? 'placeholder';
    if (!isReferenceFormat(raw)) {
      throw new TuckError(`Invalid --format: ${raw}`, 'EXTRACT_BAD_FORMAT', [
        'Valid formats: placeholder (tuck {{NAME}}), env (${env:NAME})',
      ]);
    }
    return raw;
  })();

  const targetFiles = await resolveExtractTargets(paths, useMcp);

  if (targetFiles.length === 0) {
    if (isJsonMode()) {
      emitJsonOk({ files: [], totalExtracted: 0, changed: false });
      return;
    }
    logger.info('No MCP config files found');
    logger.dim('Checked known locations (Claude Desktop, ~/.claude.json, .cursor/mcp.json, …).');
    return;
  }

  // Analyze each file. A shared placeholder set keeps names unique across files.
  //
  // SAFETY: seed the set with the names of secrets that are ALREADY stored and
  // with existing mapping names so a generated placeholder can never collide
  // with — and silently overwrite — a pre-existing stored value. The secrets
  // store is the only cleartext copy of those values and is not covered by the
  // pre-extract snapshot, so a collision would be unrecoverable. Colliding names
  // get the `_1`, `_2`, … suffix instead (e.g. `GITHUB_TOKEN` → `GITHUB_TOKEN_1`).
  const existingPlaceholders = new Set<string>();
  for (const secret of await listSecrets(tuckDir)) {
    existingPlaceholders.add(secret.name);
  }
  for (const mappingName of Object.keys(await listMappings(tuckDir))) {
    existingPlaceholders.add(mappingName);
  }
  const fileResults: FileExtraction[] = [];
  let totalExtracted = 0;
  let totalSkipped = 0;

  for (const expandedPath of targetFiles) {
    if (!(await pathExists(expandedPath))) {
      if (!isJsonMode()) logger.warning(`File not found: ${collapsePath(expandedPath)}`);
      continue;
    }

    let content: string;
    try {
      content = await readFile(expandedPath, 'utf-8');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isJsonMode()) logger.warning(`Cannot read ${collapsePath(expandedPath)}: ${msg}`);
      continue;
    }

    let result;
    try {
      result = extractMcpSecrets(content, { format, existingPlaceholders }, collapsePath(expandedPath));
    } catch (error) {
      // Invalid JSON (McpConfigError) — skip the file but keep going.
      const msg = error instanceof Error ? error.message : String(error);
      if (!isJsonMode()) logger.warning(msg);
      continue;
    }

    for (const extraction of result.extractions) {
      existingPlaceholders.add(extraction.placeholder);
    }

    totalSkipped += result.skipped.length;

    // Warn about credentials tuck detected but could NOT locate verbatim in the
    // source (JSON escape variants re-encode differently). These are left in the
    // file as-is and are NOT stored/mapped/reported as extracted — surfacing the
    // plaintext secret is exactly what this command exists to prevent.
    if (result.skipped.length > 0 && !isJsonMode()) {
      logger.warning(
        `Could not rewrite ${result.skipped.length} credential(s) in ${collapsePath(expandedPath)} ` +
          `(the value uses a JSON encoding tuck cannot match). Left untouched — the plaintext ` +
          `secret is still in the file. Re-save the value without escape sequences and re-run.`
      );
      for (const ex of result.skipped) {
        logger.dim(`  skipped: ${ex.server}.${ex.field}.${ex.key}`);
      }
    }

    if (result.extractions.length > 0) {
      totalExtracted += result.extractions.length;
      fileResults.push({
        path: expandedPath,
        collapsedPath: collapsePath(expandedPath),
        rewritten: result.rewritten,
        original: result.original,
        extractions: result.extractions,
      });
    }
  }

  if (totalExtracted === 0) {
    if (isJsonMode()) {
      emitJsonOk({ files: [], totalExtracted: 0, totalSkipped, changed: false });
      return;
    }
    if (totalSkipped > 0) {
      // Everything detected was left untouched (unmatchable encoding). Do NOT
      // claim the files are clean — the plaintext is still there.
      logger.warning(
        `Detected ${totalSkipped} credential(s) but could not safely rewrite any of them.`
      );
      logger.dim('The plaintext values remain in place — see the warnings above.');
      return;
    }
    logger.success('No inline MCP credentials found');
    logger.dim('Your MCP config files are already free of plaintext secrets.');
    return;
  }

  // ---- Preview (redacted) ----
  if (!isJsonMode()) {
    console.log();
    console.log(
      c.bold.cyan(
        `Found ${totalExtracted} inline credential(s) in ${fileResults.length} MCP config file(s)`
      )
    );
    console.log(c.dim('─'.repeat(60)));
    for (const file of fileResults) {
      console.log();
      console.log(c.cyan(file.collapsedPath));
      for (const ex of file.extractions) {
        console.log(
          `  ${c.dim(`${ex.server}.${ex.field}.${ex.key}`)} → ${c.green(ex.reference)} ${c.dim(
            redactSecret(ex.value)
          )}`
        );
      }
    }
    console.log();
  }

  // ---- Dry-run stops here ----
  if (options.dryRun) {
    if (isJsonMode()) {
      emitJsonOk({
        dryRun: true,
        changed: true,
        totalExtracted,
        totalSkipped,
        files: fileResults.map((f) => buildRedactedExtractionSummary(f)),
      });
      return;
    }
    logger.info('Dry run: no files were modified and no secrets were stored.');
    logger.dim('Re-run without --dry-run to apply the changes.');
    return;
  }

  // ---- Confirm (interactive only) ----
  if (!isJsonMode() && !options.yes) {
    logger.warning('This will rewrite the files above and store the extracted values.');
    const confirmed = await prompts.confirm(
      `Extract ${totalExtracted} credential(s) into ${format === 'env' ? '${env:…}' : 'tuck placeholders'}?`,
      false
    );
    if (!confirmed) {
      logger.info('Extraction cancelled — no changes made.');
      return;
    }
  }

  // ---- Snapshot backup before any mutation ----
  const snapshot = await createSnapshot(
    fileResults.map((f) => f.path),
    'Pre-extract backup before tuck secrets extract'
  );

  // ---- Store secrets + record mappings, then rewrite files ----
  const storedPlaceholders = new Set<string>();
  for (const file of fileResults) {
    for (const ex of file.extractions) {
      if (storedPlaceholders.has(ex.placeholder)) continue;
      storedPlaceholders.add(ex.placeholder);

      // Store the real value locally (0600, gitignored) so `tuck apply` can
      // inject it, and record a committed `local` mapping so other machines
      // know the placeholder exists.
      await setSecret(tuckDir, ex.placeholder, ex.value, {
        description: `MCP credential (${ex.server}.${ex.key})`,
        source: file.collapsedPath,
      });
      await setMapping(tuckDir, ex.placeholder, 'local', true);
    }

    // Only write when the content actually changed.
    if (file.rewritten !== file.original) {
      await atomicWriteFile(file.path, file.rewritten);
    }
  }

  if (isJsonMode()) {
    emitJsonOk({
      changed: true,
      totalExtracted,
      totalSkipped,
      snapshotId: snapshot.id,
      backend: 'local',
      format,
      files: fileResults.map((f) => buildRedactedExtractionSummary(f)),
    });
    return;
  }

  logger.success(
    `Extracted ${totalExtracted} credential(s) from ${fileResults.length} file(s)`
  );
  console.log();
  logger.dim(`Snapshot saved: ${snapshot.id} (run 'tuck undo' to revert)`);
  console.log();
  prompts.note(
    [
      `Track the rewritten file(s) so 'tuck apply' can re-inject the values:`,
      ...fileResults.map((f) => `  tuck add ${f.collapsedPath}`),
      ...(format === 'env'
        ? ['', 'Using ${env:…}: export the matching env vars before launching the client.']
        : ['', "Values are stored locally. Run 'tuck apply' on a new machine to inject them."]),
      '',
      'To move a value into an external backend (1Password/pass):',
      '  tuck secrets map <NAME> --1password "op://vault/item/field"',
    ].join('\n'),
    'Next steps'
  );
};

/**
 * Build a REDACTED per-file summary for JSON output.
 *
 * SECURITY-CRITICAL: never include the raw credential value. Only emit the
 * placeholder/reference metadata and location.
 */
const buildRedactedExtractionSummary = (file: FileExtraction) => ({
  path: file.collapsedPath,
  extracted: file.extractions.length,
  credentials: file.extractions.map((ex) => ({
    server: ex.server,
    scope: ex.scope,
    field: ex.field,
    key: ex.key,
    placeholder: ex.placeholder,
    reference: ex.reference,
  })),
});

// ============================================================================
// Allowlist Commands
// ============================================================================

const SHORT_FINGERPRINT_LENGTH = 12;

const isFingerprint = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);

const formatAllowEntry = (entry: AllowlistEntry): void => {
  console.log(`  ${c.green(entry.fingerprint.slice(0, SHORT_FINGERPRINT_LENGTH))}${c.dim('…')}`);
  console.log(`    ${c.dim('Reason:')} ${entry.reason}`);
  if (entry.pattern) console.log(`    ${c.dim('Pattern:')} ${entry.pattern}`);
  if (entry.path) console.log(`    ${c.dim('Path:')} ${entry.path}`);
  if (entry.addedBy) console.log(`    ${c.dim('Added by:')} ${entry.addedBy}`);
  console.log(`    ${c.dim('Added:')} ${new Date(entry.addedAt).toLocaleDateString()}`);
  console.log();
};

const requireInitialized = async (tuckDir: string): Promise<void> => {
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
};

const runAllowList = async (options: JsonOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets allow list');
  const tuckDir = getTuckDir();
  await requireInitialized(tuckDir);

  const entries = await listAllowlistEntries(tuckDir);

  if (isJsonMode()) {
    // SECURITY: the allowlist already contains only fingerprints (no raw
    // values), so it is safe to emit verbatim.
    emitJsonOk({ entries });
    return;
  }

  if (entries.length === 0) {
    logger.info('No allowlisted findings');
    console.log();
    logger.dim(`Allowlist file: ${collapsePath(getAllowlistPath(tuckDir))}`);
    logger.dim('Mark a scanner false-positive as safe with: tuck secrets allow add --file <path>');
    return;
  }

  console.log();
  console.log(c.bold.cyan(`Allowlisted Findings (${entries.length})`));
  console.log(c.dim('─'.repeat(50)));
  console.log();
  for (const entry of entries) {
    formatAllowEntry(entry);
  }
  logger.dim(`Allowlist file: ${collapsePath(getAllowlistPath(tuckDir))} (committed & auditable)`);
};

interface AllowRemoveOptions extends JsonOptions {}

const runAllowRemove = async (
  fingerprint: string,
  options: AllowRemoveOptions = {}
): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets allow remove');
  const tuckDir = getTuckDir();
  await requireInitialized(tuckDir);

  const prefix = fingerprint.trim().toLowerCase();
  if (prefix.length === 0 || !/^[a-f0-9]+$/.test(prefix)) {
    throw new ValidationError('fingerprint', 'must be a hex fingerprint (or prefix)');
  }

  const removed = await removeAllowlistEntries(tuckDir, prefix);
  if (removed.length > 0) {
    await logSecretAllowlistRemoved(removed.map((entry) => entry.fingerprint));
  }

  if (isJsonMode()) {
    emitJsonOk({ removed: removed.length, fingerprints: removed.map((e) => e.fingerprint) });
    return;
  }

  if (removed.length === 0) {
    logger.warning(`No allowlist entry matching: ${fingerprint}`);
    logger.dim('Run `tuck secrets allow list` to see fingerprints');
    return;
  }
  logger.success(
    `Removed ${removed.length} allowlist entr${removed.length === 1 ? 'y' : 'ies'}`
  );
};

interface AllowAddOptions extends JsonOptions {
  reason?: string;
  file?: string;
  pattern?: string;
  fingerprint?: string;
  yes?: boolean;
}

/**
 * Add scanner findings to the centralized allowlist.
 *
 * Three input modes (none of which put a raw secret on the command line):
 *  - `--fingerprint <hash>`: allowlist a known fingerprint directly.
 *  - `--file <path>` [+ `--pattern <id>`]: re-scan the file and allowlist the
 *    matching findings by fingerprint (value never leaves the process).
 *  - interactive (TTY, no --file/--fingerprint): scan tracked files and let the
 *    user pick which findings to mark safe.
 */
const runAllowAdd = async (options: AllowAddOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck secrets allow add');
  const tuckDir = getTuckDir();
  await requireInitialized(tuckDir);

  const nonInteractive = isJsonMode() || options.yes === true || !process.stdout.isTTY;

  // Unscoped bulk allowlisting (no --file/--pattern/--fingerprint) permanently
  // disarms the secret gate for EVERY current finding — never do that on the
  // strength of a redirected stdout alone. Explicit --yes is required.
  if (
    nonInteractive &&
    options.yes !== true &&
    !options.file &&
    !options.pattern &&
    !options.fingerprint
  ) {
    throw new TuckError(
      'Refusing to allowlist ALL findings non-interactively',
      'ALLOW_ALL_REQUIRES_YES',
      [
        'Pass --yes to explicitly allowlist every finding across all tracked files',
        'Or scope the operation with --file <path>, --pattern <id>, or --fingerprint <fp>',
      ]
    );
  }

  // ---- Resolve a reason (required, keeps the allowlist auditable) ----
  const resolveReason = async (): Promise<string> => {
    if (options.reason && options.reason.trim().length > 0) return options.reason.trim();
    if (nonInteractive) {
      throw new TuckError('A reason is required', 'ALLOW_REASON_REQUIRED', [
        'Pass --reason "<why this value is safe>"',
      ]);
    }
    const reason = await prompts.text('Why is this value safe? (recorded in the allowlist)', {
      placeholder: 'e.g. example value from docs, not a real key',
    });
    if (!reason || reason.trim().length === 0) {
      throw new TuckError('A reason is required', 'ALLOW_REASON_REQUIRED');
    }
    return reason.trim();
  };

  // ---- Mode 1: direct fingerprint ----
  if (options.fingerprint) {
    const fp = options.fingerprint.trim().toLowerCase();
    if (!isFingerprint(fp)) {
      throw new ValidationError('fingerprint', 'must be a 64-char SHA-256 hex digest');
    }
    const reason = await resolveReason();
    const entry = await addAllowlistEntryByFingerprint(tuckDir, fp, {
      reason,
      pattern: options.pattern,
    });
    await logSecretAllowlisted(entry.fingerprint, entry.reason, {
      pattern: entry.pattern,
      path: entry.path,
    });
    if (isJsonMode()) {
      emitJsonOk({ added: 1, entries: [entry] });
      return;
    }
    logger.success(`Allowlisted ${entry.fingerprint.slice(0, SHORT_FINGERPRINT_LENGTH)}…`);
    return;
  }

  // ---- Determine which files to scan ----
  let scanPaths: string[];
  if (options.file) {
    const expanded = expandPath(options.file);
    if (!(await pathExists(expanded))) {
      throw new TuckError(`File not found: ${options.file}`, 'FILE_NOT_FOUND', [
        'Check the path and try again',
      ]);
    }
    scanPaths = [expanded];
  } else {
    scanPaths = Array.from(
      new Set(
        Object.values(await getAllTrackedFiles(tuckDir)).map((file) => expandPath(file.source))
      )
    );
  }

  if (scanPaths.length === 0) {
    if (isJsonMode()) {
      emitJsonOk({ added: 0, entries: [] });
      return;
    }
    logger.warning('No files to scan');
    return;
  }

  // Run the SAME config-aware scan the secret gate runs (same scanner choice,
  // custom patterns, and pattern ids — recorded scopes must match the gate),
  // but without the allowlist filter, which would hide the very matches the
  // user wants to add here.
  const summary = await scanForSecrets(scanPaths, tuckDir, { includeAllowlisted: true });

  if (summary.filesWithSecrets === 0) {
    if (isJsonMode()) {
      emitJsonOk({ added: 0, entries: [] });
      return;
    }
    logger.info('No findings to allowlist');
    return;
  }

  // Flatten to candidate findings (deduped by fingerprint+pattern+path).
  interface Candidate {
    value: string;
    fingerprint: string;
    patternId: string;
    patternName: string;
    collapsedPath: string;
    line: number;
    context: string;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const result of summary.results) {
    for (const match of result.matches) {
      if (options.pattern && match.patternId !== options.pattern) continue;
      const fingerprint = computeFingerprint(match.value);
      const key = `${fingerprint}:${match.patternId}:${result.collapsedPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        value: match.value,
        fingerprint,
        patternId: match.patternId,
        patternName: match.patternName,
        collapsedPath: result.collapsedPath,
        line: match.line,
        context: match.context,
      });
    }
  }

  if (candidates.length === 0) {
    if (isJsonMode()) {
      emitJsonOk({ added: 0, entries: [] });
      return;
    }
    logger.info('No findings matched the given filters');
    return;
  }

  // ---- Choose which candidates to allowlist ----
  let chosen: Candidate[];
  if (nonInteractive || options.file || options.pattern) {
    // Non-interactive / scoped: allowlist every matching finding.
    chosen = candidates;
  } else {
    const selected = await prompts.multiselect<string>(
      'Select findings to mark as safe (allowlist):',
      candidates.map((candidate, i) => ({
        value: String(i),
        label: `${candidate.patternName} — ${candidate.collapsedPath}:${candidate.line}`,
        hint: candidate.context,
      }))
    );
    if (!selected || selected.length === 0) {
      logger.info('Nothing selected');
      return;
    }
    const indices = new Set(selected.map((s) => parseInt(s, 10)));
    chosen = candidates.filter((_, i) => indices.has(i));
  }

  const reason = await resolveReason();
  const added: AllowlistEntry[] = [];
  for (const candidate of chosen) {
    const entry = await addAllowlistEntryByFingerprint(tuckDir, candidate.fingerprint, {
      reason,
      pattern: candidate.patternId,
      path: candidate.collapsedPath,
    });
    await logSecretAllowlisted(entry.fingerprint, entry.reason, {
      pattern: entry.pattern,
      path: entry.path,
    });
    added.push(entry);
  }

  if (isJsonMode()) {
    emitJsonOk({ added: added.length, entries: added });
    return;
  }

  logger.success(
    `Allowlisted ${added.length} finding${added.length === 1 ? '' : 's'}`
  );
  logger.dim(`Allowlist file: ${collapsePath(getAllowlistPath(tuckDir))} (commit it to share)`);
};

// ============================================================================
// Command Definition
// ============================================================================

export const secretsCommand = new Command('secrets')
  .description('Manage local secrets for placeholder replacement')
  .action(async () => {
    // Default action: show list
    await runSecretsList();
  })
  .addCommand(
    new Command('list')
      .description('List all stored secrets (values hidden)')
      .option('--json', 'Emit JSON envelope to stdout (values are never included)')
      .action((options: JsonOptions) => runSecretsList(options))
  )
  .addCommand(
    new Command('set')
      .description('Set a secret value (prompts securely)')
      .argument('<name>', 'Secret name (e.g., GITHUB_TOKEN)')
      .option('--json', 'Emit JSON envelope to stdout (value is never echoed)')
      .option('-y, --yes', 'Non-interactive: read value from TUCK_SECRET_VALUE')
      .action((name: string, options: SecretsSetOptions) => runSecretsSet(name, options))
  )
  .addCommand(
    new Command('unset')
      .description('Remove a secret')
      .argument('<name>', 'Secret name to remove')
      .option('--json', 'Emit JSON envelope to stdout')
      .action((name: string, options: JsonOptions) => runSecretsUnset(name, options))
  )
  .addCommand(
    new Command('path')
      .description('Show path to secrets file')
      .option('--json', 'Emit JSON envelope to stdout')
      .action((options: JsonOptions) => runSecretsPath(options))
  )
  .addCommand(
    new Command('scan')
      .description('Scan files for secrets')
      .argument('[paths...]', 'Files to scan')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(runScanFiles)
  )
  // Centralized, auditable allowlist (replaces inline ignore comments)
  .addCommand(
    new Command('allow')
      .description('Manage the centralized secret allowlist (mark findings as safe)')
      .option('--json', 'Emit JSON envelope to stdout')
      .action((options: JsonOptions) => runAllowList(options))
      .addCommand(
        new Command('list')
          .description('List allowlisted findings')
          .option('--json', 'Emit JSON envelope to stdout')
          .action((options: JsonOptions) => runAllowList(options))
      )
      .addCommand(
        new Command('add')
          .description('Add scanner finding(s) to the allowlist')
          .option('--file <path>', 'Scan this file and allowlist its findings')
          .option('--pattern <id>', 'Only allowlist findings from this pattern id')
          .option('--fingerprint <hash>', 'Allowlist a known SHA-256 fingerprint directly')
          .option('--reason <text>', 'Why the value is safe (required non-interactively)')
          .option('--json', 'Emit JSON envelope to stdout')
          .option('-y, --yes', 'Non-interactive: allowlist all matching findings')
          .action((options: AllowAddOptions) => runAllowAdd(options))
      )
      .addCommand(
        new Command('remove')
          .description('Remove an allowlist entry by fingerprint (or prefix)')
          .argument('<fingerprint>', 'Fingerprint or unique prefix to remove')
          .option('--json', 'Emit JSON envelope to stdout')
          .action((fingerprint: string, options: AllowRemoveOptions) =>
            runAllowRemove(fingerprint, options)
          )
      )
  )
  .addCommand(
    new Command('extract')
      .description('Rewrite inline credentials into tuck placeholders (MCP config files)')
      .argument('[paths...]', 'Explicit files to extract from')
      .option('--mcp', 'Scan known MCP config files (Claude Desktop, ~/.claude.json, .cursor/mcp.json, …)')
      .option(
        '--format <format>',
        'Reference format: placeholder (tuck {{NAME}}) or env (${env:NAME})',
        'placeholder'
      )
      .option('--dry-run', 'Preview changes without writing files or storing secrets')
      .option('-y, --yes', 'Non-interactive: skip the confirmation prompt')
      .option('--json', 'Emit JSON envelope to stdout (values are never included)')
      .action((paths: string[], options: ExtractOptions) => runExtract(paths, options))
  )
  .addCommand(
    new Command('scan-history')
      .description('Scan git history for leaked secrets')
      .option('--since <date>', 'Only scan commits after this date (e.g., 2024-01-01)')
      .option('--limit <n>', 'Maximum number of commits to scan', '50')
      .action(runScanHistory)
  )
  // Backend management commands
  .addCommand(
    new Command('backend')
      .description('Manage secret backends (1Password, Bitwarden, pass)')
      .addCommand(
        new Command('set')
          .description('Set the secret backend')
          .argument('<backend>', 'Backend name: auto, local, 1password, bitwarden, pass')
          .option('--vault <vault>', 'Default vault (1Password)')
          .option('--server-url <url>', 'Server URL (Bitwarden)')
          .option('--store-path <path>', 'Password store path (pass)')
          .action(runBackendSet)
      )
      .addCommand(
        new Command('status')
          .description('Show backend status')
          .action(runBackendStatus)
      )
      .addCommand(
        new Command('list')
          .description('List available backends')
          .action(runBackendList)
      )
  )
  // Mapping commands
  .addCommand(
    new Command('map')
      .description('Map placeholder to backend path')
      .argument('<name>', 'Placeholder name (e.g., GITHUB_TOKEN)')
      .option('--1password <path>', '1Password path (op://vault/item/field)')
      .option('--bitwarden <id>', 'Bitwarden item ID or name')
      .option('--pass <path>', 'pass path')
      .option('--local', 'Mark as available in local store')
      .action(runMap)
  )
  .addCommand(
    new Command('mappings')
      .description('List all secret mappings')
      .action(runMappings)
  )
  // Test command
  .addCommand(
    new Command('test')
      .description('Test backend connectivity')
      .option('--backend <name>', 'Specific backend to test')
      .action(runTest)
  );
