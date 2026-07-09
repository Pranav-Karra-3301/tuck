/**
 * `tuck preset` — apply curated bundles of tracked files / agent configs.
 *
 * Preset format (YAML or JSON):
 *
 *   name: claude-code
 *   version: 1.0.0
 *   description: Claude Code optimized terminal setup
 *   provides:
 *     - category: agents
 *       files:
 *         - source: templates/CLAUDE.md
 *           target: ~/.claude/CLAUDE.md
 *           template: true
 *   requires:
 *     - tool: claude
 *       install: "npm i -g @anthropic-ai/claude-code"
 *   hooks:
 *     postApply:
 *       - "claude config get >/dev/null || true"
 *
 * Implemented: list, show, apply, publish. The bundled registry lives at
 * `templates/presets/`. Remote registry is out of scope for v1 — `apply` only
 * accepts a local path or a path inside the bundled registry.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, readdir, stat, symlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, isAbsolute, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { expandPath, collapsePath, pathExists, validateSafeDestinationPath } from '../lib/paths.js';
import { resolveWriteTarget, allowedRoots } from '../lib/writeContext.js';
import { copyFileOrDir, setFilePermissions } from '../lib/files.js';
import { logger, prompts, colors as c } from '../ui/index.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { TuckError } from '../errors.js';
import { renderTemplate } from '../lib/template.js';
import { createPreApplySnapshot } from '../lib/timemachine.js';
import {
  listInstructionTargets,
  getInstructionTarget,
  DEFAULT_TRANSLATION_AGENTS,
} from '../lib/agentPresets.js';

interface PresetFile {
  source: string;
  target: string;
  template?: boolean;
  permissions?: string;
}

interface PresetProvides {
  category: string;
  files: PresetFile[];
}

interface PresetRequires {
  tool: string;
  install?: string;
}

interface PresetHooks {
  postApply?: string[];
}

interface Preset {
  name: string;
  version: string;
  description: string;
  provides: PresetProvides[];
  requires?: PresetRequires[];
  hooks?: PresetHooks;
}

export const bundledRegistryDir = (): string => {
  // Resolve to <pkg>/templates/presets. The package layout differs between dev
  // (src/commands → ../../templates) and the published, tsup-bundled build
  // (dist → ../templates), so probe each candidate and return the first that
  // actually exists. Blindly returning candidates[0] made the bundled registry
  // unreachable in every npm install (it resolved outside the package).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../templates/presets'),
    resolve(here, '../templates/presets'),
    resolve(here, '../../../templates/presets'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
};

const loadPresetFile = async (path: string): Promise<Preset> => {
  const text = await readFile(path, 'utf-8');
  if (path.endsWith('.json')) {
    return JSON.parse(text) as Preset;
  }
  // Lightweight YAML parser would be ideal, but to avoid a runtime dep we
  // require presets to ship as JSON. YAML is supported only via conversion at
  // publish time (preset publish converts YAML→JSON). See open question in
  // implementation-notes.html.
  throw new TuckError(`Unsupported preset format: ${path}`, 'PRESET_FORMAT', [
    'Presets must be JSON in v1. Convert YAML to JSON with a tool of your choice.',
  ]);
};

const resolvePreset = async (nameOrPath: string): Promise<{ path: string; preset: Preset }> => {
  // 1. Treat as direct path
  if (await pathExists(nameOrPath)) {
    if ((await stat(nameOrPath)).isDirectory()) {
      const manifest = join(nameOrPath, 'preset.json');
      return { path: manifest, preset: await loadPresetFile(manifest) };
    }
    return { path: nameOrPath, preset: await loadPresetFile(nameOrPath) };
  }
  // 2. Treat as name in bundled registry
  const reg = bundledRegistryDir();
  const dir = join(reg, nameOrPath);
  const manifest = join(dir, 'preset.json');
  if (await pathExists(manifest)) {
    return { path: manifest, preset: await loadPresetFile(manifest) };
  }
  throw new TuckError(`Preset not found: ${nameOrPath}`, 'PRESET_NOT_FOUND', [
    'Run `tuck preset list` to see available presets',
    'Or pass a path to a preset.json',
  ]);
};

const renderIfTemplate = async (
  src: string,
  isTemplate: boolean | undefined,
  vars: Record<string, string>
): Promise<string | Buffer> => {
  const buf = await readFile(src);
  if (!isTemplate) return buf;
  return renderTemplate(buf.toString('utf-8'), vars);
};

/**
 * Reject any preset write target that escapes the user's home directory.
 * A preset.json is untrusted input; without this guard a `target` like
 * `/etc/cron.d/x` or `~/../../root/.bashrc` would let `apply` write anywhere
 * the process can write. Validates ALL targets up front so nothing is written
 * (or even `mkdir`'d) when a single entry is unsafe.
 */
export const assertPresetTargetsSafe = (entries: Array<{ target: string }>): void => {
  for (const e of entries) {
    validateSafeDestinationPath(e.target, allowedRoots());
  }
};

/**
 * Decide how to handle a preset that would overwrite existing files.
 *   - `proceed`: nothing to clobber, or the user passed `--yes`.
 *   - `refuse` : files exist, no `--yes`, and we're non-interactive (JSON/agent
 *                /piped) — never silently overwrite.
 *   - `confirm`: interactive — ask the user.
 */
export const decidePresetOverwrite = (
  existingCount: number,
  opts: { yes?: boolean; nonInteractive: boolean }
): 'proceed' | 'confirm' | 'refuse' => {
  if (existingCount === 0) return 'proceed';
  if (opts.yes) return 'proceed';
  return opts.nonInteractive ? 'refuse' : 'confirm';
};

const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck preset list');
  const reg = bundledRegistryDir();
  const presets: Preset[] = [];
  if (await pathExists(reg)) {
    const dirs = await readdir(reg);
    for (const d of dirs) {
      const mf = join(reg, d, 'preset.json');
      if (await pathExists(mf)) {
        try {
          presets.push(await loadPresetFile(mf));
        } catch {
          /* skip broken */
        }
      }
    }
  }
  if (isJsonMode()) {
    emitJsonOk({ count: presets.length, presets });
    return;
  }
  if (presets.length === 0) {
    logger.info('No bundled presets installed.');
    return;
  }
  console.log();
  for (const p of presets) {
    console.log(`  ${c.cyan(p.name.padEnd(22))} ${c.dim(`v${p.version}`)}  ${p.description}`);
  }
};

const showAction = async (name: string, opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck preset show');
  const { preset } = await resolvePreset(name);
  if (isJsonMode()) {
    emitJsonOk({ preset });
    return;
  }
  console.log();
  console.log(c.bold(preset.name) + c.dim(`  v${preset.version}`));
  console.log(preset.description);
  console.log();
  for (const prov of preset.provides) {
    console.log(c.bold(`[${prov.category}]`));
    for (const f of prov.files) {
      console.log(`  ${f.source} → ${f.target}${f.template ? c.dim(' (template)') : ''}`);
    }
  }
  if (preset.requires?.length) {
    console.log();
    console.log(c.bold('Requires:'));
    for (const r of preset.requires) {
      console.log(`  ${r.tool}${r.install ? c.dim(` — ${r.install}`) : ''}`);
    }
  }
};

export const applyAction = async (
  name: string,
  opts: { json?: boolean; yes?: boolean; plan?: boolean; dryRun?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck preset apply');
  const { path, preset } = await resolvePreset(name);
  const presetDir = dirname(path);

  const vars: Record<string, string> = {
    os: process.platform === 'darwin' ? 'darwin' : process.platform,
    arch: process.arch,
    home: homedir(),
    user: process.env.USER || process.env.USERNAME || 'user',
    hostname: process.env.HOSTNAME || '',
  };

  const planEntries: Array<{
    source: string;
    target: string;
    template: boolean;
    permissions?: string;
  }> = [];
  for (const prov of preset.provides) {
    for (const f of prov.files) {
      planEntries.push({
        source: isAbsolute(f.source) ? f.source : join(presetDir, f.source),
        // Confine + redirect under --root (no-op when not sandboxed); also
        // validates the target stays inside the allowed root.
        target: resolveWriteTarget(f.target),
        template: !!f.template,
        ...(f.permissions ? { permissions: f.permissions } : {}),
      });
    }
  }

  if (opts.plan || opts.dryRun) {
    if (isJsonMode()) {
      emitJsonOk({ preset: preset.name, plan: planEntries });
      return;
    }
    console.log(c.bold(`Plan for ${preset.name}:`));
    for (const e of planEntries) console.log(`  ${e.source} → ${e.target}`);
    return;
  }

  // Safety gate 1: refuse to write anywhere outside $HOME, BEFORE any mkdir/write.
  assertPresetTargetsSafe(planEntries);

  // Safety gate 2: never silently clobber existing files. Snapshot + consent.
  const existing: string[] = [];
  for (const e of planEntries) {
    if (await pathExists(e.target)) existing.push(e.target);
  }
  const nonInteractive = isJsonMode() || !process.stdout.isTTY;
  const decision = decidePresetOverwrite(existing.length, { yes: opts.yes, nonInteractive });

  if (decision === 'refuse') {
    throw new TuckError(
      `Applying "${preset.name}" would overwrite ${existing.length} existing file(s). Re-run with --yes to confirm.`,
      'PRESET_OVERWRITE_REFUSED',
      ['Pass --yes to overwrite (a snapshot is taken first so you can `tuck undo`).']
    );
  }
  if (decision === 'confirm') {
    logger.warning(`This will overwrite ${existing.length} existing file(s):`);
    for (const t of existing) logger.dim(`  ${collapsePath(t)}`);
    const confirmed = await prompts.confirm(
      `Apply preset "${preset.name}" and overwrite these files?`,
      false
    );
    if (!confirmed) {
      logger.info('Aborted — no files changed.');
      return;
    }
  }

  // Snapshot existing targets so `tuck undo` can roll the apply back.
  if (existing.length > 0) {
    await createPreApplySnapshot(existing, `preset:${preset.name}`);
  }

  for (const e of planEntries) {
    if (!(await pathExists(e.source))) {
      throw new TuckError(`Preset source missing: ${e.source}`, 'PRESET_SOURCE_MISSING');
    }
    await mkdir(dirname(e.target), { recursive: true });
    if (e.template) {
      const rendered = await renderIfTemplate(e.source, true, vars);
      await writeFile(e.target, rendered as string, 'utf-8');
    } else {
      await copyFileOrDir(e.source, e.target, { overwrite: true });
    }
    // Honor the preset author's declared permission hardening (e.g. "600" for
    // an SSH/credential file). No-ops on Windows. Skipped for directories —
    // permissions on preset entries only make sense for individual files.
    if (e.permissions && !e.template && (await stat(e.source)).isDirectory()) {
      // Directory sources: leave mode as copied; a declared bitmask on a dir is
      // ambiguous and setFilePermissions targets a single path.
    } else if (e.permissions) {
      await setFilePermissions(e.target, e.permissions);
    }
  }

  if (isJsonMode()) {
    emitJsonOk({ applied: preset.name, files: planEntries.length });
    return;
  }
  logger.success(`Applied preset: ${preset.name} (${planEntries.length} files)`);
};

const publishAction = async (
  dir: string,
  opts: { json?: boolean; out?: string }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck preset publish');
  const manifest = join(dir, 'preset.json');
  if (!(await pathExists(manifest))) {
    throw new TuckError(`No preset.json in ${dir}`, 'PRESET_FORMAT');
  }
  // Validate
  await loadPresetFile(manifest);
  const out = opts.out ?? `${join(dir, 'preset')}.tar.gz`;
  // We don't bundle tar in the dependency tree; just emit the path the user
  // would tar themselves. This keeps the dep footprint small while still
  // giving a stable schema everyone can package against.
  if (isJsonMode()) {
    emitJsonOk({ manifest, suggestedArchive: out });
    return;
  }
  logger.info(`Preset valid. Suggested archive path: ${out}`);
  logger.dim(`Pack with: tar -czf ${out} -C ${dir} .`);
};

/**
 * Resolve the canonical instructions file for `preset translate`. An explicit
 * source wins; otherwise fall back to the first existing known instruction
 * file (Claude Code's CLAUDE.md, then Codex's AGENTS.md, then Gemini's).
 */
const resolveTranslationSource = async (source?: string): Promise<string> => {
  if (source) {
    const abs = expandPath(source);
    if (!(await pathExists(abs))) {
      throw new TuckError(`Source not found: ${collapsePath(abs)}`, 'PRESET_SOURCE_MISSING', [
        'Pass a readable canonical instructions file.',
      ]);
    }
    if ((await stat(abs)).isDirectory()) {
      throw new TuckError(
        `Source must be a file, not a directory: ${collapsePath(abs)}`,
        'VALIDATION_ERROR'
      );
    }
    return abs;
  }
  for (const t of listInstructionTargets()) {
    const abs = expandPath(t.path);
    if (await pathExists(abs)) return abs;
  }
  throw new TuckError('No canonical instructions file found', 'PRESET_SOURCE_MISSING', [
    'Pass a source path, e.g. tuck preset translate ~/.claude/CLAUDE.md',
  ]);
};

interface TranslateEntry {
  agent: string;
  label: string;
  target: string;
}

/**
 * Cross-agent instructions translation (IDEAS 1.8 v1). Materialize one
 * canonical instructions file into each target agent's global instruction path
 * (default: Claude Code's CLAUDE.md and Codex's AGENTS.md). Copies by default;
 * `--link` symlinks each target at the source instead. Reuses the same safety
 * machinery as `preset apply`: home-confined targets, snapshot-before-overwrite,
 * and a non-interactive overwrite refusal.
 */
export const translateAction = async (
  source: string | undefined,
  opts: {
    json?: boolean;
    yes?: boolean;
    plan?: boolean;
    dryRun?: boolean;
    to?: string;
    link?: boolean;
  }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck preset translate');

  const sourcePath = await resolveTranslationSource(source);

  const agentIds = (opts.to ?? DEFAULT_TRANSLATION_AGENTS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const entries: TranslateEntry[] = [];
  for (const agent of agentIds) {
    const target = getInstructionTarget(agent);
    if (!target) {
      throw new TuckError(`Unknown translation target: ${agent}`, 'UNKNOWN_TRANSLATION_TARGET', [
        `Valid targets: ${listInstructionTargets()
          .map((t) => t.agent)
          .join(', ')}`,
      ]);
    }
    // Confine + redirect under --root (no-op when not sandboxed).
    const resolved = resolveWriteTarget(target.path);
    // Never translate a file onto itself (source may already be one target).
    if (resolve(resolved) === resolve(sourcePath)) continue;
    entries.push({ agent: target.agent, label: target.label, target: resolved });
  }

  if (entries.length === 0) {
    if (isJsonMode()) {
      emitJsonOk({ source: collapsePath(sourcePath), translated: 0, targets: [] });
      return;
    }
    logger.info('Nothing to translate — the source is the only requested target.');
    return;
  }

  if (opts.plan || opts.dryRun) {
    if (isJsonMode()) {
      emitJsonOk({
        source: collapsePath(sourcePath),
        mode: opts.link ? 'symlink' : 'copy',
        plan: entries.map((e) => ({ agent: e.agent, target: e.target })),
      });
      return;
    }
    console.log(
      c.bold(`Translate ${collapsePath(sourcePath)} → (${opts.link ? 'symlink' : 'copy'}):`)
    );
    for (const e of entries) console.log(`  ${e.label}: ${collapsePath(e.target)}`);
    return;
  }

  // Safety gate 1: refuse to write anywhere outside $HOME before any mkdir/write.
  assertPresetTargetsSafe(entries);

  // Safety gate 2: never silently clobber. Snapshot + consent.
  const existing: string[] = [];
  for (const e of entries) {
    if (await pathExists(e.target)) existing.push(e.target);
  }
  const nonInteractive = isJsonMode() || !process.stdout.isTTY;
  const decision = decidePresetOverwrite(existing.length, { yes: opts.yes, nonInteractive });

  if (decision === 'refuse') {
    throw new TuckError(
      `Translating would overwrite ${existing.length} existing file(s). Re-run with --yes to confirm.`,
      'PRESET_OVERWRITE_REFUSED',
      ['Pass --yes to overwrite (a snapshot is taken first so you can `tuck undo`).']
    );
  }
  if (decision === 'confirm') {
    logger.warning(`This will overwrite ${existing.length} existing file(s):`);
    for (const t of existing) logger.dim(`  ${collapsePath(t)}`);
    const confirmed = await prompts.confirm(
      `Translate ${collapsePath(sourcePath)} into these files?`,
      false
    );
    if (!confirmed) {
      logger.info('Aborted — no files changed.');
      return;
    }
  }

  if (existing.length > 0) {
    await createPreApplySnapshot(existing, 'preset:translate');
  }

  const content = await readFile(sourcePath);
  for (const e of entries) {
    await mkdir(dirname(e.target), { recursive: true });
    if (opts.link) {
      // Replace any existing target with a symlink to the canonical source.
      if (await pathExists(e.target)) await rm(e.target, { force: true });
      await symlink(sourcePath, e.target);
    } else {
      await writeFile(e.target, content);
    }
  }

  if (isJsonMode()) {
    emitJsonOk({
      source: collapsePath(sourcePath),
      mode: opts.link ? 'symlink' : 'copy',
      translated: entries.length,
      targets: entries.map((e) => ({ agent: e.agent, target: e.target })),
    });
    return;
  }
  logger.success(
    `Translated ${collapsePath(sourcePath)} into ${entries.length} agent file(s)` +
      `${opts.link ? ' (symlinked)' : ''}`
  );
  for (const e of entries) logger.dim(`  ${e.label}: ${collapsePath(e.target)}`);
};

export const presetCommand = new Command('preset')
  .description('Apply or publish curated bundles of dotfiles & agent configs')
  .addCommand(
    new Command('list')
      .description('List bundled presets')
      .option('--json', 'Emit JSON envelope')
      .action(listAction)
  )
  .addCommand(
    new Command('show')
      .description("Show a preset's contents")
      .argument('<name>', 'Preset name or path')
      .option('--json', 'Emit JSON envelope')
      .action(showAction)
  )
  .addCommand(
    new Command('apply')
      .description('Apply a preset to the current system')
      .argument('<name>', 'Preset name or path')
      .option('--json', 'Emit JSON envelope')
      .option('-y, --yes', 'Auto-confirm prompts')
      .option('--plan', 'Print the operation plan and exit')
      .option('--dry-run', 'Print the operation as text and exit (no JSON)')
      .action(applyAction)
  )
  .addCommand(
    new Command('publish')
      .description('Validate and prepare a preset for distribution')
      .argument('<dir>', 'Directory containing a preset.json')
      .option('--json', 'Emit JSON envelope')
      .option('-o, --out <path>', 'Output archive path')
      .action(publishAction)
  )
  .addCommand(
    new Command('translate')
      .description('Materialize one canonical instructions file for multiple agents')
      .argument(
        '[source]',
        'Canonical instructions file (defaults to an existing CLAUDE.md/AGENTS.md)'
      )
      .option(
        '--to <agents>',
        'Comma-separated target agents',
        DEFAULT_TRANSLATION_AGENTS.join(',')
      )
      .option('--link', 'Symlink each target to the source instead of copying')
      .option('--json', 'Emit JSON envelope')
      .option('-y, --yes', 'Auto-confirm prompts')
      .option('--plan', 'Print the operation plan and exit')
      .option('--dry-run', 'Print the operation as text and exit (no JSON)')
      .action(translateAction)
  );
