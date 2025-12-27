import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'path';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir, expandPath, pathExists, collapsePath } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles, getTrackedFileBySource } from '../lib/manifest.js';
import { getDiff } from '../lib/git.js';
import { getFileChecksum } from '../lib/files.js';
import { NotInitializedError, FileNotFoundError } from '../errors.js';
import type { DiffOptions } from '../types.js';
import { readFile } from 'fs/promises';

interface FileDiff {
  source: string;
  destination: string;
  hasChanges: boolean;
  systemContent?: string;
  repoContent?: string;
}

const getFileDiff = async (tuckDir: string, source: string): Promise<FileDiff> => {
  const tracked = await getTrackedFileBySource(tuckDir, source);
  if (!tracked) {
    throw new FileNotFoundError(`Not tracked: ${source}`);
  }

  const systemPath = expandPath(source);
  const repoPath = join(tuckDir, tracked.file.destination);

  const diff: FileDiff = {
    source,
    destination: tracked.file.destination,
    hasChanges: false,
  };

  // Check if system file exists
  if (!(await pathExists(systemPath))) {
    diff.hasChanges = true;
    if (await pathExists(repoPath)) {
      diff.repoContent = await readFile(repoPath, 'utf-8');
    }
    return diff;
  }

  // Check if repo file exists
  if (!(await pathExists(repoPath))) {
    diff.hasChanges = true;
    diff.systemContent = await readFile(systemPath, 'utf-8');
    return diff;
  }

  // Compare checksums
  const systemChecksum = await getFileChecksum(systemPath);
  const repoChecksum = await getFileChecksum(repoPath);

  if (systemChecksum !== repoChecksum) {
    diff.hasChanges = true;
    diff.systemContent = await readFile(systemPath, 'utf-8');
    diff.repoContent = await readFile(repoPath, 'utf-8');
  }

  return diff;
};

const formatUnifiedDiff = (
  source: string,
  systemContent?: string,
  repoContent?: string
): string => {
  const lines: string[] = [];

  lines.push(chalk.bold(`--- a/${source} (system)`));
  lines.push(chalk.bold(`+++ b/${source} (repository)`));

  if (!systemContent && repoContent) {
    // File only in repo
    lines.push(chalk.red('File missing on system'));
    lines.push(chalk.dim('Repository content:'));
    repoContent.split('\n').forEach((line) => {
      lines.push(chalk.green(`+ ${line}`));
    });
  } else if (systemContent && !repoContent) {
    // File only on system
    lines.push(chalk.yellow('File not yet synced to repository'));
    lines.push(chalk.dim('System content:'));
    systemContent.split('\n').forEach((line) => {
      lines.push(chalk.red(`- ${line}`));
    });
  } else if (systemContent && repoContent) {
    // Simple line-by-line diff
    const systemLines = systemContent.split('\n');
    const repoLines = repoContent.split('\n');

    const maxLines = Math.max(systemLines.length, repoLines.length);

    let inDiff = false;
    let diffStart = 0;

    for (let i = 0; i < maxLines; i++) {
      const sysLine = systemLines[i];
      const repoLine = repoLines[i];

      if (sysLine !== repoLine) {
        if (!inDiff) {
          inDiff = true;
          diffStart = i;
          lines.push(chalk.cyan(`@@ -${i + 1} +${i + 1} @@`));
        }

        if (sysLine !== undefined) {
          lines.push(chalk.red(`- ${sysLine}`));
        }
        if (repoLine !== undefined) {
          lines.push(chalk.green(`+ ${repoLine}`));
        }
      } else if (inDiff) {
        // Show a bit of context then stop
        lines.push(chalk.dim(`  ${sysLine || ''}`));
        if (i - diffStart > 3) {
          inDiff = false;
        }
      }
    }
  }

  return lines.join('\n');
};

const runDiff = async (paths: string[], options: DiffOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // If --staged, show git diff
  if (options.staged) {
    const diff = await getDiff(tuckDir, { staged: true, stat: options.stat });
    if (diff) {
      console.log(diff);
    } else {
      logger.info('No staged changes');
    }
    return;
  }

  // If no paths, show all changed files
  if (paths.length === 0) {
    const allFiles = await getAllTrackedFiles(tuckDir);
    const changedFiles: FileDiff[] = [];

    for (const [, file] of Object.entries(allFiles)) {
      const diff = await getFileDiff(tuckDir, file.source);
      if (diff.hasChanges) {
        changedFiles.push(diff);
      }
    }

    if (changedFiles.length === 0) {
      logger.success('No differences found');
      return;
    }

    if (options.stat) {
      // Show summary only
      prompts.intro('tuck diff');
      console.log();
      console.log(chalk.bold(`${changedFiles.length} file${changedFiles.length > 1 ? 's' : ''} changed:`));
      console.log();

      for (const diff of changedFiles) {
        console.log(chalk.yellow(`  ~ ${diff.source}`));
      }

      console.log();
      return;
    }

    // Show full diff for each file
    for (const diff of changedFiles) {
      console.log();
      console.log(formatUnifiedDiff(diff.source, diff.systemContent, diff.repoContent));
      console.log();
    }

    return;
  }

  // Show diff for specific files
  for (const path of paths) {
    const expandedPath = expandPath(path);
    const collapsedPath = collapsePath(expandedPath);

    const diff = await getFileDiff(tuckDir, collapsedPath);

    if (!diff.hasChanges) {
      logger.info(`No changes: ${path}`);
      continue;
    }

    if (options.stat) {
      console.log(chalk.yellow(`~ ${path}`));
    } else {
      console.log(formatUnifiedDiff(path, diff.systemContent, diff.repoContent));
      console.log();
    }
  }
};

export const diffCommand = new Command('diff')
  .description('Show differences between system and repository')
  .argument('[paths...]', 'Specific files to diff')
  .option('--staged', 'Show staged git changes')
  .option('--stat', 'Show diffstat only')
  .action(async (paths: string[], options: DiffOptions) => {
    await runDiff(paths, options);
  });
