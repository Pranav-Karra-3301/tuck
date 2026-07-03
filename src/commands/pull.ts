import { Command } from 'commander';
import { prompts, logger, withSpinner, colors as c } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { checkLocalMode, showLocalModeWarningForPull } from '../lib/remoteChecks.js';
import {
  pull,
  fetch,
  hasRemote,
  getRemoteUrl,
  getStatus,
  getCurrentBranch,
  countCommitsBehindRemote,
} from '../lib/git.js';
import { detectConflicts, abortRebase } from '../lib/mergeConflicts.js';
import { runRestore } from './restore.js';
import { NotInitializedError, GitError, MergeConflictsError } from '../errors.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import type { PullOptions } from '../types.js';

/**
 * Pull, but never leave the tuck repo in a half-merged state. On a plain
 * `git pull` conflict, git stops with `<<<<<<<` markers in the work tree and
 * MERGE_HEAD set; a later `tuck sync` would then `git add --all` and commit the
 * marker-corrupted files into history. So if the pull fails with conflicts we
 * abort the merge/rebase (restoring the pre-pull state) and raise a
 * MergeConflictsError that points the user at the interactive resolver.
 */
const pullOrAbortOnConflict = async (
  tuckDir: string,
  options: { rebase?: boolean; branch?: string }
): Promise<void> => {
  try {
    await pull(tuckDir, options);
  } catch (error) {
    const conflicts = await detectConflicts(tuckDir).catch(() => []);
    if (conflicts.length > 0) {
      // Back out so ~/.tuck is clean; the user can resolve via `tuck sync`.
      await abortRebase(tuckDir).catch(() => undefined);
      throw new MergeConflictsError(conflicts.map((conflict) => conflict.path));
    }
    throw error;
  }
};

const runInteractivePull = async (tuckDir: string): Promise<void> => {
  prompts.intro('tuck pull');

  // Check for local-only mode
  if (await checkLocalMode(tuckDir)) {
    await showLocalModeWarningForPull();
    prompts.outro('');
    return;
  }

  // Check if remote exists
  const hasRemoteRepo = await hasRemote(tuckDir);
  if (!hasRemoteRepo) {
    prompts.log.error('No remote configured');
    prompts.note("Run 'tuck init -r <url>' or add a remote manually", 'Tip');
    return;
  }

  // Fetch first to get latest remote status
  await withSpinner('Fetching...', async () => {
    await fetch(tuckDir);
  });

  // Get current status
  const status = await getStatus(tuckDir);
  const branch = await getCurrentBranch(tuckDir);
  const remoteUrl = await getRemoteUrl(tuckDir);

  // Show status
  console.log();
  console.log(c.dim('Remote:'), remoteUrl);
  console.log(c.dim('Branch:'), branch);

  // status.behind is derived from the upstream tracking ref and is 0 whenever
  // the branch has no upstream — even if the remote has commits. When tracking
  // is absent, compare against the freshly fetched remote branch directly so we
  // don't report a false "Already up to date".
  let behind = status.behind;
  if (!status.tracking) {
    behind = (await countCommitsBehindRemote(tuckDir, branch)) ?? 0;
  }

  if (behind === 0) {
    prompts.log.success('Already up to date');
    return;
  }

  console.log(c.dim('Commits:'), c.yellow(`↓ ${behind} to pull`));

  if (status.ahead > 0) {
    console.log(
      c.dim('Note:'),
      c.yellow(`You also have ${status.ahead} local commit${status.ahead > 1 ? 's' : ''} to push`)
    );
  }

  // Check for local changes
  if (status.modified.length > 0 || status.staged.length > 0) {
    console.log();
    prompts.log.warning('You have uncommitted changes');
    console.log(c.dim('Modified:'), status.modified.join(', '));

    const continueAnyway = await prompts.confirm('Pull anyway? (may cause merge conflicts)');
    if (!continueAnyway) {
      prompts.cancel("Commit or stash your changes first with 'tuck sync'");
      return;
    }
  }

  console.log();

  // Ask about rebase
  const useRebase = await prompts.confirm('Use rebase instead of merge?');

  // Pull. Pass the branch explicitly when there's no upstream so `git pull`
  // knows what to merge instead of erroring with "no branch specified".
  await withSpinner('Pulling...', async () => {
    await pullOrAbortOnConflict(tuckDir, {
      rebase: useRebase,
      branch: status.tracking ? undefined : branch,
    });
  });

  prompts.log.success('Pulled successfully!');

  // Ask about restore
  const shouldRestore = await prompts.confirm('Restore updated dotfiles to system?', true);
  if (shouldRestore) {
    await runRestore({ all: true });
  }

  prompts.outro('');
};

const runPull = async (options: PullOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck pull');
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  // Check for local-only mode
  if (await checkLocalMode(tuckDir)) {
    throw new GitError(
      'Cannot pull in local-only mode',
      "Run 'tuck config remote' to configure a remote repository"
    );
  }

  // If no options, run interactive. JSON mode and --yes are always
  // non-interactive: they take the deterministic path below with the default
  // merge strategy. Without --yes, a plain `tuck pull` on a non-TTY would hit
  // the rebase prompt and fail exactly when there are commits to pull.
  if (!options.rebase && !options.restore && !options.yes && !isJsonMode()) {
    await runInteractivePull(tuckDir);
    return;
  }

  // Check if remote exists
  const hasRemoteRepo = await hasRemote(tuckDir);
  if (!hasRemoteRepo) {
    throw new GitError('No remote configured', "Run 'tuck init -r <url>' or add a remote manually");
  }

  // Fetch first
  await withSpinner('Fetching...', async () => {
    await fetch(tuckDir);
  });

  // Pull
  await withSpinner('Pulling...', async () => {
    await pullOrAbortOnConflict(tuckDir, { rebase: options.rebase });
  });

  // JSON path: pull (and optional restore) are complete; emit one envelope and
  // skip all human output. Spinners auto-suppress in JSON mode.
  if (isJsonMode()) {
    let restored = false;
    if (options.restore) {
      await runRestore({ all: true });
      restored = true;
    }
    emitJsonOk(restored ? { pulled: true, restored: 1 } : { pulled: true });
    return;
  }

  logger.success('Pulled successfully!');

  if (options.restore) {
    await runRestore({ all: true });
  }
};

export const pullCommand = new Command('pull')
  .description('Pull changes from remote')
  .option('--rebase', 'Pull with rebase')
  .option('--restore', 'Also restore files to system after pull')
  .option('--json', 'Emit JSON envelope to stdout')
  .option('-y, --yes', 'Auto-confirm prompts (non-interactive merge pull)')
  .action(async (options: PullOptions) => {
    await runPull(options);
  });
