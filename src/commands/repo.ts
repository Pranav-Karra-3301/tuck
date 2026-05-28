/**
 * `tuck repo` — manage the MACHINE-LOCAL repoKey -> root bindings.
 *
 * Repo-scoped tracked files are identified in the (committed) manifest by
 * `(repoKey, repoRelative)` only — never an absolute path. To resolve such an
 * entry to a concrete file on THIS machine, tuck consults a per-machine,
 * off-repo registry (`repos.json` under the state dir) that maps each repoKey
 * to that machine's absolute repo root. This command is the user-facing way to
 * create, inspect, and remove those bindings.
 *
 *   tuck repo link <repoKey> <path>   verify <path> exists + lives inside a git
 *                                     repo, then bind <repoKey> to the repo ROOT
 *   tuck repo list                    show every binding on this machine
 *   tuck repo unlink <repoKey>        remove a binding
 *
 * link refuses to bind a key to a phantom path or to a directory that is not
 * inside a git repo — a binding must always point at a real repo root, since
 * everything resolved through it is written there.
 */

import { Command } from 'commander';
import { resolve } from 'path';
import { pathExists, expandPath, collapsePath } from '../lib/paths.js';
import {
  bindRepo,
  unbindRepo,
  findGitRoot,
  loadReposRegistry,
} from '../lib/repoScope.js';
import { logger, colors as c } from '../ui/index.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { TuckError } from '../errors.js';

const linkAction = async (
  repoKey: string,
  path: string,
  opts: { json?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck repo link');

  const abs = resolve(expandPath(path));

  // A binding must point at a real repo root. Verify the path exists, then walk
  // up to the enclosing git repo root — refuse if either check fails so we
  // never bind a key to a phantom or non-repo directory.
  if (!(await pathExists(abs))) {
    throw new TuckError(`Path does not exist: ${collapsePath(abs)}`, 'REPO_PATH_NOT_FOUND', [
      'Pass the path to an existing git repository on this machine.',
    ]);
  }

  const repoRoot = await findGitRoot(abs);
  if (!repoRoot) {
    throw new TuckError(`Not inside a git repository: ${collapsePath(abs)}`, 'REPO_NOT_A_GIT_REPO', [
      'Run this from within a git repo, or pass the path to one.',
      'Initialize a repo first with `git init`.',
    ]);
  }

  await bindRepo(repoKey, repoRoot);

  if (isJsonMode()) {
    emitJsonOk({ repoKey, root: repoRoot });
    return;
  }
  logger.success(`Linked ${c.cyan(repoKey)} → ${c.dim(repoRoot)}`);
};

const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck repo list');

  const reg = await loadReposRegistry();
  const repos = Object.entries(reg.repos).map(([repoKey, binding]) => ({
    repoKey,
    root: binding.root,
    ...(binding.remoteUrl ? { remoteUrl: binding.remoteUrl } : {}),
    boundAt: binding.boundAt,
  }));

  if (isJsonMode()) {
    emitJsonOk({ repos });
    return;
  }

  if (repos.length === 0) {
    logger.info('No repos linked on this machine.');
    logger.dim('Link one with: tuck repo link <repoKey> <path>');
    return;
  }
  console.log();
  for (const r of repos) {
    console.log(`  ${c.cyan(r.repoKey)}  ${c.dim('→')}  ${r.root}`);
  }
};

const unlinkAction = async (repoKey: string, opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck repo unlink');

  const removed = await unbindRepo(repoKey);

  if (isJsonMode()) {
    emitJsonOk({ repoKey, removed });
    return;
  }
  if (removed) {
    logger.success(`Unlinked ${c.cyan(repoKey)}`);
  } else {
    logger.info(`No binding found for ${c.cyan(repoKey)}.`);
  }
};

export const repoCommand = new Command('repo')
  .description('Manage machine-local repo bindings (repoKey → absolute root)')
  .addCommand(
    new Command('link')
      .description('Bind a repoKey to a git repository on this machine')
      .argument('<repoKey>', 'Stable, cross-machine repo identity')
      .argument('<path>', 'Path inside the target git repository')
      .option('--json', 'Emit JSON envelope')
      .action(linkAction)
  )
  .addCommand(
    new Command('list')
      .description('List all repo bindings on this machine')
      .option('--json', 'Emit JSON envelope')
      .action(listAction)
  )
  .addCommand(
    new Command('unlink')
      .description('Remove a repo binding from this machine')
      .argument('<repoKey>', 'The repoKey to unbind')
      .option('--json', 'Emit JSON envelope')
      .action(unlinkAction)
  );
