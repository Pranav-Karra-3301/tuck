import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import { GitError } from '../errors.js';
import { pathExists } from './paths.js';
import { join } from 'path';

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  tracking?: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  hasChanges: boolean;
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
}

const createGit = (dir: string): SimpleGit => {
  return simpleGit(dir, {
    binary: 'git',
    maxConcurrentProcesses: 6,
    trimmed: true,
  });
};

export const isGitRepo = async (dir: string): Promise<boolean> => {
  const gitDir = join(dir, '.git');
  return pathExists(gitDir);
};

export const initRepo = async (dir: string): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.init();
  } catch (error) {
    throw new GitError('Failed to initialize repository', String(error));
  }
};

export const cloneRepo = async (url: string, dir: string): Promise<void> => {
  try {
    const git = simpleGit();
    await git.clone(url, dir);
  } catch (error) {
    throw new GitError(`Failed to clone repository from ${url}`, String(error));
  }
};

export const addRemote = async (dir: string, name: string, url: string): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.addRemote(name, url);
  } catch (error) {
    throw new GitError('Failed to add remote', String(error));
  }
};

export const removeRemote = async (dir: string, name: string): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.removeRemote(name);
  } catch (error) {
    throw new GitError('Failed to remove remote', String(error));
  }
};

export const getRemotes = async (dir: string): Promise<{ name: string; url: string }[]> => {
  try {
    const git = createGit(dir);
    const remotes = await git.getRemotes(true);
    return remotes.map((r) => ({ name: r.name, url: r.refs.fetch || r.refs.push || '' }));
  } catch (error) {
    throw new GitError('Failed to get remotes', String(error));
  }
};

export const getStatus = async (dir: string): Promise<GitStatus> => {
  try {
    const git = createGit(dir);
    const status: StatusResult = await git.status();

    return {
      isRepo: true,
      branch: status.current || 'main',
      tracking: status.tracking || undefined,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      untracked: status.not_added,
      deleted: status.deleted,
      hasChanges: !status.isClean(),
    };
  } catch (error) {
    throw new GitError('Failed to get status', String(error));
  }
};

export const stageFiles = async (dir: string, files: string[]): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.add(files);
  } catch (error) {
    throw new GitError('Failed to stage files', String(error));
  }
};

export const stageAll = async (dir: string): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.add('.');
  } catch (error) {
    throw new GitError('Failed to stage all files', String(error));
  }
};

export const commit = async (dir: string, message: string): Promise<string> => {
  try {
    const git = createGit(dir);
    const result = await git.commit(message);
    return result.commit;
  } catch (error) {
    throw new GitError('Failed to commit', String(error));
  }
};

export const push = async (
  dir: string,
  options?: { remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }
): Promise<void> => {
  try {
    const git = createGit(dir);
    const args: string[] = [];

    if (options?.setUpstream) {
      args.push('-u');
    }
    if (options?.force) {
      args.push('--force');
    }

    const remote = options?.remote || 'origin';
    const branch = options?.branch;

    if (branch) {
      await git.push([remote, branch, ...args]);
    } else {
      await git.push([remote, ...args]);
    }
  } catch (error) {
    throw new GitError('Failed to push', String(error));
  }
};

export const pull = async (
  dir: string,
  options?: { remote?: string; branch?: string; rebase?: boolean }
): Promise<void> => {
  try {
    const git = createGit(dir);
    const args: string[] = [];

    if (options?.rebase) {
      args.push('--rebase');
    }

    const remote = options?.remote || 'origin';
    const branch = options?.branch;

    if (branch) {
      await git.pull(remote, branch, args);
    } else {
      await git.pull(remote, undefined, args);
    }
  } catch (error) {
    throw new GitError('Failed to pull', String(error));
  }
};

export const fetch = async (dir: string, remote = 'origin'): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.fetch(remote);
  } catch (error) {
    throw new GitError('Failed to fetch', String(error));
  }
};

export const getLog = async (
  dir: string,
  options?: { maxCount?: number }
): Promise<GitCommit[]> => {
  try {
    const git = createGit(dir);
    const log = await git.log({
      maxCount: options?.maxCount || 10,
    });

    return log.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name || 'Unknown',
    }));
  } catch (error) {
    throw new GitError('Failed to get log', String(error));
  }
};

export const getDiff = async (
  dir: string,
  options?: { staged?: boolean; stat?: boolean; files?: string[] }
): Promise<string> => {
  try {
    const git = createGit(dir);
    const args: string[] = [];

    if (options?.staged) {
      args.push('--staged');
    }
    if (options?.stat) {
      args.push('--stat');
    }
    if (options?.files) {
      args.push('--');
      args.push(...options.files);
    }

    const result = await git.diff(args);
    return result;
  } catch (error) {
    throw new GitError('Failed to get diff', String(error));
  }
};

export const getCurrentBranch = async (dir: string): Promise<string> => {
  try {
    const git = createGit(dir);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    return branch;
  } catch (error) {
    throw new GitError('Failed to get current branch', String(error));
  }
};

export const hasRemote = async (dir: string, name = 'origin'): Promise<boolean> => {
  try {
    const remotes = await getRemotes(dir);
    return remotes.some((r) => r.name === name);
  } catch {
    return false;
  }
};

export const getRemoteUrl = async (dir: string, name = 'origin'): Promise<string | null> => {
  try {
    const remotes = await getRemotes(dir);
    const remote = remotes.find((r) => r.name === name);
    return remote?.url || null;
  } catch {
    return null;
  }
};

export const setDefaultBranch = async (dir: string, branch: string): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.branch(['-M', branch]);
  } catch (error) {
    throw new GitError('Failed to set default branch', String(error));
  }
};
