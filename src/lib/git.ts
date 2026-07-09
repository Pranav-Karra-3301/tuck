import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitError } from '../errors.js';
import { pathExists } from './paths.js';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { REPO_STAGE_BLOCKLIST } from './state.js';
import { GIT_OPERATION_TIMEOUTS } from './validation.js';

const execFileAsync = promisify(execFile);

/**
 * Upper bound on the buffered output of a single git child process. Mirrors
 * CustomProvider.cloneRepo so a hostile/huge remote cannot make tuck buffer
 * unbounded data into memory during a clone.
 */
const CLONE_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

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
    // Bound the clone: a hung or hostile remote must never let `tuck init` /
    // `tuck apply` hang forever, nor buffer unbounded output into memory.
    //
    // We shell out to `git clone` via Node's `execFile` (mirroring
    // CustomProvider.cloneRepo) instead of simple-git, because simple-git v3
    // does NOT forward `maxBuffer` to the underlying child process — only its
    // `timeout.block` is honored, so the memory bound would silently be a no-op.
    // `execFile`'s own `timeout` kills the process and `maxBuffer` caps output.
    await execFileAsync('git', ['clone', url, dir], {
      timeout: GIT_OPERATION_TIMEOUTS.CLONE,
      maxBuffer: CLONE_MAX_BUFFER,
    });
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

/**
 * Point an existing remote at a new URL (`git remote set-url <name> <url>`).
 */
export const setRemoteUrl = async (dir: string, name: string, url: string): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.remote(['set-url', name, url]);
  } catch (error) {
    throw new GitError('Failed to set remote url', String(error));
  }
};

/**
 * Idempotently configure a remote: if it already exists, update its URL in
 * place; otherwise add it. This avoids the remove-then-add race (a transient
 * state with NO origin) that breaks concurrent/repeated reconfiguration.
 */
export const upsertRemote = async (dir: string, name: string, url: string): Promise<void> => {
  try {
    if (await hasRemote(dir, name)) {
      await setRemoteUrl(dir, name, url);
    } else {
      await addRemote(dir, name, url);
    }
  } catch (error) {
    if (error instanceof GitError) {
      throw error;
    }
    throw new GitError('Failed to upsert remote', String(error));
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

    // Never `git add --all` over unresolved conflicts: that stages files still
    // containing '<<<<<<<'/'>>>>>>>' markers and a subsequent commit would bake
    // the corruption into history. Bail out and let the caller resolve first.
    const status = await git.status();
    const conflicted = status.conflicted ?? [];
    if (conflicted.length > 0) {
      throw new GitError(
        'Refusing to stage files while merge conflicts are unresolved',
        `Resolve conflicts (${conflicted.slice(0, 3).join(', ')}) or run 'git merge --abort'`
      );
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const stageTargets = entries
      .map((entry) => entry.name)
      .filter((name) => !REPO_STAGE_BLOCKLIST.has(name));

    if (stageTargets.length === 0) {
      return;
    }

    await git.raw(['add', '--all', '--', ...stageTargets]);
  } catch (error) {
    if (error instanceof GitError) throw error;
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

/**
 * True only for HTTPS github.com remotes. `gh auth setup-git` rewrites GLOBAL
 * git credential routing for github.com/gist.github.com, so it must never run
 * for GitLab, Gitea, SSH, or any non-GitHub remote — doing so would silently
 * hijack credential handling for every repo on the machine.
 */
const isHttpsGitHubRemote = (url: string): boolean => {
  return /^https:\/\/(www\.)?github\.com\//i.test(url.trim());
};

/**
 * Configure git to use gh CLI credentials if gh is authenticated
 */
const ensureGitCredentials = async (): Promise<void> => {
  try {
    // Check if gh is authenticated
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status']);
    // gh auth status writes its output to stderr per gh CLI design
    const output = (stderr || stdout || '').trim();
    
    if (output.includes('Logged in')) {
      // gh is authenticated, configure git to use it
      await execFileAsync('gh', ['auth', 'setup-git']);
    }
  } catch {
    // gh CLI not available or not authenticated; skip git credential setup.
    // This is expected on systems without gh CLI or when user hasn't logged in.
    // Git will fall back to default credential mechanisms (ssh keys, https tokens, etc.)
  }
};

/**
 * First meaningful line of raw git output, as a suggestion entry. Only the
 * generic fallback branches use this: when classification failed, the raw
 * evidence is the most actionable thing we can show (the full output is on
 * `GitError.gitOutput`, serialized as `git_output` in JSON mode and printed
 * under DEBUG=1).
 */
const rawFirstLine = (raw: string): string[] => {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? [`git said: ${line.slice(0, 200)}`] : [];
};

/**
 * Turn a raw git failure into a {@link GitError} with context and actionable
 * suggestions (issue #52). Git's stderr is terse and inconsistent; agents and
 * humans both benefit from tuck naming the likely cause and the fix. Falls back
 * to a generic message (with the raw output as the suggestion) when nothing
 * recognizable matches, so behavior never regresses.
 *
 * Exported for unit testing of the classification logic.
 */
export const describeGitError = (
  operation: 'push' | 'pull' | 'fetch',
  raw: string
): GitError => {
  const text = raw.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => text.includes(n));

  // Authentication / permission problems affect every network operation.
  if (
    has(
      'authentication failed',
      'could not read username',
      'could not read password',
      'permission denied (publickey)',
      'invalid username or password',
      'terminal prompts disabled',
      'http basic: access denied',
      'remote: invalid credentials',
      'error: 403',
      'error: 401'
    )
  ) {
    return new GitError(`${operation} failed: authentication with the remote was rejected`, raw, [
      'Verify your credentials for the git remote',
      'For GitHub over HTTPS, run `gh auth login` (or `gh auth setup-git`)',
      'For SSH, confirm your key is added: `ssh -T git@github.com`',
      'Check the remote URL with `tuck config get` or `git remote -v`',
    ]);
  }

  // Host unreachable / offline.
  if (has('could not resolve host', 'unable to access', 'connection timed out', 'network is unreachable', 'failed to connect')) {
    return new GitError(`${operation} failed: could not reach the remote`, raw, [
      'Check your network connection',
      'Verify the remote URL is correct and reachable',
      'Retry once connectivity is restored',
    ]);
  }

  if (operation === 'push') {
    if (has('[rejected]', 'non-fast-forward', 'fetch first', 'tip of your current branch is behind', 'updates were rejected')) {
      return new GitError('push rejected: the remote has commits you do not have locally', raw, [
        'Run `tuck pull` first to integrate the remote changes, then push again',
        'Or use `tuck push --force` to overwrite the remote (use with caution — this can discard remote history)',
      ]);
    }
    if (has('has no upstream branch', 'set-upstream', 'no upstream configured')) {
      return new GitError('push failed: the current branch has no upstream configured', raw, [
        'Run `tuck push` again — tuck sets the upstream automatically on first push',
        'Or set it manually with `git push --set-upstream origin <branch>`',
      ]);
    }
    return new GitError('Failed to push', raw, [
    ...rawFirstLine(raw),
      'Run `tuck pull` to sync with the remote, then retry',
      'Inspect the repo with `git status` to see what changed',
    ]);
  }

  if (operation === 'pull') {
    // Check uncommitted-local-changes before conflicts: git phrases it as
    // "...would be overwritten by merge", which also contains the word "merge".
    if (has('local changes', 'would be overwritten', 'commit your changes or stash')) {
      return new GitError('pull failed: you have uncommitted local changes', raw, [
        'Run `tuck sync` to commit your changes first, then pull',
        'Or stash them with `git stash` before pulling',
      ]);
    }
    if (has('merge conflict', 'conflict (', 'fix conflicts', 'needs merge', 'automatic merge failed')) {
      return new GitError('pull produced merge conflicts', raw, [
        'Run `tuck sync` in an interactive terminal to resolve the conflicts',
        'Inspect the conflicting files with `git status`',
        'Use `git merge --abort` (or `git rebase --abort`) to back out',
      ]);
    }
    if (has('divergent branches', 'need to specify how to reconcile', 'not possible to fast-forward')) {
      return new GitError('pull failed: local and remote branches have diverged', raw, [
        'Run `tuck pull` with rebase, or resolve the divergence with `git pull --rebase`',
        'Inspect both histories with `git log --oneline --graph`',
      ]);
    }
    return new GitError('Failed to pull', raw, [
    ...rawFirstLine(raw),
      'Inspect the repo with `git status`',
      'Retry after resolving any local changes',
    ]);
  }

  // fetch
  return new GitError('Failed to fetch', raw, [
    ...rawFirstLine(raw),
    'Verify the remote is configured with `git remote -v`',
    'Check your network connection and credentials',
  ]);
};

export const push = async (
  dir: string,
  options?: { remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }
): Promise<void> => {
  try {
    const remote = options?.remote || 'origin';

    // Only wire up gh credentials for HTTPS github.com remotes. Running
    // `gh auth setup-git` for a GitLab/custom/SSH remote would rewrite the
    // user's GLOBAL github.com credential routing for every repo on the machine.
    const remoteUrl = await getRemoteUrl(dir, remote);
    if (remoteUrl && isHttpsGitHubRemote(remoteUrl)) {
      await ensureGitCredentials();
    }

    const git = createGit(dir);
    const args: string[] = [];

    if (options?.setUpstream) {
      args.push('-u');
    }
    if (options?.force) {
      args.push('--force');
    }

    const branch = options?.branch;

    if (branch) {
      await git.push([...args, remote, branch]);
    } else {
      await git.push([...args, remote]);
    }
  } catch (error) {
    throw describeGitError('push', String(error));
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
    throw describeGitError('pull', String(error));
  }
};

export const fetch = async (dir: string, remote = 'origin'): Promise<void> => {
  try {
    const git = createGit(dir);
    await git.fetch(remote);
  } catch (error) {
    throw describeGitError('fetch', String(error));
  }
};

/**
 * Count how many commits the local HEAD is behind `<remote>/<branch>`.
 *
 * `getStatus().behind` is derived from the upstream tracking ref and reports 0
 * whenever the branch has no upstream — even if the remote holds commits. After
 * a fetch this walks `HEAD..<remote>/<branch>` directly, so it stays accurate
 * without an upstream. Returns null when the remote branch does not exist
 * (nothing to compare against).
 */
export const countCommitsBehindRemote = async (
  dir: string,
  branch: string,
  remote = 'origin'
): Promise<number | null> => {
  try {
    const git = createGit(dir);
    const out = await git.raw(['rev-list', '--count', `HEAD..${remote}/${branch}`]);
    const count = Number.parseInt(out.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    // No such remote-tracking ref (e.g. the branch was never pushed).
    return null;
  }
};

export const getLog = async (
  dir: string,
  options?: { maxCount?: number; since?: string }
): Promise<GitCommit[]> => {
  try {
    const git = createGit(dir);
    const logOptions: { maxCount?: number; '--since'?: string } = {
      maxCount: options?.maxCount || 10,
    };

    if (options?.since) {
      logOptions['--since'] = options.since;
    }

    const log = await git.log(logOptions);

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
    return branch.trim();
  } catch {
    // Fallback for repos with no commits - read symbolic-ref directly
    try {
      const git = createGit(dir);
      const ref = await git.raw(['symbolic-ref', '--short', 'HEAD']);
      return ref.trim();
    } catch {
      // Last resort - return default branch name
      return 'main';
    }
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
