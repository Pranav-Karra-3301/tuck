/**
 * macOS backend for `tuck settings`, built on the `defaults` CLI.
 *
 * All process invocations go through `execFileAsync` (never a shell) so
 * user/domain/key/value strings are passed as discrete argv entries and cannot
 * be interpreted as shell syntax. Tests mock `child_process` to drive this
 * backend without a real `defaults`/`sw_vers`/`killall`.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { topLevelEntries } from './plist.js';
import type { DomainSnapshot, ApplyOutcome, OsSettingsBackend } from './types.js';
import type { SettingEntry, SettingType } from '../../schemas/osSettings.schema.js';

const execFileAsync = promisify(execFile);

/**
 * `defaults export` on a real Mac routinely emits multi-megabyte plists for
 * domains such as com.apple.finder or the global domain. execFile's default
 * 1 MB stdout cap would reject those with ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
 * which previously masqueraded as an empty export — silently skipping the
 * pre-apply backup and producing bogus "no changes"/delete-everything diffs.
 * A generous 64 MB ceiling comfortably covers observed domains while still
 * bounding memory.
 */
const MAX_BUFFER = 64 * 1024 * 1024;
const EXEC_OPTS = { maxBuffer: MAX_BUFFER } as const;

/**
 * A missing domain is a legitimate "empty" result, not a failure: `defaults`
 * reports "Domain <x> does not exist" for one that was never written. Every
 * OTHER export error (maxBuffer exceeded, `defaults` missing, permissions) is a
 * real failure that must be surfaced, never swallowed into an empty snapshot.
 */
const isDomainMissingError = (error: unknown): boolean => {
  const e = error as { stderr?: string; message?: string };
  const text = `${e?.stderr ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return text.includes('does not exist');
};

const errorText = (error: unknown): string => {
  const e = error as { stderr?: string; message?: string };
  const stderr = (e?.stderr ?? '').trim();
  return stderr || e?.message || String(error);
};

/** Map a supported scalar type to its `defaults write` flag. */
const TYPE_FLAG: Record<SettingType, string> = {
  boolean: '-bool',
  integer: '-int',
  float: '-float',
  string: '-string',
  date: '-date',
};

/**
 * The "global" domain has a canonical name plus the `-g`/`-globalDomain`
 * aliases; we always store and query it under NSGlobalDomain for stability.
 */
export const GLOBAL_DOMAIN = 'NSGlobalDomain';

/** Build the argv (after `defaults`) that replays a stored setting entry. */
export const buildDefaultsArgv = (entry: SettingEntry): string[] => {
  if (entry.action === 'delete') {
    return ['delete', entry.domain, entry.key];
  }
  if (!entry.type) {
    throw new Error(`Setting "${entry.id}" is a write with no type`);
  }
  const flag = TYPE_FLAG[entry.type];
  return ['write', entry.domain, entry.key, flag, entry.value ?? ''];
};

export class MacOsDefaultsBackend implements OsSettingsBackend {
  readonly os = 'macos' as const;

  async isAvailable(): Promise<boolean> {
    return process.platform === 'darwin';
  }

  async currentOsVersion(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], EXEC_OPTS);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  async listDomains(): Promise<string[]> {
    let domains: string[] = [];
    try {
      const { stdout } = await execFileAsync('defaults', ['domains'], EXEC_OPTS);
      domains = stdout
        .split(',')
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
    } catch {
      domains = [];
    }
    // `defaults domains` omits the global domain; always include it so a
    // full-system capture watches NSGlobalDomain too.
    if (!domains.includes(GLOBAL_DOMAIN)) domains.unshift(GLOBAL_DOMAIN);
    return domains;
  }

  async exportRaw(domain: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('defaults', ['export', domain, '-'], EXEC_OPTS);
      return stdout;
    } catch (error) {
      // A never-written domain is legitimately empty; anything else (maxBuffer
      // exceeded, missing binary, permissions) is a real failure that must NOT
      // be silently reported as an empty export — that would skip the pre-apply
      // backup and produce delete-everything capture diffs.
      if (isDomainMissingError(error)) return '';
      throw new Error(`Failed to export defaults domain "${domain}": ${errorText(error)}`);
    }
  }

  async snapshotDomain(domain: string): Promise<DomainSnapshot> {
    // exportRaw throws on a real export failure; let it propagate so capture
    // surfaces the error instead of masquerading it as "no changes".
    const raw = await this.exportRaw(domain);
    if (!raw.trim()) {
      // A domain with no preferences is treated as empty — capture diffs against
      // an empty snapshot.
      return { domain, entries: new Map() };
    }
    try {
      return { domain, entries: topLevelEntries(raw) };
    } catch {
      return { domain, entries: new Map() };
    }
  }

  plan(entry: SettingEntry): ApplyOutcome {
    const argv = buildDefaultsArgv(entry);
    return { argv, display: `defaults ${argv.join(' ')}` };
  }

  async apply(entry: SettingEntry): Promise<void> {
    const argv = buildDefaultsArgv(entry);
    await execFileAsync('defaults', argv, EXEC_OPTS);
  }

  async restartApp(app: string): Promise<void> {
    // Best-effort: `killall` exits non-zero if the app is not running. That is
    // not an error for our purposes (nothing to restart), so swallow it.
    try {
      await execFileAsync('killall', [app], EXEC_OPTS);
    } catch {
      /* app was not running */
    }
  }
}
