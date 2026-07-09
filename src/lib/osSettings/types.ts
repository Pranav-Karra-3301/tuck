/**
 * Backend abstraction for `tuck settings`.
 *
 * v1 ships one backend (macOS `defaults`). The interface is the seam that lets a
 * Linux/dconf backend be added later without touching the command layer: the
 * command talks only to `OsSettingsBackend`, and `selectBackend()` picks the
 * implementation for the current platform.
 */
import type { PlistValue } from './plist.js';
import type { SettingEntry, SettingType, SettingsOs } from '../../schemas/osSettings.schema.js';

/** A point-in-time snapshot of one settings domain's top-level entries. */
export interface DomainSnapshot {
  domain: string;
  /** Top-level key -> parsed value. Backend-specific value shape. */
  entries: Map<string, PlistValue>;
}

/** A single detected change between two snapshots of a domain. */
export interface CapturedChange {
  domain: string;
  key: string;
  action: 'write' | 'delete';
  /** Present for action=write. Undefined means the value type is unsupported. */
  type?: SettingType;
  /** String form for the write command; present for supported write changes. */
  value?: string;
  /**
   * True when the value changed but its type (dict/array/data) is not something
   * v1 can safely replay. The change is surfaced to the user as a candidate
   * manual step rather than an auto-applied write.
   */
  unsupported?: boolean;
}

export interface ApplyOutcome {
  /** The argv (after the base command) that was or would be run. */
  argv: string[];
  /** Human-readable command string for display/audit. */
  display: string;
}

/**
 * A settings backend for one OS family. All methods that shell out are async so
 * they can be mocked in tests without a real `defaults`/`sw_vers`/`killall`.
 */
export interface OsSettingsBackend {
  readonly os: SettingsOs;
  /** True when this backend can run on the current machine. */
  isAvailable(): Promise<boolean>;
  /** Current OS product version, e.g. "15.1"; empty string if undetectable. */
  currentOsVersion(): Promise<string>;
  /** All settings domains present on the machine (for a full-system capture). */
  listDomains(): Promise<string[]>;
  /** Snapshot one domain's top-level entries. */
  snapshotDomain(domain: string): Promise<DomainSnapshot>;
  /** Raw serialized form of a domain (for pre-apply backups); '' if empty. */
  exportRaw(domain: string): Promise<string>;
  /** Compute the applyable command for a stored setting entry. */
  plan(entry: SettingEntry): ApplyOutcome;
  /** Execute a stored setting entry (write or delete). */
  apply(entry: SettingEntry): Promise<void>;
  /** Restart an application so a setting takes effect (best-effort). */
  restartApp(app: string): Promise<void>;
}
