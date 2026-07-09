import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// execFile is promisified inside the keystore modules; mock the callback form
// so promisify(execFile) resolves/rejects under our control.
const execFileMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    // promisify expects the last arg to be a node-style callback.
    const cb = args[args.length - 1] as (err: Error | null, res?: unknown) => void;
    return execFileMock(cb);
  },
  spawn: vi.fn(),
}));

// The keystores now probe for their CLI (secret-tool / security) via
// commandExists (a direct PATH scan) instead of a `which` subprocess. Mock it so
// the tests control binary presence the way they used to control the `which`
// probe; buildCommandPath is passed through for any transitive importers.
const commandExistsMock = vi.fn(async () => true);

vi.mock('../../src/lib/commandPath.js', () => ({
  commandExists: (bin: string) => commandExistsMock(bin),
  buildCommandPath: (cmd: { name(): string; parent?: unknown }, root = 'tuck') => {
    const parts: string[] = [];
    let current: { name(): string; parent?: unknown } | null | undefined = cmd;
    while (current && current.name() !== root) {
      parts.unshift(current.name());
      current = current.parent as typeof current;
    }
    return [root, ...parts].join(' ');
  },
}));

import { LinuxKeystore } from '../../src/lib/crypto/keystore/linux.js';
import { WindowsKeystore } from '../../src/lib/crypto/keystore/windows.js';
import { getKeystore, clearKeystoreCache } from '../../src/lib/crypto/keystore/index.js';
import { FallbackKeystore } from '../../src/lib/crypto/keystore/fallback.js';

const setPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

describe('LinuxKeystore.isAvailable probe', () => {
  const originalPlatform = process.platform;
  const originalDbus = process.env.DBUS_SESSION_BUS_ADDRESS;

  beforeEach(() => {
    execFileMock.mockReset();
    // Default: `which secret-tool` succeeds.
    execFileMock.mockImplementation((cb: (e: Error | null, r?: unknown) => void) => {
      cb(null, { stdout: '/usr/bin/secret-tool\n', stderr: '' });
    });
    // Default: secret-tool is present on PATH.
    commandExistsMock.mockReset();
    commandExistsMock.mockResolvedValue(true);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalDbus === undefined) {
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
    } else {
      process.env.DBUS_SESSION_BUS_ADDRESS = originalDbus;
    }
  });

  it('returns false when DBUS_SESSION_BUS_ADDRESS is unset (no session bus)', async () => {
    setPlatform('linux');
    delete process.env.DBUS_SESSION_BUS_ADDRESS;

    const ks = new LinuxKeystore();
    expect(await ks.isAvailable()).toBe(false);
  });

  it('returns true on linux when a session bus is present and secret-tool exists', async () => {
    setPlatform('linux');
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';

    const ks = new LinuxKeystore();
    expect(await ks.isAvailable()).toBe(true);
  });

  it('returns false on non-linux platforms', async () => {
    setPlatform('darwin');
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';

    const ks = new LinuxKeystore();
    expect(await ks.isAvailable()).toBe(false);
  });

  it('accepts the systemd session-bus socket when DBUS_SESSION_BUS_ADDRESS is unset', async () => {
    // A desktop/systemd session may not export DBUS_SESSION_BUS_ADDRESS into this
    // process but still has a reachable bus at $XDG_RUNTIME_DIR/bus — an existing
    // keyring user must NOT be silently downgraded to the file keystore.
    setPlatform('linux');
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const { vol } = await import('memfs');
    vol.mkdirSync('/run/user/1000', { recursive: true });
    vol.writeFileSync('/run/user/1000/bus', '');
    try {
      const ks = new LinuxKeystore();
      expect(await ks.isAvailable()).toBe(true);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = originalXdg;
    }
  });
});

describe('WindowsKeystore.isAvailable', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('returns false on win32 (Windows uses the encrypted fallback keystore by design)', async () => {
    setPlatform('win32');
    const ks = new WindowsKeystore();
    expect(await ks.isAvailable()).toBe(false);
  });
});

describe('getKeystore platform selection', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    clearKeystoreCache();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    clearKeystoreCache();
  });

  it('selects the encrypted fallback keystore on win32', async () => {
    setPlatform('win32');
    const ks = await getKeystore();
    expect(ks).toBeInstanceOf(FallbackKeystore);
  });
});
