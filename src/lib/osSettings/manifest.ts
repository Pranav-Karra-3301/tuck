/**
 * Read/write helpers for the two on-disk artifacts of `tuck settings`:
 *   - the SHARED manifest (`os-settings.json`) committed to the tuck repo, and
 *   - the MACHINE-LOCAL state (`os-settings-state.json`) in the platform state
 *     dir, recording which manual steps are done on this machine only.
 *
 * Both are validated with zod on read: the manifest can be pulled from an
 * untrusted remote, and the state file can be hand-edited, so neither is ever
 * `as`-cast.
 */
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { pathExists } from '../paths.js';
import { getStateDir } from '../state.js';
import { TuckError } from '../../errors.js';
import {
  osSettingsManifestSchema,
  osSettingsStateSchema,
  type OsSettingsManifest,
  type OsSettingsState,
} from '../../schemas/osSettings.schema.js';

export const OS_SETTINGS_MANIFEST = 'os-settings.json';
const OS_SETTINGS_STATE_FILE = 'os-settings-state.json';

const emptyManifest = (): OsSettingsManifest => ({
  version: '1',
  settings: {},
  manualSteps: {},
});

const emptyState = (): OsSettingsState => ({
  version: '1',
  manualDone: {},
});

export const osSettingsManifestPath = (tuckDir: string): string =>
  join(tuckDir, OS_SETTINGS_MANIFEST);

/**
 * Load and validate the shared settings manifest. A MISSING file yields an
 * empty manifest (first use). A file that exists but cannot be parsed or fails
 * schema validation throws instead: every mutator does load→mutate→save, so
 * degrading a corrupt or newer-version manifest to empty would make the next
 * capture/remove silently WIPE all tracked settings.
 */
export const loadOsSettingsManifest = async (tuckDir: string): Promise<OsSettingsManifest> => {
  const p = osSettingsManifestPath(tuckDir);
  if (!(await pathExists(p))) return emptyManifest();
  let raw: string;
  try {
    raw = await readFile(p, 'utf-8');
  } catch {
    throw new TuckError(
      'Could not read the OS-settings manifest',
      'OS_SETTINGS_MANIFEST_ERROR',
      [`Check permissions on ${p}`]
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new TuckError(
      'The OS-settings manifest is not valid JSON',
      'OS_SETTINGS_MANIFEST_ERROR',
      [
        `Inspect ${p} and fix or remove it`,
        'Restore it from git history: git -C ~/.tuck checkout -- os-settings.json',
      ]
    );
  }
  const parsed = osSettingsManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new TuckError(
      'The OS-settings manifest failed validation (corrupt, or written by a newer tuck)',
      'OS_SETTINGS_MANIFEST_ERROR',
      [
        'Upgrade tuck if this repo was written by a newer version (tuck upgrade)',
        `Inspect ${p}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
      ]
    );
  }
  return parsed.data;
};

export const saveOsSettingsManifest = async (
  tuckDir: string,
  manifest: OsSettingsManifest
): Promise<void> => {
  // Validate before writing so we never persist a malformed manifest.
  const data = osSettingsManifestSchema.parse(manifest);
  await writeFile(osSettingsManifestPath(tuckDir), JSON.stringify(data, null, 2) + '\n', 'utf-8');
};

export const osSettingsStatePath = (): string => join(getStateDir(), OS_SETTINGS_STATE_FILE);

export const osSettingsBackupsDir = (): string => join(getStateDir(), 'os-settings-backups');

const slugForFile = (s: string): string =>
  s
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'domain';

/**
 * Persist a raw domain export into a timestamped backup batch directory so the
 * user can restore the pre-apply state. Returns the written file path (or null
 * when there was nothing to back up).
 */
export const writeDomainBackup = async (
  batchDir: string,
  domain: string,
  raw: string
): Promise<string | null> => {
  if (!raw.trim()) return null;
  await mkdir(batchDir, { recursive: true });
  const file = join(batchDir, `${slugForFile(domain)}.plist`);
  await writeFile(file, raw, 'utf-8');
  return file;
};

/** A fresh backup batch directory path for one apply run. */
export const newBackupBatchDir = (): string => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(osSettingsBackupsDir(), ts);
};

/** Load this machine's manual-step completion state (empty if absent/invalid). */
export const loadOsSettingsState = async (): Promise<OsSettingsState> => {
  const p = osSettingsStatePath();
  if (!(await pathExists(p))) return emptyState();
  try {
    const parsed = osSettingsStateSchema.safeParse(JSON.parse(await readFile(p, 'utf-8')));
    return parsed.success ? parsed.data : emptyState();
  } catch {
    return emptyState();
  }
};

export const saveOsSettingsState = async (state: OsSettingsState): Promise<void> => {
  const data = osSettingsStateSchema.parse(state);
  const p = osSettingsStatePath();
  await mkdir(getStateDir(), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
};
