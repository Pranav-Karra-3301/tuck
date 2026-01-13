import { Command } from 'commander';
import { join } from 'path';
import { prompts, logger, colors as c } from '../ui/index.js';
import { getTuckDir, expandPath, pathExists, collapsePath, isDirectory } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles, getTrackedFileBySource } from '../lib/manifest.js';
import { getDiff } from '../lib/git.js';
import {
  getFileChecksum,
  checkFileSizeThreshold,
  formatFileSize,
  getDirectoryFiles,
} from '../lib/files.js';
import { NotInitializedError, FileNotFoundError, PermissionError } from '../errors.js';
import { isBinaryExecutable } from '../lib/binary.js';
import { isIgnored } from '../lib/tuckignore.js';
import type { DiffOptions } from '../types.js';
import { readFile } from 'fs/promises';

interface FileDiff {
  source: string;
  destination: string;
  hasChanges: boolean;
  isBinary?: boolean;
  isDirectory?: boolean;
  fileCount?: number;
  systemSize?: number;
  repoSize?: number;
  systemContent?: string;
  repoContent?: string;
}

const isBinary = async (path: string): Promise<boolean> => {
  if (!(await pathExists(path))) {
    return false;
  }
  return await isBinaryExecutable(path);
};

const getFileDiff = async (tuckDir: string, source: string): Promise<FileDiff | null> => {
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
      const repoContent = await readFile(repoPath, 'utf-8');
      diff.repoContent = repoContent;
      diff.repoSize = repoContent.length;
    }
    return diff;
  }

  // Check if repo file exists
  if (!(await pathExists(repoPath))) {
    diff.hasChanges = true;
    const systemContent = await readFile(systemPath, 'utf-8');
    diff.systemContent = systemContent;
    diff.systemSize = systemContent.length;
    return diff;
  }

  // Check if binary
  const systemIsBinary = await isBinary(systemPath);
  const repoIsBinary = await isBinary(repoPath);

  if (systemIsBinary || repoIsBinary) {
    diff.isBinary = true;
    try {
      const systemBuffer = await readFile(systemPath);
      diff.systemSize = systemBuffer.length;
    } catch {
      // Ignore read errors for binaries
    }
    try {
      const repoBuffer = await readFile(repoPath);
      diff.repoSize = repoBuffer.length;
    } catch {
      // Ignore read errors for binaries
    }
    // Compare binary files by checksum instead of assuming they differ
    const systemChecksum = await getFileChecksum(systemPath);
    const repoChecksum = await getFileChecksum(repoPath);
    diff.hasChanges = systemChecksum !== repoChecksum;
    return diff;
  }

  // Check if directory
  const systemIsDir = await isDirectory(systemPath);
  const repoIsDir = await isDirectory(repoPath);

  if (systemIsDir || repoIsDir) {
    diff.isDirectory = true;
    diff.hasChanges = true;

    // Get file counts for directory summary
    if (systemIsDir) {
      const files = await getDirectoryFiles(systemPath);
      diff.fileCount = files.length;
    }
    if (repoIsDir) {
      const files = await getDirectoryFiles(repoPath);
      diff.fileCount = (diff.fileCount || 0) + files.length;
    }

    return diff;
  }

  // Check file size for large files
  try {
    const systemSizeCheck = await checkFileSizeThreshold(systemPath);
    const repoSizeCheck = await checkFileSizeThreshold(repoPath);

    diff.systemSize = systemSizeCheck.size;
    diff.repoSize = repoSizeCheck.size;
  } catch {
    // Size check failed, continue with diff
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

const formatUnifiedDiff = (diff: FileDiff): string => {
  const lines: string[] = [];

  lines.push(c.bold(`--- a/${diff.source} (system)`));
  lines.push(c.bold(`+++ b/${diff.source} (repository)`));

  if (diff.isBinary) {
    const sysSize = diff.systemSize ? formatFileSize(diff.systemSize) : '0 B';
    const repoSize = diff.repoSize ? formatFileSize(diff.repoSize) : '0 B';
    lines.push(c.dim('Binary files differ'));
    lines.push(c.dim(`  System:  ${sysSize}`));
    lines.push(c.dim(`  Repo:    ${repoSize}`));
    return lines.join('\n');
  }

  if (diff.isDirectory) {
    const fileCount = diff.fileCount || 0;
    lines.push(c.dim('Directory content changed'));
    lines.push(c.dim(`  Contains ${fileCount} file${fileCount > 1 ? 's' : ''}`));
    return lines.join('\n');
  }

  const { systemContent, repoContent } = diff;

  if (!systemContent && repoContent) {
    // File only in repo
    lines.push(c.red('File missing on system'));
    lines.push(c.dim('Repository content:'));
    repoContent.split('\n').forEach((line) => {
      lines.push(c.green(`+ ${line}`));
    });
  } else if (systemContent && !repoContent) {
    // File only on system
    lines.push(c.yellow('File not yet synced to repository'));
    lines.push(c.dim('System content:'));
    systemContent.split('\n').forEach((line) => {
      lines.push(c.red(`- ${line}`));
    });
  } else if (systemContent && repoContent) {
    // Simple line-by-line diff with improved context
    const CONTEXT_LINES = 3;
    const systemLines = systemContent.split('\n');
    const repoLines = repoContent.split('\n');

    const maxLines = Math.max(systemLines.length, repoLines.length);

    let inDiff = false;
    let diffStart = 0;
    let contextCount = 0;

    for (let i = 0; i < maxLines; i++) {
      const sysLine = systemLines[i];
      const repoLine = repoLines[i];

      if (sysLine !== repoLine) {
        if (!inDiff) {
          inDiff = true;
          diffStart = i;
          const startLine = Math.max(0, diffStart - CONTEXT_LINES + 1);
          const endLine = Math.min(maxLines, diffStart + CONTEXT_LINES);
          lines.push(
            c.cyan(
              `@@ -${startLine + 1},${endLine - startLine} +${startLine + 1},${endLine - startLine} @@`
            )
          );
        }

        if (sysLine !== undefined) {
          lines.push(c.red(`- ${sysLine}`));
        }
        if (repoLine !== undefined) {
          lines.push(c.green(`+ ${repoLine}`));
        }
        contextCount = 0;
      } else if (inDiff) {
        // Show context lines
        lines.push(c.dim(`  ${sysLine || ''}`));
        contextCount++;
        if (contextCount > CONTEXT_LINES * 2) {
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

  // Get all tracked files
  const allFiles = await getAllTrackedFiles(tuckDir);
  const changedFiles: FileDiff[] = [];

  // If no paths specified, check all files
  const filesToCheck =
    paths.length === 0
      ? Object.values(allFiles)
      : paths.map((path) => {
          const expandedPath = expandPath(path);
          const collapsedPath = collapsePath(expandedPath);
          const tracked = Object.entries(allFiles).find(([, f]) => f.source === collapsedPath);
          if (!tracked) {
            throw new FileNotFoundError(`Not tracked: ${path}`);
          }
          return tracked[1];
        });

  // Check each file for changes
  for (const file of filesToCheck) {
    // Skip if category filter is set and doesn't match
    if (options.category && file.category !== options.category) {
      continue;
    }

    // Skip if in .tuckignore
    if (await isIgnored(tuckDir, file.source)) {
      continue;
    }

    try {
      const diff = await getFileDiff(tuckDir, file.source);
      if (diff && diff.hasChanges) {
        changedFiles.push(diff);
      }
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        logger.warning(`File not found: ${file.source}`);
      } else if (error instanceof PermissionError) {
        logger.warning(`Permission denied: ${file.source}`);
      } else {
        throw error;
      }
    }
  }

  if (changedFiles.length === 0) {
    if (paths.length > 0) {
      logger.success('No differences found');
    } else {
      prompts.intro('tuck diff');
      console.log();
      logger.success('No differences found');
      console.log();
    }
    return;
  }

  prompts.intro('tuck diff');
  console.log();

  // Show stats/name-only if requested
  if (options.stat || options.nameOnly) {
    const label = options.nameOnly
      ? 'Changed files:'
      : `${changedFiles.length} file${changedFiles.length > 1 ? 's' : ''} changed:`;
    console.log(c.bold(label));
    console.log();

    for (const diff of changedFiles) {
      const status = diff.isDirectory ? c.dim('[dir]') : diff.isBinary ? c.dim('[bin]') : '';
      console.log(`  ${c.yellow('~')} ${diff.source} ${status}`);
    }

    console.log();
    prompts.outro(`Found ${changedFiles.length} changed file(s)`);
    return;
  }

  // Show full diff for each file
  for (const diff of changedFiles) {
    console.log(formatUnifiedDiff(diff));
    console.log();
  }

  prompts.outro(`Found ${changedFiles.length} changed file(s)`);

  // Return exit code 1 if differences found and --exit-code is set
  if (options.exitCode) {
    process.exit(1);
  }
};

export { runDiff, formatUnifiedDiff };

export const diffCommand = new Command('diff')
  .description('Show differences between system and repository')
  .argument('[paths...]', 'Specific files to diff')
  .option('--staged', 'Show staged git changes')
  .option('--stat', 'Show diffstat only')
  .option(
    '--category <category>',
    'Filter by file category (shell, git, editors, terminal, ssh, misc)'
  )
  .option('--name-only', 'Show only changed file names')
  .option('--exit-code', 'Return exit code 1 if differences found')
  .action(async (paths: string[], options: DiffOptions) => {
    await runDiff(paths, options);
  });
