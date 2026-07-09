/**
 * MacOsDefaultsBackend tests. The `defaults`, `sw_vers`, and `killall` binaries
 * are fully mocked via child_process — no real macOS CLI is invoked, so these
 * pass on any platform.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

// Per-test control over stdout/errors keyed by the invoked binary + first arg.
let responder: (cmd: string, args: string[]) => { stdout: string } | Error = () => ({
  stdout: '',
});

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const cmd = args[0] as string;
    const argv = (args[1] as string[]) ?? [];
    execFileMock(cmd, argv);
    const res = responder(cmd, argv);
    if (res instanceof Error) {
      callback(res, { stdout: '', stderr: '' });
      return;
    }
    callback(null, { stdout: res.stdout, stderr: '' });
  },
}));

const EXPORT_DOCK = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>autohide</key>
\t<true/>
\t<key>tilesize</key>
\t<integer>48</integer>
</dict>
</plist>`;

describe('MacOsDefaultsBackend', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    responder = () => ({ stdout: '' });
  });

  it('currentOsVersion reads `sw_vers -productVersion`', async () => {
    responder = (cmd) => (cmd === 'sw_vers' ? { stdout: '15.1\n' } : { stdout: '' });
    const { MacOsDefaultsBackend } = await import('../../../src/lib/osSettings/defaults.js');
    const backend = new MacOsDefaultsBackend();
    expect(await backend.currentOsVersion()).toBe('15.1');
    expect(execFileMock).toHaveBeenCalledWith('sw_vers', ['-productVersion']);
  });

  it('currentOsVersion returns empty string when sw_vers fails', async () => {
    responder = () => new Error('not found');
    const { MacOsDefaultsBackend } = await import('../../../src/lib/osSettings/defaults.js');
    expect(await new MacOsDefaultsBackend().currentOsVersion()).toBe('');
  });

  it('listDomains parses comma output and always includes the global domain', async () => {
    responder = (cmd, argv) =>
      cmd === 'defaults' && argv[0] === 'domains'
        ? { stdout: 'com.apple.dock, com.apple.finder' }
        : { stdout: '' };
    const { MacOsDefaultsBackend, GLOBAL_DOMAIN } =
      await import('../../../src/lib/osSettings/defaults.js');
    const domains = await new MacOsDefaultsBackend().listDomains();
    expect(domains).toContain('com.apple.dock');
    expect(domains).toContain('com.apple.finder');
    expect(domains).toContain(GLOBAL_DOMAIN);
    expect(domains[0]).toBe(GLOBAL_DOMAIN);
  });

  it('snapshotDomain exports and parses a domain plist', async () => {
    responder = (cmd, argv) =>
      cmd === 'defaults' && argv[0] === 'export' ? { stdout: EXPORT_DOCK } : { stdout: '' };
    const { MacOsDefaultsBackend } = await import('../../../src/lib/osSettings/defaults.js');
    const snap = await new MacOsDefaultsBackend().snapshotDomain('com.apple.dock');
    expect(execFileMock).toHaveBeenCalledWith('defaults', ['export', 'com.apple.dock', '-']);
    expect(snap.entries.get('autohide')).toEqual({ kind: 'boolean', value: true });
    expect(snap.entries.get('tilesize')).toEqual({ kind: 'integer', value: 48 });
  });

  it('snapshotDomain returns an empty snapshot when export fails', async () => {
    responder = () => new Error('domain does not exist');
    const { MacOsDefaultsBackend } = await import('../../../src/lib/osSettings/defaults.js');
    const snap = await new MacOsDefaultsBackend().snapshotDomain('nope');
    expect(snap.entries.size).toBe(0);
  });

  it('apply runs `defaults write` with the typed flag and value', async () => {
    const { MacOsDefaultsBackend } = await import('../../../src/lib/osSettings/defaults.js');
    const backend = new MacOsDefaultsBackend();
    await backend.apply({
      id: 'macos__com.apple.dock__autohide',
      os: 'macos',
      description: '',
      domain: 'com.apple.dock',
      key: 'autohide',
      action: 'write',
      type: 'boolean',
      value: 'true',
      capturedOsVersion: '15.1',
      minVersion: null,
      maxVersion: null,
      restartApps: [],
      added: 'x',
      modified: 'x',
    });
    expect(execFileMock).toHaveBeenCalledWith('defaults', [
      'write',
      'com.apple.dock',
      'autohide',
      '-bool',
      'true',
    ]);
  });

  it('apply runs `defaults delete` for a delete action', async () => {
    const { MacOsDefaultsBackend, buildDefaultsArgv } =
      await import('../../../src/lib/osSettings/defaults.js');
    const entry = {
      id: 'macos__d__k',
      os: 'macos' as const,
      description: '',
      domain: 'd',
      key: 'k',
      action: 'delete' as const,
      capturedOsVersion: '',
      minVersion: null,
      maxVersion: null,
      restartApps: [],
      added: 'x',
      modified: 'x',
    };
    expect(buildDefaultsArgv(entry)).toEqual(['delete', 'd', 'k']);
    await new MacOsDefaultsBackend().apply(entry);
    expect(execFileMock).toHaveBeenCalledWith('defaults', ['delete', 'd', 'k']);
  });

  it('plan builds a human-readable display string', async () => {
    const { MacOsDefaultsBackend } = await import('../../../src/lib/osSettings/defaults.js');
    const plan = new MacOsDefaultsBackend().plan({
      id: 'x',
      os: 'macos',
      description: '',
      domain: 'com.apple.dock',
      key: 'tilesize',
      action: 'write',
      type: 'integer',
      value: '64',
      capturedOsVersion: '',
      minVersion: null,
      maxVersion: null,
      restartApps: [],
      added: 'x',
      modified: 'x',
    });
    expect(plan.display).toBe('defaults write com.apple.dock tilesize -int 64');
  });

  it('restartApp swallows a killall failure (app not running)', async () => {
    responder = () => new Error('No matching processes');
    const { MacOsDefaultsBackend } = await import('../../../src/lib/osSettings/defaults.js');
    await expect(new MacOsDefaultsBackend().restartApp('Dock')).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith('killall', ['Dock']);
  });
});
