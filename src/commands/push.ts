import { Command } from 'commander';
import { prompts, logger, withSpinner, colors as c } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { checkLocalMode, showLocalModeWarningForPush } from '../lib/remoteChecks.js';
import {
  push,
  fetch,
  hasRemote,
  getRemoteUrl,
  getStatus,
  getCurrentBranch,
  addRemote,
} from '../lib/git.js';
import { NotInitializedError, GitError } from '../errors.js';
import type { PushOptions } from '../types.js';
import { logForcePush } from '../lib/audit.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { loadConfig } from '../lib/config.js';
import { assertRemoteAvailable } from '../lib/providers/index.js';

const runInteractivePush = async (tuckDir: string): Promise<void> => {
  prompts.intro('tuck push');

  // Check for local-only mode
  if (await checkLocalMode(tuckDir)) {
    await showLocalModeWarningForPush();
    prompts.outro('');
    return;
  }

  // Check if remote exists
  const hasRemoteRepo = await hasRemote(tuckDir);

  if (!hasRemoteRepo) {
    prompts.log.warning('No remote configured');

    const addRemoteNow = await prompts.confirm('Would you like to add a remote?');
    if (!addRemoteNow) {
      prompts.cancel('No remote to push to');
      return;
    }

    const remoteUrl = await prompts.text('Enter remote URL:', {
      placeholder: 'git@github.com:user/dotfiles.git',
      validate: (value) => {
        if (!value) return 'Remote URL is required';
        return undefined;
      },
    });

    await addRemote(tuckDir, 'origin', remoteUrl);
    prompts.log.success('Remote added');
  }

  // Refresh remote-tracking refs so the ahead/behind divergence check below
  // reflects the current remote, not the last fetch. Tolerate offline failures
  // with a warning — a stale comparison is better than aborting the push.
  try {
    await withSpinner('Fetching...', async () => {
      await fetch(tuckDir);
    });
  } catch {
    prompts.log.warning('Could not fetch from remote; status may be out of date');
  }

  // Get current status
  const status = await getStatus(tuckDir);
  const branch = await getCurrentBranch(tuckDir);
  const remoteUrl = await getRemoteUrl(tuckDir);

  if (status.ahead === 0 && status.tracking) {
    prompts.log.success('Already up to date with remote');
    return;
  }

  // Show what will be pushed
  console.log();
  console.log(c.dim('Remote:'), remoteUrl);
  console.log(c.dim('Branch:'), branch);

  if (status.ahead > 0) {
    console.log(c.dim('Commits:'), c.green(`↑ ${status.ahead} to push`));
  }

  if (status.behind > 0) {
    console.log(c.dim('Warning:'), c.yellow(`↓ ${status.behind} commits behind remote`));

    const pullFirst = await prompts.confirm('Pull changes first?', true);
    if (pullFirst) {
      prompts.log.info("Run 'tuck pull' first, then push");
      return;
    }
  }

  console.log();

  // Confirm
  const confirm = await prompts.confirm('Push to remote?', true);
  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  // Push
  const needsUpstream = !status.tracking;

  // Provider gate: refuse to push in local-only mode regardless of any stray
  // 'origin' remote that may be present. This is authoritative over the mere
  // existence of a git remote.
  const config = await loadConfig(tuckDir);
  assertRemoteAvailable(config.remote, 'push');

  try {
    await withSpinner('Pushing...', async () => {
      await push(tuckDir, {
        setUpstream: needsUpstream,
        branch: needsUpstream ? branch : undefined,
      });
    });
    prompts.log.success('Pushed successfully!');
  } catch (error) {
    // The lib layer (describeGitError) already classified the failure with a
    // contextual message and suggestions; re-classifying here by substring
    // misfires (e.g. "authentication ... was rejected" matched the
    // push-rejected branch). Present the lib's diagnosis verbatim.
    if (error instanceof GitError) {
      prompts.log.error(error.message);
      for (const suggestion of error.suggestions ?? []) {
        prompts.log.info(suggestion);
      }
      return;
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    prompts.log.error(`Push failed: ${errorMsg}`);
    return;
  }

  if (remoteUrl) {
    // Extract repo URL for display
    let viewUrl = remoteUrl;
    if (remoteUrl.startsWith('git@github.com:')) {
      viewUrl = remoteUrl.replace('git@github.com:', 'https://github.com/').replace('.git', '');
    }
    console.log();
    console.log(c.dim('View at:'), c.cyan(viewUrl));
  }

  prompts.outro('');
};

const runPush = async (options: PushOptions): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck push');
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
      'Cannot push in local-only mode',
      "Run 'tuck config remote' to configure a remote repository"
    );
  }

  // If no options, run interactive. JSON mode and --yes are always
  // non-interactive — they take the deterministic push path below. --yes must
  // never route here, or `tuck push --yes` would hit an interactive prompt and
  // fail on a non-TTY with an error telling the user to pass --yes.
  if (!options.force && !options.setUpstream && !options.json && !options.yes) {
    await runInteractivePush(tuckDir);
    return;
  }

  // Check if remote exists
  const hasRemoteRepo = await hasRemote(tuckDir);
  if (!hasRemoteRepo) {
    throw new GitError('No remote configured', "Run 'tuck init -r <url>' or add a remote manually");
  }

  // Provider gate: refuse to push in local-only mode even if a stray 'origin'
  // remote exists. The provider mode in config is authoritative.
  const config = await loadConfig(tuckDir);
  assertRemoteAvailable(config.remote, 'push');

  const branch = await getCurrentBranch(tuckDir);
  // Capture how far ahead of the remote we are, for the JSON envelope only.
  // getStatus can throw (e.g. no tracking branch yet); never let it break push.
  const nonInteractive = options.json === true || options.yes === true;
  let ahead: number | undefined;
  if (isJsonMode()) {
    try {
      ahead = (await getStatus(tuckDir)).ahead;
    } catch {
      ahead = undefined;
    }
  }

  // Require explicit confirmation for force push. In non-interactive mode
  // (--json / --yes) the caller has already opted in, so skip the prompt.
  if (options.force) {
    if (!nonInteractive) {
      const confirmed = await prompts.confirmDangerous(
        'Force push will overwrite remote history.\n' +
          'This can cause data loss for collaborators and is generally discouraged.',
        'force'
      );
      if (!confirmed) {
        logger.info('Push cancelled');
        return;
      }
      logger.warning('Force pushing to remote...');
    }
    // Audit log for security tracking
    await logForcePush(branch);
  }

  try {
    await withSpinner('Pushing...', async () => {
      await push(tuckDir, {
        force: options.force,
        // --set-upstream is a boolean trigger. We ALWAYS push the current
        // branch — never a ref named after the flag's value — so the upstream
        // is set for the branch the user is actually on.
        setUpstream: Boolean(options.setUpstream),
        branch,
      });
    });
    if (isJsonMode()) {
      emitJsonOk({ pushed: true, ahead, branch });
      return;
    }
    logger.success('Pushed successfully!');
  } catch (error) {
    // Lib-layer GitErrors are already contextual (describeGitError) — rethrow
    // as-is instead of re-classifying by message substring, which misfired on
    // messages like "authentication with the remote was rejected".
    if (error instanceof GitError) {
      throw error;
    }
    throw new GitError('Push failed', error instanceof Error ? error.message : String(error));
  }
};

export const pushCommand = new Command('push')
  .description('Push changes to remote repository')
  .option('-f, --force', 'Force push')
  .option('--set-upstream', 'Set upstream tracking for the current branch')
  .option('--json', 'Emit JSON envelope to stdout')
  .option('-y, --yes', 'Auto-confirm prompts (skip force-push confirmation)')
  .action(async (options: PushOptions) => {
    await runPush(options);
  });
