import { Command } from 'commander';
import { join } from 'path';
import { readFile, rm } from 'fs/promises';
import { ensureDir, pathExists as fsPathExists } from 'fs-extra';
import { tmpdir } from 'os';
import chalk from 'chalk';
import { banner, prompts, logger } from '../ui/index.js';
import { expandPath, pathExists, collapsePath } from '../lib/paths.js';
import { cloneRepo } from '../lib/git.js';
import {
  isGhInstalled,
  findDotfilesRepo,
  ghCloneRepo,
  repoExists,
} from '../lib/github.js';
import { createPreApplySnapshot } from '../lib/timemachine.js';
import { smartMerge, isShellFile, generateMergePreview } from '../lib/merge.js';
import { copyFileOrDir } from '../lib/files.js';
import { CATEGORIES } from '../constants.js';
import type { TuckManifest } from '../types.js';

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
 * Apply files with merge strategy
 */
const applyWithMerge = async (files: ApplyFile[], dryRun: boolean): Promise<number> => {
  let appliedCount = 0;

  for (const file of files) {
    const fileContent = await readFile(file.repoPath, 'utf-8');

    if (isShellFile(file.source) && (await pathExists(file.destination))) {
      // Use smart merge for shell files
      const mergeResult = await smartMerge(file.destination, fileContent);

      if (dryRun) {
        logger.file('merge', `${collapsePath(file.destination)} (${mergeResult.preservedBlocks} blocks preserved)`);
      } else {
        const { writeFile } = await import('fs/promises');
        const { ensureDir } = await import('fs-extra');
        const { dirname } = await import('path');

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
        await copyFileOrDir(file.repoPath, file.destination, { overwrite: true });
        logger.file(
          (await pathExists(file.destination)) ? 'modify' : 'add',
          collapsePath(file.destination)
        );
      }
    }

    appliedCount++;
  }

  return appliedCount;
};

/**
 * Apply files with replace strategy
 */
const applyWithReplace = async (files: ApplyFile[], dryRun: boolean): Promise<number> => {
  let appliedCount = 0;

  for (const file of files) {
    if (dryRun) {
      if (await pathExists(file.destination)) {
        logger.file('modify', `${collapsePath(file.destination)} (replace)`);
      } else {
        logger.file('add', collapsePath(file.destination));
      }
    } else {
      await copyFileOrDir(file.repoPath, file.destination, { overwrite: true });
      logger.file(
        (await pathExists(file.destination)) ? 'modify' : 'add',
        collapsePath(file.destination)
      );
    }

    appliedCount++;
  }

  return appliedCount;
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
      console.log(chalk.bold(`  ${categoryConfig.icon} ${category}`));
      for (const file of categoryFiles) {
        const exists = await pathExists(file.destination);
        const status = exists ? chalk.yellow('(will update)') : chalk.green('(new)');
        console.log(chalk.dim(`    ${collapsePath(file.destination)} ${status}`));
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
    const existingFiles = files.filter(async (f) => await pathExists(f.destination));
    const targetPaths = existingFiles.map((f) => f.destination);

    if (targetPaths.length > 0 && !options.dryRun) {
      const spinner = prompts.spinner();
      spinner.start('Creating backup snapshot...');
      const snapshot = await createPreApplySnapshot(targetPaths, repoId);
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

    let appliedCount: number;
    if (strategy === 'merge') {
      appliedCount = await applyWithMerge(files, options.dryRun || false);
    } else {
      appliedCount = await applyWithReplace(files, options.dryRun || false);
    }

    console.log();

    if (options.dryRun) {
      prompts.log.info(`Would apply ${appliedCount} files`);
    } else {
      prompts.log.success(`Applied ${appliedCount} files`);
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

    let appliedCount: number;
    if (strategy === 'merge') {
      appliedCount = await applyWithMerge(files, options.dryRun || false);
    } else {
      appliedCount = await applyWithReplace(files, options.dryRun || false);
    }

    logger.blank();

    if (options.dryRun) {
      logger.info(`Would apply ${appliedCount} files`);
    } else {
      logger.success(`Applied ${appliedCount} files`);
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
