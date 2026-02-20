/**
 * Status command for tuck CLI
 * Shows current tracking status in a compact, modern layout
 */

import { Command } from 'commander';
import boxen from 'boxen';
import logSymbols from 'log-symbols';
import figures from 'figures';
import { colors as c, boxStyles, indent, formatStatus, categoryStyles } from '../ui/index.js';
import { prompts } from '../ui/prompts.js';
import {
  getTuckDir,
  collapsePath,
  expandPath,
  pathExists,
  validateSafeSourcePath,
  getSafeRepoPathFromDestination,
} from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles } from '../lib/manifest.js';
import { getStatus, hasRemote, getRemoteUrl, getCurrentBranch } from '../lib/git.js';
import { getFileChecksum } from '../lib/files.js';
import { loadTuckignore } from '../lib/tuckignore.js';
import { NotInitializedError } from '../errors.js';
import { VERSION } from '../constants.js';
import type { StatusOptions, FileChange } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TuckStatus {
  tuckDir: string;
  branch: string;
  remote?: string;
  remoteStatus: 'up-to-date' | 'ahead' | 'behind' | 'diverged' | 'no-remote';
  ahead: number;
  behind: number;
  trackedCount: number;
  categoryCounts: Record<string, number>;
  changes: FileChange[];
  gitChanges: {
    staged: string[];
    modified: string[];
    untracked: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Detection
// ─────────────────────────────────────────────────────────────────────────────

export const detectFileChanges = async (tuckDir: string): Promise<FileChange[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  const ignoredPaths = await loadTuckignore(tuckDir);
  const changes: FileChange[] = [];

  for (const [, file] of Object.entries(files)) {
    validateSafeSourcePath(file.source);
    getSafeRepoPathFromDestination(tuckDir, file.destination);

    if (ignoredPaths.has(file.source)) {
      continue;
    }

    const sourcePath = expandPath(file.source);

    if (!(await pathExists(sourcePath))) {
      changes.push({
        path: file.source,
        status: 'deleted',
        source: file.source,
        destination: file.destination,
      });
      continue;
    }

    try {
      const sourceChecksum = await getFileChecksum(sourcePath);
      if (sourceChecksum !== file.checksum) {
        changes.push({
          path: file.source,
          status: 'modified',
          source: file.source,
          destination: file.destination,
        });
      }
    } catch {
      changes.push({
        path: file.source,
        status: 'modified',
        source: file.source,
        destination: file.destination,
      });
    }
  }

  return changes;
};

const getFullStatus = async (tuckDir: string): Promise<TuckStatus> => {
  const manifest = await loadManifest(tuckDir);
  const gitStatus = await getStatus(tuckDir);
  const branch = await getCurrentBranch(tuckDir);
  const hasRemoteRepo = await hasRemote(tuckDir);
  const remoteUrl = hasRemoteRepo ? await getRemoteUrl(tuckDir) : undefined;

  let remoteStatus: TuckStatus['remoteStatus'] = 'no-remote';
  if (hasRemoteRepo) {
    if (gitStatus.ahead > 0 && gitStatus.behind > 0) {
      remoteStatus = 'diverged';
    } else if (gitStatus.ahead > 0) {
      remoteStatus = 'ahead';
    } else if (gitStatus.behind > 0) {
      remoteStatus = 'behind';
    } else {
      remoteStatus = 'up-to-date';
    }
  }

  const fileChanges = await detectFileChanges(tuckDir);

  const categoryCounts: Record<string, number> = {};
  for (const file of Object.values(manifest.files)) {
    categoryCounts[file.category] = (categoryCounts[file.category] || 0) + 1;
  }

  return {
    tuckDir,
    branch,
    remote: remoteUrl || undefined,
    remoteStatus,
    ahead: gitStatus.ahead,
    behind: gitStatus.behind,
    trackedCount: Object.keys(manifest.files).length,
    categoryCounts,
    changes: fileChanges,
    gitChanges: {
      staged: gitStatus.staged,
      modified: gitStatus.modified,
      untracked: gitStatus.untracked,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────────────────────

const formatRemoteUrl = (url: string): string => {
  // Shorten common patterns
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/^github\.com\//, '');
};

const printStatus = (status: TuckStatus): void => {
  // Header box
  const headerLines: string[] = [
    `${c.brandBold('tuck')} ${c.muted(`v${VERSION}`)}`,
    '',
    `${c.muted('Repository:')} ${collapsePath(status.tuckDir)}`,
    `${c.muted('Branch:')}     ${c.brand(status.branch)}`,
  ];

  if (status.remote) {
    headerLines.push(`${c.muted('Remote:')}     ${formatRemoteUrl(status.remote)}`);
  } else {
    headerLines.push(`${c.muted('Remote:')}     ${c.warning('not configured')}`);
  }

  console.log(boxen(headerLines.join('\n'), boxStyles.header));

  // Remote status
  if (status.remote) {
    console.log();
    switch (status.remoteStatus) {
      case 'up-to-date':
        console.log(logSymbols.success, c.success('Up to date with remote'));
        break;
      case 'ahead':
        console.log(
          c.warning(figures.arrowUp),
          c.warning(`${status.ahead} commit${status.ahead > 1 ? 's' : ''} ahead`)
        );
        break;
      case 'behind':
        console.log(
          c.warning(figures.arrowDown),
          c.warning(`${status.behind} commit${status.behind > 1 ? 's' : ''} behind`)
        );
        break;
      case 'diverged':
        console.log(
          logSymbols.warning,
          c.error(`Diverged (${status.ahead} ahead, ${status.behind} behind)`)
        );
        break;
    }
  }

  // Tracked files summary
  console.log();
  console.log(c.bold(`${status.trackedCount} files tracked`));

  // Category breakdown (inline, compact)
  const categoryOrder = ['shell', 'git', 'editors', 'terminal', 'ssh', 'misc'];
  const sortedCategories = Object.keys(status.categoryCounts).sort((a, b) => {
    const aIdx = categoryOrder.indexOf(a);
    const bIdx = categoryOrder.indexOf(b);
    if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  if (sortedCategories.length > 0) {
    const categoryLine = sortedCategories
      .map((cat) => {
        const style = categoryStyles[cat] || categoryStyles.misc;
        const count = status.categoryCounts[cat];
        return `${style.color(style.icon)} ${cat}: ${count}`;
      })
      .join('  ');
    console.log(c.muted(indent() + categoryLine));
  }

  // File changes
  if (status.changes.length > 0) {
    console.log();
    console.log(c.bold('Changes:'));
    for (const change of status.changes) {
      const statusText = formatStatus(change.status);
      console.log(`${indent()}${statusText} ${c.brand(change.path)}`);
    }
  }

  // Git changes
  const hasGitChanges =
    status.gitChanges.staged.length > 0 ||
    status.gitChanges.modified.length > 0 ||
    status.gitChanges.untracked.length > 0;

  if (hasGitChanges) {
    console.log();
    console.log(c.bold('Repository:'));

    if (status.gitChanges.staged.length > 0) {
      console.log(c.success(`${indent()}Staged:`));
      status.gitChanges.staged.forEach((f) =>
        console.log(c.success(`${indent()}${indent()}+ ${f}`))
      );
    }

    if (status.gitChanges.modified.length > 0) {
      console.log(c.warning(`${indent()}Modified:`));
      status.gitChanges.modified.forEach((f) =>
        console.log(c.warning(`${indent()}${indent()}~ ${f}`))
      );
    }

    if (status.gitChanges.untracked.length > 0) {
      console.log(c.muted(`${indent()}Untracked:`));
      status.gitChanges.untracked.forEach((f) =>
        console.log(c.muted(`${indent()}${indent()}? ${f}`))
      );
    }
  }

  console.log();

  // Next step suggestion
  if (status.changes.length > 0) {
    prompts.note("Run 'tuck sync' to commit changes", 'Next');
  } else if (status.remoteStatus === 'ahead') {
    prompts.note("Run 'tuck push' to push changes", 'Next');
  } else if (status.remoteStatus === 'behind') {
    prompts.note("Run 'tuck pull' to pull changes", 'Next');
  } else if (status.trackedCount === 0) {
    prompts.note("Run 'tuck add <path>' to start tracking", 'Next');
  } else {
    prompts.outro('Everything up to date');
  }
};

const printShortStatus = (status: TuckStatus): void => {
  const parts: string[] = [];

  parts.push(`[${status.branch}]`);

  if (status.remoteStatus === 'ahead') {
    parts.push(c.warning(`${figures.arrowUp}${status.ahead}`));
  } else if (status.remoteStatus === 'behind') {
    parts.push(c.warning(`${figures.arrowDown}${status.behind}`));
  } else if (status.remoteStatus === 'diverged') {
    parts.push(c.error(`${figures.arrowUp}${status.ahead}${figures.arrowDown}${status.behind}`));
  }

  if (status.changes.length > 0) {
    const modified = status.changes.filter((ch) => ch.status === 'modified').length;
    const deleted = status.changes.filter((ch) => ch.status === 'deleted').length;
    if (modified > 0) parts.push(c.warning(`~${modified}`));
    if (deleted > 0) parts.push(c.error(`-${deleted}`));
  }

  parts.push(c.muted(`(${status.trackedCount} tracked)`));

  console.log(parts.join(' '));
};

const printJsonStatus = (status: TuckStatus): void => {
  console.log(JSON.stringify(status, null, 2));
};

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

export const runStatus = async (options: StatusOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  const status = await getFullStatus(tuckDir);

  if (options.json) {
    printJsonStatus(status);
  } else if (options.short) {
    printShortStatus(status);
  } else {
    printStatus(status);
  }
};

export const statusCommand = new Command('status')
  .description('Show current tracking status')
  .option('--short', 'Short format')
  .option('--json', 'Output as JSON')
  .action(async (options: StatusOptions) => {
    await runStatus(options);
  });
