/**
 * Merge / rebase conflict detection and resolution.
 *
 * When `tuck sync` runs `git pull --rebase`, git can stop the rebase if a
 * tracked file diverges between local and remote. This module exposes the
 * primitives the sync command and JSON layer need to drive that resolution:
 *
 *   - {@link detectConflicts}  — list conflicted files with ours/theirs/base
 *                                content extracted from the git index.
 *   - {@link applyResolution}  — write the chosen side (or edited content) and
 *                                stage it.
 *   - {@link continueRebase}   — finish whichever operation is in progress
 *                                (rebase or merge) after all resolutions are
 *                                applied.
 *   - {@link abortRebase}      — back out and return to the pre-pull state.
 *
 * Everything here works against a real on-disk git repo via `simple-git`. The
 * helpers never mutate user files outside the repo and never spawn `$EDITOR`
 * directly — that lives in the UI layer so the library remains test-friendly.
 */
import { join } from 'path';
import { promises as fs } from 'fs';
import simpleGit, { type SimpleGit } from 'simple-git';
import { GitError } from '../errors.js';

export interface FileConflict {
  /** File path relative to the git repository root. */
  path: string;
  /** Local ("ours") content at the conflict, or empty string if the side was deleted. */
  ours: string;
  /** Remote ("theirs") content at the conflict, or empty string if the side was deleted. */
  theirs: string;
  /** Common-ancestor ("base") content, when available. */
  base?: string;
  /** True when the local side deleted the file. */
  oursDeleted?: boolean;
  /** True when the remote side deleted the file. */
  theirsDeleted?: boolean;
}

export type ConflictChoice = 'ours' | 'theirs' | 'edited' | 'abort';

export interface ConflictResolution {
  path: string;
  choice: ConflictChoice;
  /** Required when `choice === 'edited'`. The full file content the user produced. */
  finalContent?: string;
}

/** Status codes from `git status --porcelain` that indicate a merge/rebase conflict. */
const CONFLICT_XY_CODES: ReadonlySet<string> = new Set([
  'DD', // both deleted
  'AA', // both added
  'UU', // both modified
  'AU', // added by us, modified by them
  'UA', // added by them, modified by us
  'DU', // deleted by us, modified by them
  'UD', // modified by us, deleted by them
]);

const createGit = (dir: string): SimpleGit =>
  simpleGit(dir, {
    binary: 'git',
    maxConcurrentProcesses: 6,
    // Important: do NOT trim. We need exact byte-for-byte content from
    // `git show :N:<path>` so that resolutions reproduce trailing newlines and
    // whitespace faithfully.
    trimmed: false,
  });

/**
 * Return the content of an indexed conflict stage, or undefined if that stage
 * does not exist (e.g. the file was deleted on that side).
 *
 *   stage 1 = base (common ancestor)
 *   stage 2 = ours (local)
 *   stage 3 = theirs (remote)
 */
const readIndexStage = async (
  git: SimpleGit,
  stage: 1 | 2 | 3,
  path: string
): Promise<string | undefined> => {
  try {
    return await git.raw(['show', `:${stage}:${path}`]);
  } catch {
    return undefined;
  }
};

/**
 * Parse `git status --porcelain=v1` output. Returns the list of conflicted
 * paths (XY code present in {@link CONFLICT_XY_CODES}).
 *
 * `git status --porcelain` emits two single-char status codes followed by a
 * space and the path. For rename/copy entries the second part contains
 * `orig -> new`; conflicts don't use those so we treat the whole tail as the
 * path.
 */
const parseConflictedPaths = (porcelain: string): string[] => {
  const conflicts: string[] = [];
  const lines = porcelain.split('\n');

  for (const line of lines) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    if (!CONFLICT_XY_CODES.has(xy)) continue;

    // Porcelain v1 format: "XY <path>". Conflicts never carry rename arrows so
    // a straight slice from index 3 is safe.
    const path = line.slice(3).trim();
    if (path.length > 0) {
      conflicts.push(path);
    }
  }

  return conflicts;
};

/**
 * Inspect the current git tree for files marked as conflicted by git's
 * merge/rebase machinery and return their ours/theirs/base content.
 */
export const detectConflicts = async (repo: string): Promise<FileConflict[]> => {
  const git = createGit(repo);
  let porcelain: string;
  try {
    porcelain = await git.raw(['status', '--porcelain=v1']);
  } catch (error) {
    throw new GitError('Failed to read git status while detecting conflicts', String(error));
  }

  const paths = parseConflictedPaths(porcelain);
  const conflicts: FileConflict[] = [];

  for (const path of paths) {
    const [base, ours, theirs] = await Promise.all([
      readIndexStage(git, 1, path),
      readIndexStage(git, 2, path),
      readIndexStage(git, 3, path),
    ]);

    conflicts.push({
      path,
      ours: ours ?? '',
      theirs: theirs ?? '',
      base,
      oursDeleted: ours === undefined,
      theirsDeleted: theirs === undefined,
    });
  }

  return conflicts;
};

/**
 * Apply a conflict resolution: write the chosen content (or pick a side) and
 * stage it so the rebase / merge can continue.
 *
 * For `abort` no per-file work happens — call {@link abortRebase} at the caller
 * level instead.
 */
export const applyResolution = async (
  repo: string,
  res: ConflictResolution
): Promise<void> => {
  if (res.choice === 'abort') {
    return;
  }

  const git = createGit(repo);
  const absolutePath = join(repo, res.path);

  try {
    if (res.choice === 'ours') {
      await git.raw(['checkout', '--ours', '--', res.path]);
      await git.raw(['add', '--', res.path]);
      return;
    }

    if (res.choice === 'theirs') {
      await git.raw(['checkout', '--theirs', '--', res.path]);
      await git.raw(['add', '--', res.path]);
      return;
    }

    if (res.choice === 'edited') {
      if (typeof res.finalContent !== 'string') {
        throw new GitError(
          `Cannot apply edited resolution for ${res.path}: finalContent is required`
        );
      }
      await fs.writeFile(absolutePath, res.finalContent, 'utf-8');
      await git.raw(['add', '--', res.path]);
      return;
    }
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(`Failed to apply resolution for ${res.path}`, String(error));
  }
};

/**
 * Detect whether the repo is mid-rebase or mid-merge. The presence of a
 * `rebase-merge` or `rebase-apply` directory in `.git/` signals a rebase;
 * `MERGE_HEAD` signals a merge.
 */
const detectInProgress = async (
  repo: string
): Promise<'rebase' | 'merge' | 'none'> => {
  const gitDir = join(repo, '.git');
  const candidates: Array<{ name: string; kind: 'rebase' | 'merge' }> = [
    { name: 'rebase-merge', kind: 'rebase' },
    { name: 'rebase-apply', kind: 'rebase' },
    { name: 'MERGE_HEAD', kind: 'merge' },
  ];

  for (const { name, kind } of candidates) {
    try {
      await fs.access(join(gitDir, name));
      return kind;
    } catch {
      // Try next candidate.
    }
  }

  return 'none';
};

/**
 * Finalize a rebase or merge after every conflict has been resolved and
 * staged. Picks `--continue` for the operation that is currently in progress.
 */
export const continueRebase = async (repo: string): Promise<void> => {
  const inProgress = await detectInProgress(repo);
  const git = createGit(repo);

  try {
    if (inProgress === 'rebase') {
      await git.raw(['-c', 'core.editor=true', 'rebase', '--continue']);
      return;
    }

    if (inProgress === 'merge') {
      await git.raw(['-c', 'core.editor=true', 'merge', '--continue']);
      return;
    }

    // Nothing in progress — caller already finished. Idempotent.
  } catch (error) {
    throw new GitError('Failed to continue rebase/merge after conflict resolution', String(error));
  }
};

/**
 * Abort the in-progress rebase or merge. Idempotent: returns silently if
 * nothing is in progress.
 */
export const abortRebase = async (repo: string): Promise<void> => {
  const inProgress = await detectInProgress(repo);
  const git = createGit(repo);

  try {
    if (inProgress === 'rebase') {
      await git.raw(['rebase', '--abort']);
      return;
    }

    if (inProgress === 'merge') {
      await git.raw(['merge', '--abort']);
      return;
    }
  } catch (error) {
    throw new GitError('Failed to abort rebase/merge', String(error));
  }
};
