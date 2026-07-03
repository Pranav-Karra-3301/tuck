/**
 * macOS keystore secret-via-stdin regression test.
 *
 * The master backup-encryption password must NEVER be passed to `security` as an
 * argv element: argv is world-readable via `ps`/Activity Monitor for the
 * command's lifetime, so a co-resident user could capture it. The store path must
 * feed the secret over the child's stdin (via `security -i`), mirroring the Linux
 * keystore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

interface FakeChild extends EventEmitter {
  stdin: { write: (data: string) => void; end: () => void };
  stderr: EventEmitter;
  stdinData: string;
}

const spawnMock = vi.fn();
let lastChild: FakeChild | undefined;

vi.mock('child_process', () => ({
  // delete() (called before store) uses promisify(execFile); resolve it.
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, r: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: '', stderr: '' });
  },
  spawn: (...args: unknown[]) => {
    spawnMock(...args);
    const child = new EventEmitter() as FakeChild;
    child.stdinData = '';
    child.stdin = {
      write: (data: string) => {
        child.stdinData += data;
      },
      end: () => undefined,
    };
    child.stderr = new EventEmitter();
    lastChild = child;
    // Simulate a successful, immediate exit after the caller writes stdin.
    setImmediate(() => child.emit('close', 0));
    return child;
  },
}));

describe('MacOSKeystore.store', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    lastChild = undefined;
  });

  it('passes the secret over stdin, never on the process argv', async () => {
    const { MacOSKeystore } = await import('../../src/lib/crypto/keystore/macos.js');
    const keystore = new MacOSKeystore();

    const secret = 'my "master" pass word';
    await keystore.store('tuck-dotfiles', 'backup-encryption', secret);

    // security must be launched in interactive mode with the secret absent from argv.
    expect(spawnMock).toHaveBeenCalled();
    const [cmd, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('security');
    expect(argv).toEqual(['-i']);
    expect(JSON.stringify(argv)).not.toContain('master');
    expect(JSON.stringify(argv)).not.toContain('pass word');

    // The command (with the quoted/escaped secret) is written to stdin instead.
    expect(lastChild?.stdinData).toContain('add-generic-password');
    expect(lastChild?.stdinData).toContain('\\"master\\"');
  });
});
