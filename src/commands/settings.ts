/**
 * `tuck settings` — versioned OS settings (macOS `defaults`).
 *
 * Solves the "undocumented `.macos` script that silently breaks across OS
 * versions" problem: instead of hand-writing `defaults write` incantations, you
 * capture them by changing a setting in the GUI while tuck diffs the affected
 * domains, then replay them on another machine with per-OS-version guards. Steps
 * that cannot be automated live in a tracked manual-steps checklist that tuck
 * reminds you about per machine.
 *
 * Subcommands:
 *   capture   Diff `defaults` domains while you change a GUI setting (or record
 *             a domain/key/value directly for non-interactive use).
 *   apply     Replay tracked settings, honoring version guards; restart apps.
 *   list      Show tracked settings and the manual-steps checklist.
 *   remove    Untrack a captured setting.
 *   manual    Manage the manual-steps checklist (add/list/done/reset).
 *
 * The design is backend-abstracted (see src/lib/osSettings): only macOS ships in
 * v1, but a Linux/dconf backend can be added without changing this command.
 */
import { Command } from 'commander';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest } from '../lib/manifest.js';
import { collapsePath } from '../lib/paths.js';
import {
  TuckError,
  NotInitializedError,
  SettingsError,
  SettingsUnsupportedOsError,
  SettingNotFoundError,
} from '../errors.js';
import { setJsonMode, isJsonMode, emitJsonOk, addJsonWarning } from '../lib/jsonOutput.js';
import type { JsonError } from '../lib/jsonOutput.js';
import { logger, prompts, colors as c } from '../ui/index.js';
import {
  selectBackend,
  diffDomains,
  recordSetting,
  removeSetting,
  applySettings,
  addManualStep,
  setManualDone,
  loadOsSettingsManifest,
  loadOsSettingsState,
  type OsSettingsBackend,
  type DomainSnapshot,
  type ApplyResult,
} from '../lib/osSettings/index.js';
import { settingTypeSchema, type SettingType } from '../schemas/osSettings.schema.js';

const ensureInitialized = async (tuckDir: string): Promise<void> => {
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }
};

const requireBackend = (): OsSettingsBackend => {
  const backend = selectBackend();
  if (!backend) throw new SettingsUnsupportedOsError(process.platform);
  return backend;
};

/** Split a comma-separated option value into a trimmed, non-empty list. */
const parseList = (raw?: string): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const collectRepeat = (val: string, acc: string[]): string[] => {
  acc.push(val);
  return acc;
};

const snapshotAll = async (
  backend: OsSettingsBackend,
  domains: string[]
): Promise<DomainSnapshot[]> => {
  const out: DomainSnapshot[] = [];
  for (const domain of domains) {
    out.push(await backend.snapshotDomain(domain));
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// capture
// ─────────────────────────────────────────────────────────────────────────────

interface CaptureOptions {
  domain: string[];
  key?: string;
  type?: string;
  value?: string;
  delete?: boolean;
  description?: string;
  minVersion?: string;
  maxVersion?: string;
  restart?: string;
  json?: boolean;
  yes?: boolean;
}

const parseSettingType = (raw: string): SettingType => {
  const parsed = settingTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsError(`Unsupported setting type "${raw}"`, [
      'Supported types: boolean, integer, float, string, date',
    ]);
  }
  return parsed.data;
};

const captureAction = async (
  descriptionArg: string | undefined,
  opts: CaptureOptions
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck settings capture');
  const backend = requireBackend();
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const osVersion = await backend.currentOsVersion();
  const description = opts.description ?? descriptionArg ?? '';
  const restartApps = parseList(opts.restart);
  const minVersion = opts.minVersion ?? null;
  const maxVersion = opts.maxVersion ?? null;

  // ── Direct (non-interactive) mode: record one domain/key without diffing. ──
  if (opts.key) {
    const domain = opts.domain[0];
    if (!domain || opts.domain.length !== 1) {
      throw new SettingsError('Direct capture (--key) requires exactly one --domain', [
        'Example: tuck settings capture --domain com.apple.dock --key autohide --type boolean --value true',
      ]);
    }
    const action = opts.delete ? 'delete' : 'write';
    let type: SettingType | undefined;
    let value: string | undefined;
    if (action === 'write') {
      if (!opts.type || opts.value === undefined) {
        throw new SettingsError('A write capture requires --type and --value', [
          'Or pass --delete to record a key deletion',
        ]);
      }
      type = parseSettingType(opts.type);
      value = opts.value;
    }

    const { id, entry, created } = await recordSetting(tuckDir, {
      os: backend.os,
      domain,
      key: opts.key,
      action,
      type,
      value,
      description,
      capturedOsVersion: osVersion,
      minVersion,
      maxVersion,
      restartApps,
    });

    if (isJsonMode()) {
      emitJsonOk({ id, created, entry });
      return;
    }
    logger.success(`${created ? 'Captured' : 'Updated'} setting ${c.cyan(id)}`);
    logger.dim(`  ${backend.plan(entry).display}`);
    if (osVersion) logger.dim(`  captured on macOS ${osVersion}`);
    logger.dim('Commit os-settings.json (e.g. `tuck sync`) to share it.');
    return;
  }

  // ── Interactive diff mode. ──
  if (isJsonMode() || !process.stdout.isTTY) {
    throw new SettingsError('Interactive capture requires a TTY', [
      'For non-interactive capture, pass --domain, --key, --type and --value',
    ]);
  }

  const domains =
    opts.domain.length > 0
      ? opts.domain
      : await withSpinner('Enumerating settings domains…', () => backend.listDomains());

  const before = await withSpinner('Snapshotting current settings…', () =>
    snapshotAll(backend, domains)
  );

  prompts.note(
    'Now change the setting in System Settings (or the app), then come back here.',
    'Capture'
  );
  const proceed = await prompts.confirm('Have you finished changing the setting?', true);
  if (!proceed) {
    logger.info('Capture cancelled — nothing recorded.');
    return;
  }

  const after = await withSpinner('Detecting what changed…', () => snapshotAll(backend, domains));
  const changes = diffDomains(before, after);
  const supported = changes.filter((ch) => !ch.unsupported);
  const unsupported = changes.filter((ch) => ch.unsupported);

  if (supported.length === 0) {
    if (unsupported.length > 0) {
      logger.warning(
        `Detected ${unsupported.length} change(s) with a complex value that v1 cannot auto-replay.`
      );
      logger.dim('Record them as a manual step: tuck settings manual add "<title>"');
    } else {
      logger.info('No setting changes detected. Did the change write to a watched domain?');
      logger.dim('Tip: pass --domain <domain> to watch a specific domain.');
    }
    return;
  }

  console.log();
  console.log(c.bold(`Detected ${supported.length} setting change(s):`));
  for (const ch of supported) {
    const desc =
      ch.action === 'delete'
        ? `delete ${ch.domain} ${ch.key}`
        : `write ${ch.domain} ${ch.key} = ${ch.value} (${ch.type})`;
    console.log(`  ${c.dim('•')} ${c.cyan(desc)}`);
  }
  console.log();

  if (!opts.yes) {
    const ok = await prompts.confirm('Record these change(s)?', true);
    if (!ok) {
      logger.info('Aborted — nothing recorded.');
      return;
    }
  }

  const recorded: string[] = [];
  for (const ch of supported) {
    const { id } = await recordSetting(tuckDir, {
      os: backend.os,
      domain: ch.domain,
      key: ch.key,
      action: ch.action,
      type: ch.type,
      value: ch.value,
      description,
      capturedOsVersion: osVersion,
      minVersion,
      maxVersion,
      restartApps,
    });
    recorded.push(id);
  }

  logger.success(`Recorded ${recorded.length} setting(s).`);
  if (unsupported.length > 0) {
    logger.warning(
      `Skipped ${unsupported.length} complex change(s); add them as manual steps if needed.`
    );
  }
  logger.dim('Commit os-settings.json (e.g. `tuck sync`) to share it.');
};

const withSpinner = async <T>(message: string, fn: () => Promise<T>): Promise<T> => {
  const spinner = prompts.spinner();
  spinner.start(message);
  try {
    const result = await fn();
    spinner.stop(message);
    return result;
  } catch (error) {
    spinner.stop(message);
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

interface ApplyCliOptions {
  id?: string[];
  dryRun?: boolean;
  restart?: boolean; // false when --no-restart passed
  force?: boolean;
  json?: boolean;
  yes?: boolean;
}

/** JSON error projection for a partially-failed apply (mirrors RemoteApplyError). */
interface SettingsApplyJsonError extends JsonError {
  applied: { id: string; display: string }[];
  failed: { id: string; display: string; error: string }[];
  restarted: string[];
  restartRequired: string[];
  backupDir: string | null;
}

/**
 * Raised when one or more `defaults` commands fail mid-replay. Escalating (vs.
 * logging and returning) guarantees a non-zero exit for CI/agents, while
 * {@link toJSON} preserves what was applied, what failed, and the backup dir so
 * `--json` consumers can still recover — the backups already exist on disk.
 */
class SettingsApplyError extends TuckError {
  constructor(private readonly result: ApplyResult) {
    super(
      `Applied ${result.applied.length} setting(s); ${result.failed.length} failed to apply`,
      'SETTINGS_APPLY_FAILED',
      [
        result.backupDir
          ? `Pre-apply backups are at ${collapsePath(result.backupDir)}`
          : 'No backup directory was created',
        'Inspect the failed entries above and re-run once resolved',
      ]
    );
    this.name = 'SettingsApplyError';
  }

  toJSON(): SettingsApplyJsonError {
    return {
      ...super.toJSON(),
      applied: this.result.applied,
      failed: this.result.failed,
      restarted: this.result.restarted,
      restartRequired: this.result.restartRequired,
      backupDir: this.result.backupDir,
    };
  }
}

const applyAction = async (opts: ApplyCliOptions): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck settings apply');
  const backend = requireBackend();
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const currentVersion = await backend.currentOsVersion();
  const only = opts.id && opts.id.length > 0 ? opts.id : undefined;
  const dryRun = opts.dryRun === true;

  // Always compute a dry-run preview first for display / confirmation.
  const preview = await applySettings(backend, tuckDir, {
    currentVersion,
    dryRun: true,
    only,
  });

  if (isJsonMode()) {
    // JSON mode is non-interactive; honor --dry-run, otherwise apply directly.
    if (dryRun) {
      reportOsVersionMismatchJson(preview.osVersionMismatch);
      emitJsonOk({ dryRun: true, ...preview });
      return;
    }
    // Never write OS settings on the strength of a redirected stdout or --json
    // alone: --json is non-interactive, so a real apply must carry an explicit
    // --yes. Without it we refuse rather than silently mutating the machine.
    if (!opts.yes) {
      throw new SettingsError('Refusing to apply settings in --json mode without --yes', [
        'Pass --yes to confirm a non-interactive apply (this WRITES OS settings)',
        'Or add --dry-run to preview the changes without applying them',
      ]);
    }
    const result = await applySettings(backend, tuckDir, {
      currentVersion,
      dryRun: false,
      restart: opts.restart !== false,
      force: opts.force === true,
      only,
    });
    reportOsVersionMismatchJson(result.osVersionMismatch);
    if (result.failed.length > 0) {
      // Escalate so the process exits non-zero; the error's JSON envelope
      // carries the applied/failed/backup report.
      throw new SettingsApplyError(result);
    }
    emitJsonOk({ dryRun: false, ...result });
    return;
  }

  if (preview.applied.length === 0) {
    logger.info('No settings to apply.');
    reportSkippedAndManual(preview.skipped, preview.pendingManual);
    return;
  }

  console.log();
  console.log(
    c.bold(`${dryRun ? 'Would apply' : 'Will apply'} ${preview.applied.length} setting(s):`)
  );
  for (const a of preview.applied) {
    console.log(`  ${c.dim('•')} ${c.cyan(a.display)}`);
  }
  console.log();

  reportOsVersionMismatch(preview.osVersionMismatch);

  if (dryRun) {
    reportSkippedAndManual(preview.skipped, preview.pendingManual);
    logger.dim('Dry run — no changes made. Re-run without --dry-run to apply.');
    return;
  }

  if (!opts.yes) {
    // Never write OS settings on the strength of a redirected stdout alone:
    // prompts.confirm throws OPERATION_CANCELLED on non-TTY stdin, so a
    // non-interactive apply without --yes fails fast instead of proceeding.
    const ok = await prompts.confirm('Apply these settings to this machine?', false);
    if (!ok) {
      logger.info('Aborted — no settings changed.');
      return;
    }
  }

  const result = await applySettings(backend, tuckDir, {
    currentVersion,
    dryRun: false,
    restart: opts.restart !== false,
    force: opts.force === true,
    only,
  });

  logger.success(`Applied ${result.applied.length} setting(s).`);
  if (result.backupDir) logger.dim(`  backup: ${collapsePath(result.backupDir)}`);
  if (result.restarted.length > 0) {
    logger.dim(`  restarted: ${result.restarted.join(', ')}`);
  } else if (result.restartRequired.length > 0) {
    // --no-restart (or nothing restarted): tell the user what to restart by hand
    // rather than falsely claiming apps were restarted.
    logger.dim(`  restart manually to take effect: ${result.restartRequired.join(', ')}`);
  }
  reportSkippedAndManual(result.skipped, result.pendingManual);

  if (result.failed.length > 0) {
    console.log();
    console.log(c.bold(`Failed to apply ${result.failed.length} setting(s):`));
    for (const f of result.failed) {
      console.log(`  ${c.dim('•')} ${c.cyan(f.display)} ${c.dim(`— ${f.error}`)}`);
    }
    // Exit non-zero so scripts/CI notice; backups already exist on disk.
    throw new SettingsApplyError(result);
  }
};

/** Print a non-blocking warning when applied settings were captured on another OS major. */
const reportOsVersionMismatch = (
  mismatches: { id: string; capturedOsVersion: string }[]
): void => {
  if (mismatches.length === 0) return;
  logger.warning(
    `${mismatches.length} setting(s) were captured on a different macOS major version:`
  );
  for (const m of mismatches) {
    logger.dim(`  • ${m.id} (captured on macOS ${m.capturedOsVersion})`);
  }
  logger.dim('These may behave differently here — review after applying.');
};

/** Queue the same OS-version-mismatch warning into the JSON envelope. */
const reportOsVersionMismatchJson = (
  mismatches: { id: string; capturedOsVersion: string }[]
): void => {
  for (const m of mismatches) {
    addJsonWarning(
      `Setting ${m.id} was captured on macOS ${m.capturedOsVersion}, a different major version than this machine`
    );
  }
};

const reportSkippedAndManual = (
  skipped: { id: string; reason: string }[],
  pendingManual: { id: string; title: string }[]
): void => {
  if (skipped.length > 0) {
    console.log();
    console.log(c.bold(`Skipped ${skipped.length} setting(s):`));
    for (const s of skipped) {
      console.log(`  ${c.dim('•')} ${s.id} ${c.dim(`— ${s.reason}`)}`);
    }
  }
  if (pendingManual.length > 0) {
    console.log();
    console.log(c.bold(`Manual steps still to do on this machine (${pendingManual.length}):`));
    for (const m of pendingManual) {
      console.log(`  ${c.dim('•')} ${m.title} ${c.dim(`(${m.id})`)}`);
    }
    logger.dim('Mark done with: tuck settings manual done <id>');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────────────────────

const listAction = async (opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck settings list');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const manifest = await loadOsSettingsManifest(tuckDir);
  const state = await loadOsSettingsState();
  const settings = Object.values(manifest.settings);
  const manualSteps = Object.values(manifest.manualSteps).map((m) => ({
    ...m,
    done: Boolean(state.manualDone[m.id]),
  }));

  if (isJsonMode()) {
    emitJsonOk({
      settingsCount: settings.length,
      manualCount: manualSteps.length,
      settings,
      manualSteps,
    });
    return;
  }

  if (settings.length === 0 && manualSteps.length === 0) {
    logger.info('No OS settings tracked yet.');
    logger.dim('Capture one with: tuck settings capture');
    return;
  }

  if (settings.length > 0) {
    console.log();
    console.log(c.bold(`Tracked settings (${settings.length}):`));
    for (const s of settings) {
      const guard =
        s.minVersion || s.maxVersion
          ? c.dim(
              ` [${s.minVersion ?? ''}${s.minVersion || s.maxVersion ? '..' : ''}${s.maxVersion ?? ''}]`
            )
          : '';
      const val = s.action === 'delete' ? c.dim('(delete)') : `${s.value} ${c.dim(`(${s.type})`)}`;
      console.log(`  ${c.dim('•')} ${c.cyan(`${s.domain} ${s.key}`)} = ${val}${guard}`);
      if (s.description) console.log(`    ${c.dim(s.description)}`);
      console.log(`    ${c.dim(s.id)}`);
    }
  }

  if (manualSteps.length > 0) {
    console.log();
    console.log(c.bold(`Manual steps (${manualSteps.length}):`));
    for (const m of manualSteps) {
      const mark = m.done ? c.green('done') : c.yellow('todo');
      console.log(`  ${c.dim('•')} [${mark}] ${m.title} ${c.dim(`(${m.id})`)}`);
      if (m.instructions) console.log(`    ${c.dim(m.instructions)}`);
    }
  }
  console.log();
};

// ─────────────────────────────────────────────────────────────────────────────
// remove
// ─────────────────────────────────────────────────────────────────────────────

const removeAction = async (id: string, opts: { json?: boolean }): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck settings remove');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const removed = await removeSetting(tuckDir, id);
  if (!removed) throw new SettingNotFoundError(id);

  if (isJsonMode()) {
    emitJsonOk({ removed: true, id });
    return;
  }
  logger.success(`Removed setting ${c.cyan(id)}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// manual
// ─────────────────────────────────────────────────────────────────────────────

const manualAddAction = async (
  title: string,
  opts: { instructions?: string; json?: boolean }
): Promise<void> => {
  if (opts.json) setJsonMode(true, 'tuck settings manual add');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const { id, step, created } = await addManualStep(tuckDir, {
    os: 'macos',
    title,
    instructions: opts.instructions,
  });

  if (isJsonMode()) {
    emitJsonOk({ id, created, step });
    return;
  }
  logger.success(`${created ? 'Added' : 'Updated'} manual step ${c.cyan(id)}`);
  logger.dim('Commit os-settings.json (e.g. `tuck sync`) to share it.');
};

const manualListAction = async (opts: { json?: boolean }): Promise<void> => {
  // Reuse list rendering but only the manual section.
  if (opts.json) setJsonMode(true, 'tuck settings manual list');
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const manifest = await loadOsSettingsManifest(tuckDir);
  const state = await loadOsSettingsState();
  const manualSteps = Object.values(manifest.manualSteps).map((m) => ({
    ...m,
    done: Boolean(state.manualDone[m.id]),
  }));

  if (isJsonMode()) {
    emitJsonOk({ count: manualSteps.length, manualSteps });
    return;
  }

  if (manualSteps.length === 0) {
    logger.info('No manual steps yet.');
    logger.dim('Add one with: tuck settings manual add "<title>"');
    return;
  }
  console.log();
  console.log(c.bold(`Manual steps (${manualSteps.length}):`));
  for (const m of manualSteps) {
    const mark = m.done ? c.green('done') : c.yellow('todo');
    console.log(`  ${c.dim('•')} [${mark}] ${m.title} ${c.dim(`(${m.id})`)}`);
    if (m.instructions) console.log(`    ${c.dim(m.instructions)}`);
  }
  console.log();
};

const manualSetDoneAction = async (
  id: string,
  done: boolean,
  opts: { json?: boolean }
): Promise<void> => {
  const cmd = done ? 'tuck settings manual done' : 'tuck settings manual reset';
  if (opts.json) setJsonMode(true, cmd);
  const tuckDir = getTuckDir();
  await ensureInitialized(tuckDir);

  const manifest = await loadOsSettingsManifest(tuckDir);
  if (!manifest.manualSteps[id]) {
    throw new SettingNotFoundError(id);
  }
  await setManualDone(id, done);

  if (isJsonMode()) {
    emitJsonOk({ id, done });
    return;
  }
  logger.success(
    `Marked manual step ${c.cyan(id)} as ${done ? 'done' : 'not done'} on this machine.`
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Command wiring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fresh `settings` command tree. A factory (rather than a shared
 * singleton) matters because the repeatable `--domain`/`--id` options carry a
 * mutable default array; constructing a new tree per invocation keeps those from
 * accumulating across runs (harmless in a one-shot CLI, but a footgun under a
 * long-lived process such as the test runner).
 */
export const createSettingsCommand = (): Command =>
  new Command('settings')
    .description('Capture, version, and replay OS settings (macOS defaults)')
    .addCommand(
      new Command('capture')
        .description('Capture an OS setting by diffing defaults domains as you change it')
        .argument('[description]', 'Human description of the setting')
        .option(
          '-d, --domain <domain>',
          'Domain to watch/record (repeatable); default: all domains',
          collectRepeat,
          []
        )
        .option('-k, --key <key>', 'Preference key (direct, non-interactive capture)')
        .option('-t, --type <type>', 'Value type: boolean|integer|float|string|date')
        .option('--value <value>', 'Value to record (with --key/--type)')
        .option('--delete', 'Record a key deletion instead of a write')
        .option('-m, --description <text>', 'Human description of the setting')
        .option('--min-version <version>', 'Only apply on OS version >= this')
        .option('--max-version <version>', 'Only apply on OS version <= this')
        .option('--restart <apps>', 'Comma-separated apps to restart on apply (e.g. Dock,Finder)')
        .option('-y, --yes', 'Skip confirmation prompts')
        .option('--json', 'Emit JSON envelope to stdout')
        .action(captureAction)
    )
    .addCommand(
      new Command('apply')
        .description('Replay tracked settings on this machine (version-guarded)')
        .option('--id <id>', 'Only apply this setting id (repeatable)', collectRepeat, [])
        .option('--dry-run', 'Show what would be applied without changing anything')
        .option('--no-restart', 'Do not restart affected apps')
        .option('--force', 'Apply even if a pre-apply domain backup cannot be taken')
        .option('-y, --yes', 'Skip the confirmation prompt')
        .option('--json', 'Emit JSON envelope to stdout')
        .action(applyAction)
    )
    .addCommand(
      new Command('list')
        .description('List tracked settings and manual steps')
        .option('--json', 'Emit JSON envelope to stdout')
        .action(listAction)
    )
    .addCommand(
      new Command('remove')
        .description('Untrack a captured setting by id')
        .argument('<id>', 'Setting id (see `tuck settings list`)')
        .option('--json', 'Emit JSON envelope to stdout')
        .action(removeAction)
    )
    .addCommand(
      new Command('manual')
        .description('Manage the manual-steps checklist (non-automatable steps)')
        .addCommand(
          new Command('add')
            .description('Add a manual step')
            .argument('<title>', 'Short title for the step')
            .option('-i, --instructions <text>', 'Detailed instructions')
            .option('--json', 'Emit JSON envelope to stdout')
            .action(manualAddAction)
        )
        .addCommand(
          new Command('list')
            .description('List manual steps with per-machine completion')
            .option('--json', 'Emit JSON envelope to stdout')
            .action(manualListAction)
        )
        .addCommand(
          new Command('done')
            .description('Mark a manual step done on this machine')
            .argument('<id>', 'Manual step id')
            .option('--json', 'Emit JSON envelope to stdout')
            .action((id: string, opts: { json?: boolean }) => manualSetDoneAction(id, true, opts))
        )
        .addCommand(
          new Command('reset')
            .description('Mark a manual step not done on this machine')
            .argument('<id>', 'Manual step id')
            .option('--json', 'Emit JSON envelope to stdout')
            .action((id: string, opts: { json?: boolean }) => manualSetDoneAction(id, false, opts))
        )
    );

/** Default command instance registered on the root program. */
export const settingsCommand = createSettingsCommand();
