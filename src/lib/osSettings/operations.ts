/**
 * Stateful operations for `tuck settings` that combine a backend with the
 * on-disk manifest/state. Kept separate from the Commander layer so they can be
 * unit-tested directly with a backend whose `defaults` calls are mocked.
 */
import { settingId } from './capture.js';
import { isVersionInRange } from './version.js';
import {
  loadOsSettingsManifest,
  saveOsSettingsManifest,
  loadOsSettingsState,
  saveOsSettingsState,
  newBackupBatchDir,
  writeDomainBackup,
} from './manifest.js';
import type { OsSettingsBackend } from './types.js';
import type {
  SettingEntry,
  SettingType,
  SettingAction,
  ManualStep,
  SettingsOs,
} from '../../schemas/osSettings.schema.js';

export interface RecordSettingInput {
  os: SettingsOs;
  domain: string;
  key: string;
  action: SettingAction;
  type?: SettingType;
  value?: string;
  description?: string;
  capturedOsVersion?: string;
  minVersion?: string | null;
  maxVersion?: string | null;
  restartApps?: string[];
}

/**
 * Upsert a captured setting into the shared manifest. Re-capturing the same
 * (os, domain, key) updates the value/type in place and preserves the original
 * `added` timestamp.
 */
export const recordSetting = async (
  tuckDir: string,
  input: RecordSettingInput
): Promise<{ id: string; entry: SettingEntry; created: boolean }> => {
  const id = settingId(input.os, input.domain, input.key);
  const now = new Date().toISOString();
  const manifest = await loadOsSettingsManifest(tuckDir);
  const existing = manifest.settings[id];

  const entry: SettingEntry = {
    id,
    os: input.os,
    description: input.description ?? existing?.description ?? '',
    domain: input.domain,
    key: input.key,
    action: input.action,
    type: input.action === 'write' ? input.type : undefined,
    value: input.action === 'write' ? input.value : undefined,
    capturedOsVersion: input.capturedOsVersion ?? existing?.capturedOsVersion ?? '',
    minVersion: input.minVersion ?? existing?.minVersion ?? null,
    maxVersion: input.maxVersion ?? existing?.maxVersion ?? null,
    restartApps: input.restartApps ?? existing?.restartApps ?? [],
    added: existing?.added ?? now,
    modified: now,
  };

  manifest.settings[id] = entry;
  await saveOsSettingsManifest(tuckDir, manifest);
  return { id, entry, created: !existing };
};

export const removeSetting = async (tuckDir: string, id: string): Promise<boolean> => {
  const manifest = await loadOsSettingsManifest(tuckDir);
  if (!manifest.settings[id]) return false;
  delete manifest.settings[id];
  await saveOsSettingsManifest(tuckDir, manifest);
  return true;
};

export interface AppliedSetting {
  id: string;
  display: string;
}
export interface SkippedSetting {
  id: string;
  reason: string;
}
export interface ApplyResult {
  applied: AppliedSetting[];
  skipped: SkippedSetting[];
  restarted: string[];
  backupDir: string | null;
  pendingManual: { id: string; title: string }[];
}

export interface ApplyOptions {
  currentVersion: string;
  dryRun?: boolean;
  restart?: boolean;
  /** If set, only apply settings whose id is in this list. */
  only?: string[];
}

/**
 * Apply tracked settings for the backend's OS, honoring per-entry version
 * guards. Backs up each affected domain before writing (unless dry-run) and,
 * when `restart` is set, restarts each app the applied settings declare.
 */
export const applySettings = async (
  backend: OsSettingsBackend,
  tuckDir: string,
  opts: ApplyOptions
): Promise<ApplyResult> => {
  const manifest = await loadOsSettingsManifest(tuckDir);
  const onlySet = opts.only ? new Set(opts.only) : null;

  const entries = Object.values(manifest.settings)
    .filter((e) => e.os === backend.os)
    .filter((e) => (onlySet ? onlySet.has(e.id) : true))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const applied: AppliedSetting[] = [];
  const skipped: SkippedSetting[] = [];
  const restartApps = new Set<string>();

  // Decide which entries pass their version guard up front so we only back up
  // the domains we are actually going to touch.
  const toApply: SettingEntry[] = [];
  for (const entry of entries) {
    const guard = isVersionInRange(opts.currentVersion, entry.minVersion, entry.maxVersion);
    if (!guard.ok) {
      skipped.push({ id: entry.id, reason: guard.reason ?? 'version guard failed' });
      continue;
    }
    toApply.push(entry);
  }

  // Backup affected domains (real apply only).
  let backupDir: string | null = null;
  if (!opts.dryRun && toApply.length > 0) {
    backupDir = newBackupBatchDir();
    const domains = new Set(toApply.map((e) => e.domain));
    for (const domain of domains) {
      const raw = await backend.exportRaw(domain);
      await writeDomainBackup(backupDir, domain, raw);
    }
  }

  for (const entry of toApply) {
    const plan = backend.plan(entry);
    if (!opts.dryRun) {
      await backend.apply(entry);
    }
    applied.push({ id: entry.id, display: plan.display });
    for (const app of entry.restartApps) restartApps.add(app);
  }

  const restarted: string[] = [];
  if (opts.restart && !opts.dryRun) {
    for (const app of restartApps) {
      await backend.restartApp(app);
      restarted.push(app);
    }
  }

  const state = await loadOsSettingsState();
  const pendingManual = Object.values(manifest.manualSteps)
    .filter((m) => m.os === backend.os && !state.manualDone[m.id])
    .map((m) => ({ id: m.id, title: m.title }));

  return {
    applied,
    skipped,
    restarted: opts.restart ? restarted : [...restartApps],
    backupDir,
    pendingManual,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Manual steps
// ─────────────────────────────────────────────────────────────────────────────

const manualId = (os: string, title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${os}__manual__${slug || 'step'}`;
};

export const addManualStep = async (
  tuckDir: string,
  input: { os: SettingsOs; title: string; instructions?: string }
): Promise<{ id: string; step: ManualStep; created: boolean }> => {
  const id = manualId(input.os, input.title);
  const now = new Date().toISOString();
  const manifest = await loadOsSettingsManifest(tuckDir);
  const existing = manifest.manualSteps[id];
  const step: ManualStep = {
    id,
    os: input.os,
    title: input.title,
    instructions: input.instructions ?? existing?.instructions ?? '',
    added: existing?.added ?? now,
    modified: now,
  };
  manifest.manualSteps[id] = step;
  await saveOsSettingsManifest(tuckDir, manifest);
  return { id, step, created: !existing };
};

export const removeManualStep = async (tuckDir: string, id: string): Promise<boolean> => {
  const manifest = await loadOsSettingsManifest(tuckDir);
  if (!manifest.manualSteps[id]) return false;
  delete manifest.manualSteps[id];
  await saveOsSettingsManifest(tuckDir, manifest);
  return true;
};

/** Mark or unmark a manual step as done on THIS machine (state dir, not repo). */
export const setManualDone = async (id: string, done: boolean): Promise<void> => {
  const state = await loadOsSettingsState();
  if (done) {
    state.manualDone[id] = new Date().toISOString();
  } else {
    delete state.manualDone[id];
  }
  await saveOsSettingsState(state);
};
