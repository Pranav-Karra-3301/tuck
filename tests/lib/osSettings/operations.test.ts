/**
 * Tests for the stateful settings operations (manifest + state on memfs). The
 * backend is a hand-written fake implementing OsSettingsBackend, so apply logic
 * (version guards, backups, restarts, manual reminders) is exercised without any
 * real `defaults` call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_TUCK_DIR } from '../../setup.js';
import {
  recordSetting,
  removeSetting,
  applySettings,
  addManualStep,
  removeManualStep,
  setManualDone,
} from '../../../src/lib/osSettings/operations.js';
import {
  loadOsSettingsManifest,
  loadOsSettingsState,
  osSettingsBackupsDir,
} from '../../../src/lib/osSettings/manifest.js';
import type {
  OsSettingsBackend,
  DomainSnapshot,
  ApplyOutcome,
} from '../../../src/lib/osSettings/types.js';
import type { SettingEntry } from '../../../src/schemas/osSettings.schema.js';

class FakeBackend implements OsSettingsBackend {
  readonly os = 'macos' as const;
  public applied: string[] = [];
  public restarted: string[] = [];
  public exported: string[] = [];
  constructor(private version = '15.1') {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async currentOsVersion(): Promise<string> {
    return this.version;
  }
  async listDomains(): Promise<string[]> {
    return [];
  }
  async snapshotDomain(domain: string): Promise<DomainSnapshot> {
    return { domain, entries: new Map() };
  }
  async exportRaw(domain: string): Promise<string> {
    this.exported.push(domain);
    return `<plist><dict><key>x</key><string>${domain}</string></dict></plist>`;
  }
  plan(entry: SettingEntry): ApplyOutcome {
    const argv =
      entry.action === 'delete'
        ? ['delete', entry.domain, entry.key]
        : ['write', entry.domain, entry.key, `-${entry.type}`, entry.value ?? ''];
    return { argv, display: `defaults ${argv.join(' ')}` };
  }
  async apply(entry: SettingEntry): Promise<void> {
    this.applied.push(entry.id);
  }
  async restartApp(app: string): Promise<void> {
    this.restarted.push(app);
  }
}

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
});

describe('recordSetting', () => {
  it('creates a new setting and persists it to the manifest', async () => {
    const { id, created, entry } = await recordSetting(TEST_TUCK_DIR, {
      os: 'macos',
      domain: 'com.apple.dock',
      key: 'autohide',
      action: 'write',
      type: 'boolean',
      value: 'true',
      capturedOsVersion: '15.1',
      restartApps: ['Dock'],
    });
    expect(created).toBe(true);
    expect(id).toBe('macos__com.apple.dock__autohide');
    expect(entry.restartApps).toEqual(['Dock']);

    const manifest = await loadOsSettingsManifest(TEST_TUCK_DIR);
    expect(manifest.settings[id].value).toBe('true');
  });

  it('updates an existing setting in place and preserves added timestamp', async () => {
    const first = await recordSetting(TEST_TUCK_DIR, {
      os: 'macos',
      domain: 'd',
      key: 'k',
      action: 'write',
      type: 'integer',
      value: '48',
    });
    const second = await recordSetting(TEST_TUCK_DIR, {
      os: 'macos',
      domain: 'd',
      key: 'k',
      action: 'write',
      type: 'integer',
      value: '64',
    });
    expect(second.created).toBe(false);
    expect(second.entry.added).toBe(first.entry.added);
    expect(second.entry.value).toBe('64');
  });
});

describe('removeSetting', () => {
  it('removes a tracked setting and reports whether it existed', async () => {
    await recordSetting(TEST_TUCK_DIR, {
      os: 'macos',
      domain: 'd',
      key: 'k',
      action: 'delete',
    });
    expect(await removeSetting(TEST_TUCK_DIR, 'macos__d__k')).toBe(true);
    expect(await removeSetting(TEST_TUCK_DIR, 'macos__d__k')).toBe(false);
  });
});

describe('applySettings', () => {
  const seed = async (): Promise<void> => {
    await recordSetting(TEST_TUCK_DIR, {
      os: 'macos',
      domain: 'com.apple.dock',
      key: 'autohide',
      action: 'write',
      type: 'boolean',
      value: 'true',
      restartApps: ['Dock'],
    });
    await recordSetting(TEST_TUCK_DIR, {
      os: 'macos',
      domain: 'com.apple.finder',
      key: 'ShowPathbar',
      action: 'write',
      type: 'boolean',
      value: 'true',
      minVersion: '99.0', // guard: never applies on 15.1
      restartApps: ['Finder'],
    });
  };

  it('applies passing settings, skips version-guarded ones, and restarts apps', async () => {
    await seed();
    const backend = new FakeBackend('15.1');
    const result = await applySettings(backend, TEST_TUCK_DIR, {
      currentVersion: '15.1',
      restart: true,
    });

    expect(result.applied.map((a) => a.id)).toEqual(['macos__com.apple.dock__autohide']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('>= 99.0');
    expect(backend.applied).toEqual(['macos__com.apple.dock__autohide']);
    expect(backend.restarted).toEqual(['Dock']);
    expect(result.backupDir).not.toBeNull();
  });

  it('backs up affected domains before writing', async () => {
    await seed();
    const backend = new FakeBackend('15.1');
    const result = await applySettings(backend, TEST_TUCK_DIR, {
      currentVersion: '15.1',
      restart: false,
    });
    // Only the dock domain passes its guard, so only it is backed up.
    expect(backend.exported).toEqual(['com.apple.dock']);
    expect(result.backupDir).toContain(osSettingsBackupsDir());
    const files = vol.readdirSync(result.backupDir as string);
    expect(files).toContain('com.apple.dock.plist');
  });

  it('does not write or back up in dry-run mode', async () => {
    await seed();
    const backend = new FakeBackend('15.1');
    const result = await applySettings(backend, TEST_TUCK_DIR, {
      currentVersion: '15.1',
      dryRun: true,
      restart: true,
    });
    expect(result.applied).toHaveLength(1);
    expect(backend.applied).toEqual([]); // nothing actually applied
    expect(backend.exported).toEqual([]); // no backups
    expect(result.backupDir).toBeNull();
  });

  it('honors the `only` filter', async () => {
    await seed();
    const backend = new FakeBackend('15.1');
    const result = await applySettings(backend, TEST_TUCK_DIR, {
      currentVersion: '15.1',
      only: ['macos__com.apple.finder__ShowPathbar'],
    });
    // The finder entry is filtered in, but its version guard fails at 15.1.
    expect(result.applied).toHaveLength(0);
    expect(result.skipped.map((s) => s.id)).toEqual(['macos__com.apple.finder__ShowPathbar']);
  });

  it('reports pending manual steps not yet done on this machine', async () => {
    await seed();
    await addManualStep(TEST_TUCK_DIR, { os: 'macos', title: 'Enable FileVault' });
    const backend = new FakeBackend('15.1');
    const result = await applySettings(backend, TEST_TUCK_DIR, { currentVersion: '15.1' });
    expect(result.pendingManual.map((m) => m.title)).toEqual(['Enable FileVault']);

    // Once marked done on this machine, it drops out of the reminder.
    await setManualDone('macos__manual__enable-filevault', true);
    const after = await applySettings(backend, TEST_TUCK_DIR, { currentVersion: '15.1' });
    expect(after.pendingManual).toHaveLength(0);
  });
});

describe('manual steps', () => {
  it('adds, updates, marks done per machine, and removes', async () => {
    const { id, created } = await addManualStep(TEST_TUCK_DIR, {
      os: 'macos',
      title: 'Grant Full Disk Access',
      instructions: 'System Settings > Privacy',
    });
    expect(created).toBe(true);

    const update = await addManualStep(TEST_TUCK_DIR, {
      os: 'macos',
      title: 'Grant Full Disk Access',
    });
    expect(update.created).toBe(false);

    await setManualDone(id, true);
    let state = await loadOsSettingsState();
    expect(state.manualDone[id]).toBeTruthy();

    await setManualDone(id, false);
    state = await loadOsSettingsState();
    expect(state.manualDone[id]).toBeUndefined();

    expect(await removeManualStep(TEST_TUCK_DIR, id)).toBe(true);
    expect(await removeManualStep(TEST_TUCK_DIR, id)).toBe(false);
  });
});
