import { Command } from 'commander';
import { join, dirname } from 'path';
import { readFile, writeFile, rm, chmod, stat } from 'fs/promises';
import { ensureDir, pathExists as fsPathExists } from 'fs-extra';
import { tmpdir } from 'os';
import { banner, prompts, logger, colors as c } from '../ui/index.js';
import { expandPath, pathExists, collapsePath, validateSafeSourcePath, getTuckDir } from '../lib/paths.js';
import { cloneRepo } from '../lib/git.js';
import { isGhInstalled, findDotfilesRepo, ghCloneRepo, repoExists } from '../lib/github.js';
import { createPreApplySnapshot } from '../lib/timemachine.js';
import { smartMerge, isShellFile, generateMergePreview } from '../lib/merge.js';
import { CATEGORIES } from '../constants.js';
import type { TuckManifest } from '../types.js';
import { findPlaceholders, restoreContent } from '../lib/secrets/index.js';
import { createResolver } from '../lib/secretBackends/index.js';
import { loadConfig } from '../lib/config.js';

/**
 * Fix permissions for SSH/GPG files after apply
 */
const fixSecurePermissions = async (path: string): Promise<void> => {
  const collapsedPath = collapsePath(path);

  // Only fix permissions for SSH and GPG files
  if (!collapsedPath.includes('.ssh/') && !collapsedPath.includes('.gnupg/')) {
    return;
  }

  try {
    const stats = await stat(path);

    if (stats.isDirectory()) {
      await chmod(path, 0o700);
    } else {
      await chmod(path, 0o600);
    }
  } catch {
    // Ignore permission errors (might be on Windows)
  }
};

export interface ApplyOptions {
  merge?: boolean;
  replace?: boolean;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
}

interface ApplyFile {
  source: string;
  destination: string;
  category: string;
  repoPath: string;
}

interface ApplyResult {
  appliedCount: number;
  filesWithPlaceholders: Array<{
    path: string;
    placeholders: string[];
  }>;
}

/**
 * Resolve a source (username or repo URL) to a full repository identifier
 */
const resolveSource = async (source: string): Promise<{ repoId: string; isUrl: boolean }> => {
  // Check if it's a full URL
  if (source.includes('://') || source.startsWith('git@')) {
    return { repoId: source, isUrl: true };
  }

  // Check if it's a GitHub repo identifier (user/repo)
  if (source.includes('/')) {
    return { repoId: source, isUrl: false };
  }

  // Assume it's a username, try to find their dotfiles repo
  logger.info(`Looking for dotfiles repository for ${source}...`);

  if (await isGhInstalled()) {
    const dotfilesRepo = await findDotfilesRepo(source);
    if (dotfilesRepo) {
      logger.success(`Found repository: ${dotfilesRepo}`);
      return { repoId: dotfilesRepo, isUrl: false };
    }
  }

  // Try common repo names
  const commonNames = ['dotfiles', 'tuck', '.dotfiles'];
  for (const name of commonNames) {
    const repoId = `${source}/${name}`;
    if (await repoExists(repoId)) {
      logger.success(`Found repository: ${repoId}`);
      return { repoId, isUrl: false };
    }
  }

  throw new Error(
    `Could not find a dotfiles repository for "${source}". ` +
      'Try specifying the full repository name (e.g., username/dotfiles)'
  );
};

/**
 * Clone the source repository to a temporary directory
 */
const cloneSource = async (repoId: string, isUrl: boolean): Promise<string> => {
  const tempDir = join(tmpdir(), `tuck-apply-${Date.now()}`);
  await ensureDir(tempDir);

  if (isUrl) {
    await cloneRepo(repoId, tempDir);
  } else {
    // Use gh CLI to clone if available, otherwise construct URL
    if (await isGhInstalled()) {
      await ghCloneRepo(repoId, tempDir);
    } else {
      const url = `https://github.com/${repoId}.git`;
      await cloneRepo(url, tempDir);
    }
  }

  return tempDir;
};

/**
 * Read the manifest from a cloned repository
 */
const readClonedManifest = async (repoDir: string): Promise<TuckManifest | null> => {
  const manifestPath = join(repoDir, '.tuckmanifest.json');

  if (!(await fsPathExists(manifestPath))) {
    return null;
  }

  try {
    const content = await readFile(manifestPath, 'utf-8');
    return JSON.parse(content) as TuckManifest;
  } catch {
    return null;
  }
};

/**
 * Prepare the list of files to apply
 */
const prepareFilesToApply = async (
  repoDir: string,
  manifest: TuckManifest
): Promise<ApplyFile[]> => {
  const files: ApplyFile[] = [];

  for (const [_id, file] of Object.entries(manifest.files)) {
    const repoFilePath = join(repoDir, file.destination);

    if (await fsPathExists(repoFilePath)) {
      // Validate that the source path is safe (within home directory)
      // This prevents malicious manifests from writing to arbitrary locations
      try {
        validateSafeSourcePath(file.source);
      } catch (error) {
        logger.warning(`Skipping unsafe path from manifest: ${file.source}`);
        continue;
      }

      files.push({
        source: file.source,
        destination: expandPath(file.source),
        category: file.category,
        repoPath: repoFilePath,
      });
    }
  }

  return files;
};

/**
 * Resolve placeholders in file content using the configured backend
 * @returns Object with resolved content and any unresolved placeholder names
 */
const resolveFileSecrets = async (
  content: string,
  tuckDir: string
): Promise<{ content: string; unresolved: string[] }> => {
  const placeholders = findPlaceholders(content);

  if (placeholders.length === 0) {
    return { content, unresolved: [] };
  }

  try {
    const config = await loadConfig(tuckDir);
    const resolver = createResolver(tuckDir, config.security);

    // Resolve all placeholders
    // Use failOnAuthRequired to prevent interactive prompts during apply
    const secrets = await resolver.resolveToMap(placeholders, { failOnAuthRequired: true });

    // Replace placeholders with resolved values
    const result = restoreContent(content, secrets);

    return {
      content: result.restoredContent,
      unresolved: result.unresolved,
    };
  } catch (error) {
    // If resolver fails, log the error and return original content with all placeholders as unresolved
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.debug?.(`Secret resolution failed: ${errorMsg}`);
    logger.warning?.(
      `Failed to resolve secrets for file content. ${placeholders.length} placeholder(s) will remain unresolved. ` +
        `Reason: ${errorMsg}`
    );
    return { content, unresolved: placeholders };
  }
};

/**
 * Apply files with merge strategy
 */
const applyWithMerge = async (files: ApplyFile[], dryRun: boolean): Promise<ApplyResult> => {
  const result: ApplyResult = {
    appliedCount: 0,
    filesWithPlaceholders: [],
  };

  // Get tuck directory for secret resolution
  const tuckDir = getTuckDir();

  for (const file of files) {
    let fileContent = await readFile(file.repoPath, 'utf-8');

    // Resolve placeholders using configured backend (1Password, Bitwarden, pass, or local)
    const secretsResult = await resolveFileSecrets(fileContent, tuckDir);
    fileContent = secretsResult.content;

    // Track only unresolved placeholders
    if (secretsResult.unresolved.length > 0) {
      result.filesWithPlaceholders.push({
        path: collapsePath(file.destination),
        placeholders: secretsResult.unresolved,
      });
    }

    if (isShellFile(file.source) && (await pathExists(file.destination))) {
      // Use smart merge for shell files
      const mergeResult = await smartMerge(file.destination, fileContent);

      if (dryRun) {
        logger.file(
          'merge',
          `${collapsePath(file.destination)} (${mergeResult.preservedBlocks} blocks preserved)`
        );
      } else {
        await ensureDir(dirname(file.destination));
        await writeFile(file.destination, mergeResult.content, 'utf-8');
        logger.file('merge', collapsePath(file.destination));
      }
    } else {
      // Copy non-shell files directly
      if (dryRun) {
        if (await pathExists(file.destination)) {
          logger.file('modify', collapsePath(file.destination));
        } else {
          logger.file('add', collapsePath(file.destination));
        }
      } else {
        const fileExists = await pathExists(file.destination);
        // Write file content directly instead of copying (to preserve resolved secrets)
        await ensureDir(dirname(file.destination));
        await writeFile(file.destination, fileContent, 'utf-8');
        await fixSecurePermissions(file.destination);
        logger.file(fileExists ? 'modify' : 'add', collapsePath(file.destination));
      }
    }

    result.appliedCount++;
  }

  return result;
};

/**
 * Apply files with replace strategy
 */
const applyWithReplace = async (files: ApplyFile[], dryRun: boolean): Promise<ApplyResult> => {
  const result: ApplyResult = {
    appliedCount: 0,
    filesWithPlaceholders: [],
  };

  // Get tuck directory for secret resolution
  const tuckDir = getTuckDir();

  for (const file of files) {
    let fileContent = await readFile(file.repoPath, 'utf-8');

    // Resolve placeholders using configured backend (1Password, Bitwarden, pass, or local)
    const secretsResult = await resolveFileSecrets(fileContent, tuckDir);
    fileContent = secretsResult.content;

    // Track only unresolved placeholders
    if (secretsResult.unresolved.length > 0) {
      result.filesWithPlaceholders.push({
        path: collapsePath(file.destination),
        placeholders: secretsResult.unresolved,
      });
    }

    if (dryRun) {
      if (await pathExists(file.destination)) {
        logger.file('modify', `${collapsePath(file.destination)} (replace)`);
      } else {
        logger.file('add', collapsePath(file.destination));
      }
    } else {
      const fileExists = await pathExists(file.destination);
      // Write file content directly instead of copying (to preserve resolved secrets)
      await ensureDir(dirname(file.destination));
      await writeFile(file.destination, fileContent, 'utf-8');
      await fixSecurePermissions(file.destination);
      logger.file(fileExists ? 'modify' : 'add', collapsePath(file.destination));
    }

    result.appliedCount++;
  }

  return result;
};

/**
 * Display warnings for files with unresolved placeholders
 */
const displayPlaceholderWarnings = (
  filesWithPlaceholders: ApplyResult['filesWithPlaceholders']
): void => {
  if (filesWithPlaceholders.length === 0) return;

  console.log();
  console.log(c.yellow('⚠ Warning: Some files contain unresolved placeholders:'));
  console.log();

  for (const { path, placeholders } of filesWithPlaceholders) {
    console.log(c.dim(`  ${path}:`));

    const maxToShow = 5;
    if (placeholders.length <= maxToShow) {
      // For small numbers, show all placeholders
      for (const placeholder of placeholders) {
        console.log(c.yellow(`    {{${placeholder}}}`));
      }
    } else {
      // For larger numbers, show a sampling: first 3 and last 2
      const firstCount = 3;
      const lastCount = 2;
      const firstPlaceholders = placeholders.slice(0, firstCount);
      const lastPlaceholders = placeholders.slice(-lastCount);

      for (const placeholder of firstPlaceholders) {
        console.log(c.yellow(`    {{${placeholder}}}`));
      }

      // Indicate that some placeholders are omitted in the middle
      console.log(c.dim('    ...'));

      for (const placeholder of lastPlaceholders) {
        console.log(c.yellow(`    {{${placeholder}}}`));
      }

      const shownCount = firstPlaceholders.length + lastPlaceholders.length;
      const hiddenCount = placeholders.length - shownCount;
      if (hiddenCount > 0) {
        console.log(c.dim(`    ... and ${hiddenCount} more not shown`));
      }
    }
  }

  console.log();
  console.log(c.dim('  These placeholders need to be replaced with actual values.'));
  console.log(c.dim('  Use `tuck secrets set <NAME> <value>` to configure secrets,'));
  console.log(c.dim('  then re-apply to populate them.'));
};

/**
 * Run interactive apply flow
 */
const runInteractiveApply = async (source: string, options: ApplyOptions): Promise<void> => {
  banner();
  prompts.intro('tuck apply');

  // Resolve the source
  let repoId: string;
  let isUrl: boolean;

  try {
    const resolved = await resolveSource(source);
    repoId = resolved.repoId;
    isUrl = resolved.isUrl;
  } catch (error) {
    prompts.log.error(error instanceof Error ? error.message : String(error));
    return;
  }

  // Clone the repository
  let repoDir: string;
  try {
    const spinner = prompts.spinner();
    spinner.start('Cloning repository...');
    repoDir = await cloneSource(repoId, isUrl);
    spinner.stop('Repository cloned');
  } catch (error) {
    prompts.log.error(`Failed to clone: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    // Read the manifest
    const manifest = await readClonedManifest(repoDir);

    if (!manifest) {
      prompts.log.error('No tuck manifest found in repository');
      prompts.note(
        'This repository may not be managed by tuck.\nLook for a .tuckmanifest.json file.',
        'Tip'
      );
      return;
    }

    // Prepare files to apply
    const files = await prepareFilesToApply(repoDir, manifest);

    if (files.length === 0) {
      prompts.log.warning('No files to apply');
      return;
    }

    // Show what will be applied
    prompts.log.info(`Found ${files.length} file(s) to apply:`);
    console.log();

    // Group by category
    const byCategory: Record<string, ApplyFile[]> = {};
    for (const file of files) {
      if (!byCategory[file.category]) {
        byCategory[file.category] = [];
      }
      byCategory[file.category].push(file);
    }

    for (const [category, categoryFiles] of Object.entries(byCategory)) {
      const categoryConfig = CATEGORIES[category] || { icon: '📄' };
      console.log(c.bold(`  ${categoryConfig.icon} ${category}`));
      for (const file of categoryFiles) {
        const exists = await pathExists(file.destination);
        const status = exists ? c.yellow('(will update)') : c.green('(new)');
        console.log(c.dim(`    ${collapsePath(file.destination)} ${status}`));
      }
    }
    console.log();

    // Ask for merge strategy
    let strategy: 'merge' | 'replace';

    if (options.merge) {
      strategy = 'merge';
    } else if (options.replace) {
      strategy = 'replace';
    } else {
      strategy = await prompts.select('How should conflicts be handled?', [
        {
          value: 'merge',
          label: 'Merge (recommended)',
          hint: 'Preserve local customizations marked with # local or # tuck:preserve',
        },
        {
          value: 'replace',
          label: 'Replace',
          hint: 'Overwrite all files completely',
        },
      ]);
    }

    // Show merge preview for shell files if using merge strategy
    if (strategy === 'merge') {
      const shellFiles = files.filter((f) => isShellFile(f.source));
      if (shellFiles.length > 0) {
        console.log();
        for (const file of shellFiles.slice(0, 3)) {
          if (await pathExists(file.destination)) {
            const fileContent = await readFile(file.repoPath, 'utf-8');
            const preview = await generateMergePreview(file.destination, fileContent);
            prompts.note(preview, collapsePath(file.destination));
          }
        }
        if (shellFiles.length > 3) {
          prompts.log.info(`... and ${shellFiles.length - 3} more shell files`);
        }
      }
    }

    // Confirm
    if (!options.yes && !options.force) {
      console.log();
      const confirmed = await prompts.confirm(
        `Apply ${files.length} files using ${strategy} strategy?`,
        true
      );

      if (!confirmed) {
        prompts.cancel('Apply cancelled');
        return;
      }
    }

    // Create Time Machine backup before applying
    // Note: We need to properly await async checks - Array.filter doesn't await promises
    const existingPaths = [];
    for (const file of files) {
      if (await pathExists(file.destination)) {
        existingPaths.push(file.destination);
      }
    }

    if (existingPaths.length > 0 && !options.dryRun) {
      const spinner = prompts.spinner();
      spinner.start('Creating backup snapshot...');
      const snapshot = await createPreApplySnapshot(existingPaths, repoId);
      spinner.stop(`Backup created: ${snapshot.id}`);
      console.log();
    }

    // Apply files
    if (options.dryRun) {
      prompts.log.info('Dry run - no changes will be made:');
    } else {
      prompts.log.info('Applying files...');
    }
    console.log();

    let applyResult: ApplyResult;
    if (strategy === 'merge') {
      applyResult = await applyWithMerge(files, options.dryRun || false);
    } else {
      applyResult = await applyWithReplace(files, options.dryRun || false);
    }

    console.log();

    if (options.dryRun) {
      prompts.log.info(`Would apply ${applyResult.appliedCount} files`);
    } else {
      prompts.log.success(`Applied ${applyResult.appliedCount} files`);
    }

    // Show placeholder warnings
    displayPlaceholderWarnings(applyResult.filesWithPlaceholders);

    if (!options.dryRun) {
      console.log();
      prompts.note(
        'To undo this apply, run:\n  tuck restore --latest\n\nTo see all backups:\n  tuck restore --list',
        'Undo'
      );
    }

    prompts.outro('Done!');
  } finally {
    // Clean up temp directory
    try {
      await rm(repoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
};

/**
 * Run non-interactive apply
 */
const runApply = async (source: string, options: ApplyOptions): Promise<void> => {
  // Resolve the source
  const { repoId, isUrl } = await resolveSource(source);

  // Clone the repository
  logger.info('Cloning repository...');
  const repoDir = await cloneSource(repoId, isUrl);

  try {
    // Read the manifest
    const manifest = await readClonedManifest(repoDir);

    if (!manifest) {
      throw new Error('No tuck manifest found in repository');
    }

    // Prepare files to apply
    const files = await prepareFilesToApply(repoDir, manifest);

    if (files.length === 0) {
      logger.warning('No files to apply');
      return;
    }

    // Determine strategy
    const strategy = options.replace ? 'replace' : 'merge';

    // Create backup if not dry run
    if (!options.dryRun) {
      const existingPaths = [];
      for (const file of files) {
        if (await pathExists(file.destination)) {
          existingPaths.push(file.destination);
        }
      }

      if (existingPaths.length > 0) {
        logger.info('Creating backup snapshot...');
        const snapshot = await createPreApplySnapshot(existingPaths, repoId);
        logger.success(`Backup created: ${snapshot.id}`);
      }
    }

    // Apply files
    if (options.dryRun) {
      logger.heading('Dry run - would apply:');
    } else {
      logger.heading('Applying:');
    }

    let applyResult: ApplyResult;
    if (strategy === 'merge') {
      applyResult = await applyWithMerge(files, options.dryRun || false);
    } else {
      applyResult = await applyWithReplace(files, options.dryRun || false);
    }

    logger.blank();

    if (options.dryRun) {
      logger.info(`Would apply ${applyResult.appliedCount} files`);
    } else {
      logger.success(`Applied ${applyResult.appliedCount} files`);
    }

    // Show placeholder warnings
    displayPlaceholderWarnings(applyResult.filesWithPlaceholders);

    if (!options.dryRun) {
      logger.info('To undo: tuck restore --latest');
    }
  } finally {
    // Clean up temp directory
    try {
      await rm(repoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
};

export const applyCommand = new Command('apply')
  .description('Apply dotfiles from a repository to this machine')
  .argument('<source>', 'GitHub username, user/repo, or full repository URL')
  .option('-m, --merge', 'Merge with existing files (preserve local customizations)')
  .option('-r, --replace', 'Replace existing files completely')
  .option('--dry-run', 'Show what would be applied without making changes')
  .option('-f, --force', 'Apply without confirmation prompts')
  .option('-y, --yes', 'Assume yes to all prompts')
  .action(async (source: string, options: ApplyOptions) => {
    // Determine if we should run interactive mode
    const isInteractive = !options.force && !options.yes && process.stdout.isTTY;

    if (isInteractive) {
      await runInteractiveApply(source, options);
    } else {
      await runApply(source, options);
    }
  });
