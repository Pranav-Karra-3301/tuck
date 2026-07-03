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

// The item JSON the mocked `bw get item` returns. Overridable per-test.
let itemStdout = JSON.stringify({
  id: 'x',
  name: 'item',
  login: { password: 'sekret' },
});

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
      stdout: itemStdout,
      stderr: '',
    });
  },
}));

describe('BitwardenBackend.getSecret argv', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    itemStdout = JSON.stringify({
      id: 'x',
      name: 'item',
      login: { password: 'sekret' },
    });
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

  it('looks up only the item name (not the whole item/field path) and returns the field', async () => {
    const { BitwardenBackend } = await import('../../src/lib/secretBackends/bitwarden.js');
    const backend = new BitwardenBackend();

    // Item with a distinct username; the mapping selects the username field.
    itemStdout = JSON.stringify({
      id: 'x',
      name: 'github-token',
      login: { username: 'octocat', password: 'sekret' },
    });

    const value = await backend.getSecret({
      name: 'GITHUB_TOKEN',
      backendPath: 'github-token/username',
    });

    // The field must resolve (pre-fix this returned null because bw was asked to
    // find an item literally named "github-token/username").
    expect(value).toBe('octocat');

    const getItemCall = execFileMock.mock.calls.find(
      (call) => call[0] === 'bw' && Array.isArray(call[1]) && call[1][0] === 'get'
    );
    const argv = getItemCall![1] as string[];
    // Only the item name (the part before the first "/") is passed to bw.
    expect(argv).toEqual(['get', 'item', '--', 'github-token']);
  });

  it('resolves a custom field via item/field paths', async () => {
    const { BitwardenBackend } = await import('../../src/lib/secretBackends/bitwarden.js');
    const backend = new BitwardenBackend();

    itemStdout = JSON.stringify({
      id: 'x',
      name: 'aws-creds',
      login: { password: 'sekret' },
      fields: [{ name: 'access_key_id', value: 'AKIA-EXAMPLE' }],
    });

    const value = await backend.getSecret({
      name: 'AWS_KEY',
      backendPath: 'aws-creds/access_key_id',
    });

    expect(value).toBe('AKIA-EXAMPLE');
    const getItemCall = execFileMock.mock.calls.find(
      (call) => call[0] === 'bw' && Array.isArray(call[1]) && call[1][0] === 'get'
    );
    expect((getItemCall![1] as string[])).toEqual(['get', 'item', '--', 'aws-creds']);
  });
});
