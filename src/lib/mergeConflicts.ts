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
 * Decode a path as emitted by `git status --porcelain=v1`.
 *
 * With the default `core.quotepath=true`, git C-quotes any path containing
 * non-ASCII bytes, control chars, a double quote, or a backslash: it wraps the
 * path in double quotes and escapes bytes as octal (`\303\251`) or C escapes
 * (`\\`, `\"`, `\t`, …). The octal escapes are raw UTF-8 *bytes*, so a naive
 * char-by-char decode mangles multibyte characters — we accumulate bytes and
 * decode the buffer as UTF-8 once. Unquoted paths are returned verbatim (only a
 * trailing CR from Windows line endings is stripped).
 */
const unquoteGitPath = (raw: string): string => {
  const s = raw.replace(/\r$/, '');
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) {
    return s;
  }

  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  const cEscapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
  };

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      // A literal (already-decoded) character; re-encode to its UTF-8 bytes so
      // it round-trips through the buffer decode below.
      for (const b of Buffer.from(ch, 'utf-8')) bytes.push(b);
      continue;
    }

    const next = inner[i + 1];
    if (next === undefined) break;

    if (next >= '0' && next <= '7') {
      const octal = inner.slice(i + 1).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
    } else {
      bytes.push(cEscapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }

  return Buffer.from(bytes).toString('utf-8');
};

/**
 * Parse `git status --porcelain=v1` output. Returns the list of conflicted
 * paths (XY code present in {@link CONFLICT_XY_CODES}).
 *
 * `git status --porcelain` emits two single-char status codes followed by a
 * space and the path. For rename/copy entries the second part contains
 * `orig -> new`; conflicts don't use those so we treat the whole tail as the
 * path. Paths with special characters arrive C-quoted; {@link unquoteGitPath}
 * restores the real on-disk name so the downstream `git show`/`checkout`/`rm`
 * commands operate on a valid pathspec.
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
    const path = unquoteGitPath(line.slice(3));
    if (path.length > 0) {
      conflicts.push(path);
    }
  }

  return conflicts;
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
 * During `git pull --rebase`, git replays the LOCAL commits on top of the
 * REMOTE tip, which swaps the conflict index stages relative to a normal merge:
 * stage 2 (git's `--ours`) becomes the REMOTE/upstream side and stage 3
 * (`--theirs`) becomes the LOCAL side being replayed. tuck sync always pulls
 * with `--rebase`, so we normalize back to user-facing semantics here — the
 * `ours`/`theirs` a user sees and confirms must mean local/remote regardless of
 * git's internal orientation.
 *
 * Returns the git index stage (2 or 3) and `git checkout` flag that correspond
 * to the LOCAL and REMOTE sides for the operation currently in progress.
 */
const sideOrientation = (
  inProgress: 'rebase' | 'merge' | 'none'
): {
  localStage: 2 | 3;
  remoteStage: 2 | 3;
  localFlag: '--ours' | '--theirs';
  remoteFlag: '--ours' | '--theirs';
} => {
  if (inProgress === 'rebase') {
    return {
      localStage: 3,
      remoteStage: 2,
      localFlag: '--theirs',
      remoteFlag: '--ours',
    };
  }
  return {
    localStage: 2,
    remoteStage: 3,
    localFlag: '--ours',
    remoteFlag: '--theirs',
  };
};

/**
 * Inspect the current git tree for files marked as conflicted by git's
 * merge/rebase machinery and return their ours/theirs/base content.
 *
 * `ours` is always the LOCAL side and `theirs` the REMOTE side from the user's
 * perspective, even during a rebase where git swaps the underlying stages (see
 * {@link sideOrientation}).
 */
export const detectConflicts = async (repo: string): Promise<FileConflict[]> => {
  const git = createGit(repo);
  let porcelain: string;
  try {
    porcelain = await git.raw(['status', '--porcelain=v1']);
  } catch (error) {
    throw new GitError('Failed to read git status while detecting conflicts', String(error));
  }

  const orientation = sideOrientation(await detectInProgress(repo));
  const paths = parseConflictedPaths(porcelain);
  const conflicts: FileConflict[] = [];

  for (const path of paths) {
    const [base, stage2, stage3] = await Promise.all([
      readIndexStage(git, 1, path),
      readIndexStage(git, 2, path),
      readIndexStage(git, 3, path),
    ]);

    const localContent = orientation.localStage === 2 ? stage2 : stage3;
    const remoteContent = orientation.remoteStage === 2 ? stage2 : stage3;

    conflicts.push({
      path,
      ours: localContent ?? '',
      theirs: remoteContent ?? '',
      base,
      oursDeleted: localContent === undefined,
      theirsDeleted: remoteContent === undefined,
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
  const orientation = sideOrientation(await detectInProgress(repo));

  try {
    if (res.choice === 'ours' || res.choice === 'theirs') {
      // Map the user's LOCAL/REMOTE choice onto the correct git stage/flag for
      // the in-progress operation (rebase swaps the sides — see sideOrientation).
      const stage = res.choice === 'ours' ? orientation.localStage : orientation.remoteStage;
      const flag = res.choice === 'ours' ? orientation.localFlag : orientation.remoteFlag;

      const chosen = await readIndexStage(git, stage, res.path);
      if (chosen === undefined) {
        // The chosen side deleted this file (modify/delete conflict). That stage
        // has no content, so `git checkout <flag>` would fail with "path does
        // not have their version" and wedge the rebase. Keeping a deletion means
        // removing the file and staging the removal instead.
        await git.raw(['rm', '-f', '--', res.path]);
      } else {
        await git.raw(['checkout', flag, '--', res.path]);
        await git.raw(['add', '--', res.path]);
      }
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
