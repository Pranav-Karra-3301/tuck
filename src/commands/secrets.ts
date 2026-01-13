/**
 * tuck secrets - Manage local secrets for placeholder replacement
 *
 * Commands:
 *   tuck secrets list          - List all stored secrets (values hidden)
 *   tuck secrets set <n> <v>   - Set a secret value
 *   tuck secrets unset <name>  - Remove a secret
 *   tuck secrets path          - Show path to secrets file
 *   tuck secrets scan-history  - Scan git history for leaked secrets
 */

import { Command } from 'commander';
import { prompts, logger, colors as c } from '../ui/index.js';
import { getTuckDir, expandPath, pathExists } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import {
  listSecrets,
  setSecret,
  unsetSecret,
  getSecretsPath,
  isValidSecretName,
  normalizeSecretName,
  scanForSecrets,
  type ScanSummary,
} from '../lib/secrets/index.js';
import { NotInitializedError } from '../errors.js';
import { getLog } from '../lib/git.js';

// ============================================================================
// List Command
// ============================================================================

const runSecretsList = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const secrets = await listSecrets(tuckDir);

  if (secrets.length === 0) {
    logger.info('No secrets stored');
    logger.dim(`Secrets file: ${getSecretsPath(tuckDir)}`);
    console.log();
    logger.dim('Secrets are stored when you choose to replace detected secrets with placeholders.');
    logger.dim('You can also manually add secrets with: tuck secrets set <NAME> <value>');
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

const runSecretsSet = async (name: string): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Validate or normalize name
  if (!isValidSecretName(name)) {
    const normalized = normalizeSecretName(name);
    logger.warning(`Secret name normalized to: ${normalized}`);
    logger.dim('Secret names must be uppercase alphanumeric with underscores (e.g., API_KEY)');
    name = normalized;
  }

  // Security: Always prompt for secret value interactively
  // Never accept via command-line to prevent exposure in shell history and process list
  // Note: Cancellation or empty input is handled below by validating the returned value.
  const secretValue = await prompts.password(`Enter value for ${name}:`);

  if (!secretValue || secretValue.trim().length === 0) {
    logger.error('Secret value cannot be empty');
    return;
  }

  await setSecret(tuckDir, name, secretValue);
  logger.success(`Secret '${name}' set`);
  console.log();
  logger.dim(`Use {{${name}}} as placeholder in your dotfiles`);
};

// ============================================================================
// Unset Command
// ============================================================================

const runSecretsUnset = async (name: string): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const removed = await unsetSecret(tuckDir, name);

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

const runSecretsPath = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  console.log(getSecretsPath(tuckDir));
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

const runScanFiles = async (paths: string[]): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  if (paths.length === 0) {
    logger.error('No files specified');
    logger.dim('Usage: tuck secrets scan <file> [files...]');
    return;
  }

  // Expand paths
  const expandedPaths = paths.map((p) => expandPath(p));

  // Check files exist
  for (const path of expandedPaths) {
    if (!(await pathExists(path))) {
      logger.warning(`File not found: ${path}`);
    }
  }

  const existingPaths = [];
  for (const path of expandedPaths) {
    if (await pathExists(path)) {
      existingPaths.push(path);
    }
  }

  if (existingPaths.length === 0) {
    logger.error('No valid files to scan');
    return;
  }

  const spinner = prompts.spinner();
  spinner.start(`Scanning ${existingPaths.length} file(s)...`);

  const summary = await scanForSecrets(existingPaths, tuckDir);

  spinner.stop('Scan complete');

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
      .action(runSecretsList)
  )
  .addCommand(
    new Command('set')
      .description('Set a secret value (prompts securely)')
      .argument('<name>', 'Secret name (e.g., GITHUB_TOKEN)')
      .action(runSecretsSet)
  )
  .addCommand(
    new Command('unset')
      .description('Remove a secret')
      .argument('<name>', 'Secret name to remove')
      .action(runSecretsUnset)
  )
  .addCommand(new Command('path').description('Show path to secrets file').action(runSecretsPath))
  .addCommand(
    new Command('scan')
      .description('Scan files for secrets')
      .argument('[paths...]', 'Files to scan')
      .action(runScanFiles)
  )
  .addCommand(
    new Command('scan-history')
      .description('Scan git history for leaked secrets')
      .option('--since <date>', 'Only scan commits after this date (e.g., 2024-01-01)')
      .option('--limit <n>', 'Maximum number of commits to scan', '50')
      .action(runScanHistory)
  );
