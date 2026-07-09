/**
 * `tuck settings` command integration tests.
 *
 * The manifest/state live on memfs (temp dirs, never the real HOME). All macOS
 * binaries (`defaults`/`sw_vers`/`killall`) are mocked via child_process, so the
 * backend-driven paths are exercised without touching real system settings.
 *
 * Backend-gated subcommands (capture/apply) only run on darwin, where
 * selectBackend() returns the macOS backend; the cross-platform paths
 * (list/remove/manual) run everywhere.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { Command } from 'commander';
import { TEST_TUCK_DIR } from '../setup.js';

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    note: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    multiselect: vi.fn(),
    cancel: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  colors: new Proxy({}, { get: () => (x: string) => x }),
}));

// Mock the macOS CLIs. Keyed on binary + first arg.
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const cmd = args[0] as string;
    const argv = (args[1] as string[]) ?? [];
    let stdout = '';
    if (cmd === 'sw_vers') stdout = '15.1\n';
    else if (cmd === 'defaults' && argv[0] === 'domains') stdout = 'com.apple.dock';
    else if (cmd === 'defaults' && argv[0] === 'export')
      stdout = '<plist version="1.0"><dict><key>autohide</key><false/></dict></plist>';
    callback(null, { stdout, stderr: '' });
  },
}));

const writeBaseManifest = (): void => {
  vol.writeFileSync(
    join(TEST_TUCK_DIR, '.tuckmanifest.json'),
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: {},
    })
  );
};

const captureStdout = (): { writes: string[]; restore: () => void } => {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
};

const runSettings = async (...args: string[]): Promise<void> => {
  const { createSettingsCommand } = await import('../../src/commands/settings.js');
  const { clearManifestCache } = await import('../../src/lib/manifest.js');
  clearManifestCache();
  const program = new Command('tuck');
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.addCommand(createSettingsCommand());
  await program.parseAsync(['node', 'tuck', 'settings', ...args]);
};

const runJson = async (...args: string[]): Promise<Record<string, unknown>> => {
  const { writes, restore } = captureStdout();
  try {
    await runSettings(...args, '--json');
  } finally {
    restore();
  }
  return JSON.parse(writes.join('').trim());
};

beforeEach(async () => {
  vol.reset();
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  writeBaseManifest();
  const { __resetJsonEmitState, setJsonMode } = await import('../../src/lib/jsonOutput.js');
  setJsonMode(false);
  __resetJsonEmitState();
});

describe('tuck settings list (cross-platform)', () => {
  it('emits an ok envelope with empty counts on a fresh manifest', async () => {
    const env = await runJson('list');
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck settings list');
    const data = env.data as Record<string, unknown>;
    expect(data.settingsCount).toBe(0);
    expect(data.manualCount).toBe(0);
  });
});

describe('tuck settings manual (cross-platform)', () => {
  it('adds a manual step, lists it, marks it done, and reflects state', async () => {
    const add = await runJson('manual', 'add', 'Enable FileVault', '-i', 'Privacy pane');
    const addData = add.data as { id: string; created: boolean };
    expect(addData.created).toBe(true);
    const id = addData.id;

    const list = await runJson('manual', 'list');
    const listData = list.data as { count: number; manualSteps: { id: string; done: boolean }[] };
    expect(listData.count).toBe(1);
    expect(listData.manualSteps[0].done).toBe(false);

    const done = await runJson('manual', 'done', id);
    expect((done.data as { done: boolean }).done).toBe(true);

    const list2 = await runJson('manual', 'list');
    expect((list2.data as { manualSteps: { done: boolean }[] }).manualSteps[0].done).toBe(true);

    const reset = await runJson('manual', 'reset', id);
    expect((reset.data as { done: boolean }).done).toBe(false);
  });

  it('errors when marking a nonexistent manual step done', async () => {
    await expect(runSettings('manual', 'done', 'macos__manual__nope', '--json')).rejects.toThrow();
  });
});

describe('tuck settings remove (cross-platform)', () => {
  it('errors on an unknown setting id', async () => {
    await expect(runSettings('remove', 'macos__x__y', '--json')).rejects.toThrow();
  });
});

// Backend-gated paths: darwin only (selectBackend returns null elsewhere).
describe.runIf(process.platform === 'darwin')('tuck settings capture/apply (macOS)', () => {
  it('captures a setting directly and lists it', async () => {
    const cap = await runJson(
      'capture',
      '--domain',
      'com.apple.dock',
      '--key',
      'autohide',
      '--type',
      'boolean',
      '--value',
      'true',
      '--restart',
      'Dock'
    );
    const capData = cap.data as { id: string; entry: { value: string; restartApps: string[] } };
    expect(capData.id).toBe('macos__com.apple.dock__autohide');
    expect(capData.entry.value).toBe('true');
    expect(capData.entry.restartApps).toEqual(['Dock']);

    const list = await runJson('list');
    expect((list.data as { settingsCount: number }).settingsCount).toBe(1);

    // Remove it again through the command.
    const rm = await runJson('remove', 'macos__com.apple.dock__autohide');
    expect((rm.data as { removed: boolean }).removed).toBe(true);
  });

  it('apply --dry-run reports the planned write without applying', async () => {
    await runJson(
      'capture',
      '--domain',
      'com.apple.dock',
      '--key',
      'autohide',
      '--type',
      'boolean',
      '--value',
      'true'
    );
    const env = await runJson('apply', '--dry-run');
    const data = env.data as {
      dryRun: boolean;
      applied: { display: string }[];
      backupDir: string | null;
    };
    expect(data.dryRun).toBe(true);
    expect(data.applied[0].display).toBe('defaults write com.apple.dock autohide -bool true');
    expect(data.backupDir).toBeNull();
  });

  it('skips a setting whose min-version guard exceeds the current OS', async () => {
    await runJson(
      'capture',
      '--domain',
      'com.apple.finder',
      '--key',
      'ShowPathbar',
      '--type',
      'boolean',
      '--value',
      'true',
      '--min-version',
      '99.0'
    );
    const env = await runJson('apply', '--dry-run');
    const data = env.data as { applied: unknown[]; skipped: { reason: string }[] };
    expect(data.applied).toHaveLength(0);
    expect(data.skipped[0].reason).toContain('>= 99.0');
  });
});
