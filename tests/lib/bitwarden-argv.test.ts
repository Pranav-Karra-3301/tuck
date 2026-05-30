/**
 * Bitwarden argv end-of-options regression test.
 *
 * backendPath is user-controlled (read from a committed mappings file) and is
 * passed as an argv element to `bw`. Even though execFile uses no shell, a path
 * could still be misread as a flag by the bw CLI. Inserting a `--`
 * end-of-options separator BEFORE the path guarantees it is treated as a
 * positional argument. (op/pass already do this; bw must too.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    // promisify(execFile) calls execFile(cmd, args, opts, callback).
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const recorded = args.slice(0, -1);
    execFileMock(...recorded);
    callback(null, {
      stdout: JSON.stringify({
        id: 'x',
        name: 'item',
        login: { password: 'sekret' },
      }),
      stderr: '',
    });
  },
}));

describe('BitwardenBackend.getSecret argv', () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });

  it("passes '--' before the user-controlled backendPath", async () => {
    const { BitwardenBackend } = await import('../../src/lib/secretBackends/bitwarden.js');
    const backend = new BitwardenBackend();

    const value = await backend.getSecret({ name: 'GITHUB_TOKEN', backendPath: 'github-token' });
    expect(value).toBe('sekret');

    // Find the `bw get item ...` invocation among recorded execFile calls.
    const getItemCall = execFileMock.mock.calls.find(
      (call) => call[0] === 'bw' && Array.isArray(call[1]) && call[1][0] === 'get'
    );
    expect(getItemCall).toBeDefined();

    const argv = getItemCall![1] as string[];
    expect(argv).toEqual(['get', 'item', '--', 'github-token']);

    // The separator must come immediately before the path.
    const sepIndex = argv.indexOf('--');
    const pathIndex = argv.indexOf('github-token');
    expect(sepIndex).toBeGreaterThanOrEqual(0);
    expect(sepIndex).toBe(pathIndex - 1);
  });
});
