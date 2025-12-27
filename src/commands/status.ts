import { Command } from 'commander';
import chalk from 'chalk';
import { prompts, formatStatus } from '../ui/index.js';
import { getTuckDir, collapsePath, expandPath, pathExists } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles } from '../lib/manifest.js';
import { getStatus, hasRemote, getRemoteUrl, getCurrentBranch } from '../lib/git.js';
import { getFileChecksum } from '../lib/files.js';
import { NotInitializedError } from '../errors.js';
import type { StatusOptions, FileChange } from '../types.js';

interface TuckStatus {
  tuckDir: string;
  branch: string;
  remote?: string;
  remoteStatus: 'up-to-date' | 'ahead' | 'behind' | 'diverged' | 'no-remote';
  ahead: number;
  behind: number;
  trackedCount: number;
  changes: FileChange[];
  gitChanges: {
    staged: string[];
    modified: string[];
    untracked: string[];
  };
}

const detectFileChanges = async (tuckDir: string): Promise<FileChange[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  const changes: FileChange[] = [];

  for (const [, file] of Object.entries(files)) {
    const sourcePath = expandPath(file.source);

    // Check if source still exists
    if (!(await pathExists(sourcePath))) {
      changes.push({
        path: file.source,
        status: 'deleted',
        source: file.source,
        destination: file.destination,
      });
      continue;
    }

    // Check if file has changed
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
      // Error reading file, mark as modified
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

  return {
    tuckDir,
    branch,
    remote: remoteUrl || undefined,
    remoteStatus,
    ahead: gitStatus.ahead,
    behind: gitStatus.behind,
    trackedCount: Object.keys(manifest.files).length,
    changes: fileChanges,
    gitChanges: {
      staged: gitStatus.staged,
      modified: gitStatus.modified,
      untracked: gitStatus.untracked,
    },
  };
};

const printStatus = (status: TuckStatus): void => {
  prompts.intro('tuck status');

  // Repository info
  console.log();
  console.log(chalk.dim('Repository:'), collapsePath(status.tuckDir));
  console.log(chalk.dim('Branch:'), chalk.cyan(status.branch));

  if (status.remote) {
    console.log(chalk.dim('Remote:'), status.remote);

    let remoteInfo = '';
    switch (status.remoteStatus) {
      case 'up-to-date':
        remoteInfo = chalk.green('up to date');
        break;
      case 'ahead':
        remoteInfo = chalk.yellow(`${status.ahead} commit${status.ahead > 1 ? 's' : ''} ahead`);
        break;
      case 'behind':
        remoteInfo = chalk.yellow(`${status.behind} commit${status.behind > 1 ? 's' : ''} behind`);
        break;
      case 'diverged':
        remoteInfo = chalk.red(`diverged (${status.ahead} ahead, ${status.behind} behind)`);
        break;
    }
    console.log(chalk.dim('Status:'), remoteInfo);
  } else {
    console.log(chalk.dim('Remote:'), chalk.yellow('not configured'));
  }

  console.log();
  console.log(chalk.dim('Tracked files:'), status.trackedCount);

  // File changes
  if (status.changes.length > 0) {
    console.log();
    console.log(chalk.bold('Changes detected:'));
    for (const change of status.changes) {
      const statusText = formatStatus(change.status);
      console.log(`  ${statusText}: ${chalk.cyan(change.path)}`);
    }
  }

  // Git changes in repository
  const hasGitChanges =
    status.gitChanges.staged.length > 0 ||
    status.gitChanges.modified.length > 0 ||
    status.gitChanges.untracked.length > 0;

  if (hasGitChanges) {
    console.log();
    console.log(chalk.bold('Repository changes:'));

    if (status.gitChanges.staged.length > 0) {
      console.log(chalk.green('  Staged:'));
      status.gitChanges.staged.forEach((f) => console.log(chalk.green(`    + ${f}`)));
    }

    if (status.gitChanges.modified.length > 0) {
      console.log(chalk.yellow('  Modified:'));
      status.gitChanges.modified.forEach((f) => console.log(chalk.yellow(`    ~ ${f}`)));
    }

    if (status.gitChanges.untracked.length > 0) {
      console.log(chalk.dim('  Untracked:'));
      status.gitChanges.untracked.forEach((f) => console.log(chalk.dim(`    ? ${f}`)));
    }
  }

  console.log();

  // Suggestions
  if (status.changes.length > 0) {
    prompts.note("Run 'tuck sync' to commit changes", 'Next step');
  } else if (status.remoteStatus === 'ahead') {
    prompts.note("Run 'tuck push' to push changes to remote", 'Next step');
  } else if (status.remoteStatus === 'behind') {
    prompts.note("Run 'tuck pull' to pull changes from remote", 'Next step');
  } else if (status.trackedCount === 0) {
    prompts.note("Run 'tuck add <path>' to start tracking files", 'Next step');
  } else {
    prompts.outro('Everything is up to date');
  }
};

const printShortStatus = (status: TuckStatus): void => {
  const parts: string[] = [];

  parts.push(`[${status.branch}]`);

  if (status.remoteStatus === 'ahead') {
    parts.push(`↑${status.ahead}`);
  } else if (status.remoteStatus === 'behind') {
    parts.push(`↓${status.behind}`);
  } else if (status.remoteStatus === 'diverged') {
    parts.push(`↑${status.ahead}↓${status.behind}`);
  }

  if (status.changes.length > 0) {
    const modified = status.changes.filter((c) => c.status === 'modified').length;
    const deleted = status.changes.filter((c) => c.status === 'deleted').length;
    if (modified > 0) parts.push(`~${modified}`);
    if (deleted > 0) parts.push(`-${deleted}`);
  }

  parts.push(`(${status.trackedCount} tracked)`);

  console.log(parts.join(' '));
};

const printJsonStatus = (status: TuckStatus): void => {
  console.log(JSON.stringify(status, null, 2));
};

const runStatus = async (options: StatusOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
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
