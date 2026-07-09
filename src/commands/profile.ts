/**
 * `tuck profile` — profiles / tags at the *set* level (IDEAS 5.4).
 *
 * A PROFILE (work, personal, server, agent, …) names a subset of tracked files.
 * Every tracked file carries `tags`; a file with no tags is UNIVERSAL and
 * applies under every profile. `tuck apply --profile work` materializes the
 * universal files plus the work-tagged files, and nothing else.
 *
 * Two kinds of state:
 *   - the PROFILE REGISTRY + per-file tags live in the shared, committed
 *     manifest (portable across machines);
 *   - the machine BINDING lives off-repo in the state dir and is never
 *     committed, so each machine chooses its own default profile.
 *
 * Subcommands:
 *   list                       list profiles, file counts, and the bound profile
 *   create <name>              register a new (empty) profile
 *   rm <name>                  remove a profile (strips its tag from files)
 *   tag <profile> <path…>      tag tracked file(s) with a profile
 *   untag <profile> <path…>    remove a profile tag from tracked file(s)
 *   bind <name>                bind THIS machine to a profile (machine-local)
 *   unbind                     clear this machine's profile binding
 *   show                       show the bound profile and any cross-profile leaks
 *   devcontainer [dir]         scaffold devcontainer.json + Codespaces bootstrap
 */

import { Command } from 'commander';
import { join, dirname } from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { ensureDir, pathExists as fsPathExists } from 'fs-extra';
import { logger, colors as c, prompts } from '../ui/index.js';
import { getTuckDir, expandPath, collapsePath } from '../lib/paths.js';
import { atomicWriteFile } from '../lib/files.js';
import { loadManifest } from '../lib/manifest.js';
import {
  ensureProfile,
  removeProfile,
  tagFile,
  untagFile,
  listProfileCounts,
  countUniversalFiles,
  bindProfile,
  unbindProfile,
  getBoundProfile,
  detectProfileLeaks,
  isValidProfileName,
} from '../lib/profiles.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { NotInitializedError, TuckError } from '../errors.js';

const ensureInitialized = async (): Promise<string> => {
  const tuckDir = getTuckDir();
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
  return tuckDir;
};

const assertName = (name: string): void => {
  if (!name || !isValidProfileName(name)) {
    throw new TuckError(`Invalid profile name: ${name}`, 'PROFILE_NAME_INVALID', [
      'Profile names may only contain letters, digits, dot, dash, and underscore.',
    ]);
  }
};

/**
 * Resolve a `<path-or-id>` to a manifest id: prefer an exact id match, else a
 * file whose `source` equals the argument (raw or expanded). Mirrors the
 * resolution `tuck bundle assign` uses.
 */
const resolveFileId = async (tuckDir: string, target: string): Promise<string> => {
  const manifest = await loadManifest(tuckDir);
  if (manifest.files[target]) return target;

  const expanded = collapsePath(expandPath(target));
  for (const [id, file] of Object.entries(manifest.files)) {
    if (file.source === target || file.source === expanded) return id;
  }

  throw new TuckError(`No tracked file matches: ${target}`, 'FILE_NOT_TRACKED', [
    'Pass either a manifest id or the original source path (e.g. ~/.zshrc).',
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────────────────────

const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile list');
  const tuckDir = await ensureInitialized();

  const profiles = await listProfileCounts(tuckDir);
  const universal = await countUniversalFiles(tuckDir);
  const bound = await getBoundProfile();

  if (isJsonMode()) {
    emitJsonOk({ bound, universal, count: profiles.length, profiles });
    return;
  }

  console.log();
  console.log(c.bold('Profiles:'));
  if (profiles.length === 0) {
    console.log(c.dim('  (none defined — every file is universal)'));
  } else {
    for (const p of profiles) {
      const boundMark = p.name === bound ? c.green(' ● bound') : '';
      const desc = p.description ? c.dim(` — ${p.description}`) : '';
      console.log(
        `  ${c.cyan(p.name.padEnd(18))} ${c.dim(
          `${p.fileCount} file${p.fileCount === 1 ? '' : 's'}`
        )}${boundMark}${desc}`
      );
    }
  }
  console.log(c.dim(`  ${universal} universal file${universal === 1 ? '' : 's'} (apply under every profile)`));
  console.log();
};

// ─────────────────────────────────────────────────────────────────────────────
// create / rm
// ─────────────────────────────────────────────────────────────────────────────

const createAction = async (
  name: string,
  opts: { json?: boolean; description?: string }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile create');
  const tuckDir = await ensureInitialized();
  assertName(name);

  const manifest = await loadManifest(tuckDir);
  const existed = !!manifest.profiles[name];
  await ensureProfile(tuckDir, name, opts.description);

  if (isJsonMode()) {
    emitJsonOk({ profile: name, created: !existed });
    return;
  }
  if (existed) logger.info(`Profile already exists: ${name}`);
  else logger.success(`Created profile: ${name}`);
};

const removeAction = async (
  name: string,
  opts: { json?: boolean; force?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile rm');
  const tuckDir = await ensureInitialized();

  const manifest = await loadManifest(tuckDir);
  if (!manifest.profiles[name]) {
    throw new TuckError(`Profile not found: ${name}`, 'PROFILE_NOT_FOUND');
  }

  const memberCount = Object.values(manifest.files).filter((f) =>
    (f.tags ?? []).includes(name)
  ).length;

  if (memberCount > 0 && !opts.force && !isJsonMode()) {
    const confirmed = await prompts.confirm(
      `Profile "${name}" tags ${memberCount} file${memberCount === 1 ? '' : 's'}. Remove the profile and strip the tag from ${memberCount === 1 ? 'it' : 'them'}?`,
      false
    );
    if (!confirmed) {
      logger.info('Aborted.');
      return;
    }
  } else if (memberCount > 0 && !opts.force && isJsonMode()) {
    throw new TuckError(
      `Profile "${name}" still tags ${memberCount} file${memberCount === 1 ? '' : 's'}.`,
      'PROFILE_NOT_EMPTY',
      ['Pass --force to remove and strip the tag from those files.']
    );
  }

  const { untagged } = await removeProfile(tuckDir, name);

  if (isJsonMode()) {
    emitJsonOk({ removed: name, untagged });
    return;
  }
  logger.success(
    `Removed profile "${name}"${untagged > 0 ? ` and untagged ${untagged} file${untagged === 1 ? '' : 's'}` : ''}.`
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// tag / untag
// ─────────────────────────────────────────────────────────────────────────────

const tagAction = async (
  profile: string,
  targets: string[],
  opts: { json?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile tag');
  const tuckDir = await ensureInitialized();
  assertName(profile);

  const changed: string[] = [];
  for (const target of targets) {
    const id = await resolveFileId(tuckDir, target);
    const { added } = await tagFile(tuckDir, id, profile);
    if (added) changed.push(id);
  }

  if (isJsonMode()) {
    emitJsonOk({ profile, tagged: changed, count: changed.length });
    return;
  }
  if (changed.length === 0) logger.info(`No changes — file(s) already tagged "${profile}".`);
  else logger.success(`Tagged ${changed.length} file(s) with "${profile}".`);
};

const untagAction = async (
  profile: string,
  targets: string[],
  opts: { json?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile untag');
  const tuckDir = await ensureInitialized();

  const changed: string[] = [];
  for (const target of targets) {
    const id = await resolveFileId(tuckDir, target);
    const { removed } = await untagFile(tuckDir, id, profile);
    if (removed) changed.push(id);
  }

  if (isJsonMode()) {
    emitJsonOk({ profile, untagged: changed, count: changed.length });
    return;
  }
  if (changed.length === 0) logger.info(`No changes — file(s) were not tagged "${profile}".`);
  else logger.success(`Removed "${profile}" tag from ${changed.length} file(s).`);
};

// ─────────────────────────────────────────────────────────────────────────────
// bind / unbind / show
// ─────────────────────────────────────────────────────────────────────────────

const bindAction = async (
  name: string,
  opts: { json?: boolean; force?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile bind');
  assertName(name);

  // Binding is machine-local and independent of a tuck repo — a fresh machine
  // can bind BEFORE its first apply (the ephemeral-env story). When a manifest
  // exists we still guard against binding to an unknown profile unless --force.
  let known = false;
  let hasManifest = true;
  try {
    const manifest = await loadManifest(getTuckDir());
    known = !!manifest.profiles[name];
  } catch {
    hasManifest = false;
  }

  if (hasManifest && !known && !opts.force) {
    throw new TuckError(`Profile not found: ${name}`, 'PROFILE_NOT_FOUND', [
      `Run \`tuck profile create ${name}\` first, or pass --force to bind anyway.`,
    ]);
  }

  await bindProfile(name);

  if (isJsonMode()) {
    emitJsonOk({ bound: name });
    return;
  }
  logger.success(`This machine is now bound to profile "${name}".`);
  logger.info('`tuck apply <source>` will apply this profile by default.');
};

const unbindAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile unbind');
  // Machine-local — independent of a tuck repo.

  const previous = await getBoundProfile();
  const removed = await unbindProfile();

  if (isJsonMode()) {
    emitJsonOk({ unbound: removed, previous: previous ?? undefined });
    return;
  }
  if (removed) logger.success(`Cleared profile binding (was "${previous}").`);
  else logger.info('No profile was bound on this machine.');
};

const showAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile show');

  const bound = await getBoundProfile();
  // Leak detection needs the manifest; tolerate a not-yet-initialized machine
  // (binding can precede the first apply) by reporting no leaks in that case.
  let leaks: Awaited<ReturnType<typeof detectProfileLeaks>> = [];
  if (bound) {
    try {
      leaks = await detectProfileLeaks(getTuckDir(), bound);
    } catch {
      leaks = [];
    }
  }

  if (isJsonMode()) {
    emitJsonOk({
      bound,
      leaks: leaks.map((l) => ({ id: l.id, source: l.source, tags: l.tags, livePath: l.livePath })),
      leakCount: leaks.length,
    });
    return;
  }

  console.log();
  if (bound) {
    console.log(`${c.muted('Bound profile:')} ${c.brand(bound)}`);
  } else {
    console.log(`${c.muted('Bound profile:')} ${c.warning('none')}`);
    console.log(c.dim("  Run 'tuck profile bind <name>' to bind this machine."));
  }

  if (bound && leaks.length > 0) {
    console.log();
    console.log(c.warning(`${leaks.length} cross-profile leak${leaks.length === 1 ? '' : 's'} on disk:`));
    for (const leak of leaks) {
      console.log(
        `  ${c.warning('⚠')} ${collapsePath(leak.livePath)} ${c.dim(`(profile: ${leak.tags.join(', ')})`)}`
      );
    }
    console.log(
      c.dim('  These files belong to other profiles but are present on this machine.')
    );
  } else if (bound) {
    console.log(c.dim('  No cross-profile leaks detected.'));
  }
  console.log();
};

// ─────────────────────────────────────────────────────────────────────────────
// devcontainer scaffold (IDEAS 2.5)
// ─────────────────────────────────────────────────────────────────────────────

const resolveTemplatesDir = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../templates/devcontainer'),
    join(here, '../templates/devcontainer'),
    join(here, '../../../templates/devcontainer'),
  ];
  for (const dir of candidates) {
    if (await fsPathExists(join(dir, 'devcontainer.json'))) return dir;
  }
  throw new TuckError(
    'Bundled devcontainer template not found in the tuck installation.',
    'TEMPLATE_NOT_FOUND'
  );
};

const devcontainerAction = async (
  dir: string | undefined,
  opts: { json?: boolean; force?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck profile devcontainer');
  // No manifest required — this scaffolds files for a fresh/ephemeral repo.

  const outDir = expandPath(dir ?? '.');
  const templatesDir = await resolveTemplatesDir();

  // Files written: .devcontainer/devcontainer.json and a Codespaces dotfiles
  // install.sh entrypoint at the destination root.
  const writes: Array<{ from: string; to: string }> = [
    { from: 'devcontainer.json', to: join(outDir, '.devcontainer', 'devcontainer.json') },
    { from: 'install.sh', to: join(outDir, 'install.sh') },
  ];

  const written: string[] = [];
  const skipped: string[] = [];

  for (const { from, to } of writes) {
    if ((await fsPathExists(to)) && !opts.force) {
      if (isJsonMode()) {
        skipped.push(to);
        continue;
      }
      const confirmed = await prompts.confirm(`${collapsePath(to)} exists. Overwrite?`, false);
      if (!confirmed) {
        skipped.push(to);
        continue;
      }
    }
    const content = await readFile(join(templatesDir, from), 'utf-8');
    await ensureDir(dirname(to));
    // install.sh must be executable for Codespaces to run it as the dotfiles
    // entrypoint; devcontainer.json is a plain config file.
    const mode = from.endsWith('.sh') ? 0o755 : undefined;
    await atomicWriteFile(to, content, mode !== undefined ? { mode } : undefined);
    written.push(to);
  }

  if (isJsonMode()) {
    emitJsonOk({ written, skipped });
    return;
  }

  if (written.length > 0) {
    logger.success(`Scaffolded ${written.length} file(s):`);
    for (const p of written) logger.file('add', collapsePath(p));
    console.log();
    prompts.note(
      "Tag the agent configs with `tuck profile tag agent <path>`, then the container\nruns `tuck apply <repo> --profile agent --yes` on create.",
      'Next'
    );
  } else {
    logger.info('Nothing written (all files existed; pass --force to overwrite).');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Command wiring
// ─────────────────────────────────────────────────────────────────────────────

export const profileCommand = new Command('profile')
  .description('Manage profiles — work/personal/server/agent subsets of tracked files')
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('List profiles, file counts, and the bound profile')
      .option('--json', 'Emit JSON envelope')
      .action(listAction)
  )
  .addCommand(
    new Command('create')
      .description('Register a new empty profile')
      .argument('<name>', 'Profile name')
      .option('-d, --description <text>', 'Human-readable description')
      .option('--json', 'Emit JSON envelope')
      .action(createAction)
  )
  .addCommand(
    new Command('rm')
      .description('Remove a profile (its tag is stripped from all files)')
      .argument('<name>', 'Profile name')
      .option('-f, --force', 'Remove without confirmation even if files carry the tag')
      .option('--json', 'Emit JSON envelope')
      .action(removeAction)
  )
  .addCommand(
    new Command('tag')
      .description('Tag tracked file(s) with a profile')
      .argument('<profile>', 'Profile name')
      .argument('<path-or-id...>', 'Manifest id(s) or source path(s) of tracked file(s)')
      .option('--json', 'Emit JSON envelope')
      .action(tagAction)
  )
  .addCommand(
    new Command('untag')
      .description('Remove a profile tag from tracked file(s)')
      .argument('<profile>', 'Profile name')
      .argument('<path-or-id...>', 'Manifest id(s) or source path(s) of tracked file(s)')
      .option('--json', 'Emit JSON envelope')
      .action(untagAction)
  )
  .addCommand(
    new Command('bind')
      .description('Bind THIS machine to a profile (machine-local, never committed)')
      .argument('<name>', 'Profile name')
      .option('-f, --force', 'Bind even if the profile is not yet in the registry')
      .option('--json', 'Emit JSON envelope')
      .action(bindAction)
  )
  .addCommand(
    new Command('unbind')
      .description("Clear this machine's profile binding")
      .option('--json', 'Emit JSON envelope')
      .action(unbindAction)
  )
  .addCommand(
    new Command('show')
      .description('Show the bound profile and any cross-profile leaks on disk')
      .option('--json', 'Emit JSON envelope')
      .action(showAction)
  )
  .addCommand(
    new Command('devcontainer')
      .description('Scaffold devcontainer.json + Codespaces dotfiles bootstrap for `--profile agent`')
      .argument('[dir]', 'Target directory (defaults to current directory)')
      .option('-f, --force', 'Overwrite existing files without confirmation')
      .option('--json', 'Emit JSON envelope')
      .action(devcontainerAction)
  );
