/**
 * OnePasswordBackend getSecret argv + parsing tests.
 *
 * backendPath comes from a committed mappings file and is passed to `op read`.
 * These tests pin: the `--` end-of-options separator + `--no-newline` flag, the
 * leading-dash injection guard, the op:// requirement / default-vault synthesis,
 * "no path" and "not found" handling, and the stdout pass-through. The op binary
 * is fully mocked — no real 1Password CLI is invoked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretBackendError } from '../../src/errors.js';

const execFileMock = vi.fn();

// Per-test control over what the mocked `op` returns.
let opStdout = 'sekret';
let opError: Error | null = null;

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    execFileMock(...args.slice(0, -1));
    if (opError) {
      callback(opError, { stdout: '', stderr: '' });
      return;
    }
    callback(null, { stdout: opStdout, stderr: '' });
  },
}));

const getReadCall = () =>
  execFileMock.mock.calls.find(
    (call) => call[0] === 'op' && Array.isArray(call[1]) && call[1][0] === 'read'
  );

describe('OnePasswordBackend.getSecret', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    opStdout = 'sekret';
    opError = null;
  });

  it('reads an op:// reference with --no-newline and a -- separator before the path', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    const value = await backend.getSecret({
      name: 'GITHUB_TOKEN',
      backendPath: 'op://Personal/GitHub/password',
    });
    expect(value).toBe('sekret');

    const argv = getReadCall()![1] as string[];
    expect(argv).toEqual(['read', '--no-newline', '--', 'op://Personal/GitHub/password']);
    // The separator immediately precedes the user-controlled path.
    expect(argv.indexOf('--')).toBe(argv.indexOf('op://Personal/GitHub/password') - 1);
  });

  it('throws (before running op) when no backendPath is configured', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    await expect(backend.getSecret({ name: 'GITHUB_TOKEN' })).rejects.toBeInstanceOf(
      SecretBackendError
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects a backendPath that starts with a dash (flag injection)', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    await expect(
      backend.getSecret({ name: 'X', backendPath: '--force' })
    ).rejects.toBeInstanceOf(SecretBackendError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('synthesizes an op:// path from a bare item using the default vault', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend({ vault: 'Work' });

    await backend.getSecret({ name: 'TOKEN', backendPath: 'GitHub/password' });

    const argv = getReadCall()![1] as string[];
    expect(argv).toEqual(['read', '--no-newline', '--', 'op://Work/GitHub/password']);
  });

  it('throws when a non-op:// path is given and no default vault is set', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    await expect(
      backend.getSecret({ name: 'TOKEN', backendPath: 'GitHub/password' })
    ).rejects.toBeInstanceOf(SecretBackendError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns null when op reports the item was not found', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    opError = new Error('op: item could not be found');
    const value = await backend.getSecret({
      name: 'TOKEN',
      backendPath: 'op://Personal/Ghost/password',
    });
    expect(value).toBeNull();
  });

  it('wraps other op failures in a SecretBackendError', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    opError = new Error('network unreachable');
    await expect(
      backend.getSecret({ name: 'TOKEN', backendPath: 'op://Personal/Item/password' })
    ).rejects.toBeInstanceOf(SecretBackendError);
  });

  it('returns the raw stdout (op --no-newline already trims the trailing newline)', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    opStdout = 'value-with-no-newline';
    const value = await backend.getSecret({
      name: 'TOKEN',
      backendPath: 'op://Personal/Item/password',
    });
    expect(value).toBe('value-with-no-newline');
  });
});

describe('OnePasswordBackend metadata + helpers', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    opStdout = 'sekret';
    opError = null;
  });

  it('exposes its identity', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();
    expect(backend.name).toBe('1password');
    expect(backend.displayName).toBe('1Password');
    expect(backend.cliName).toBe('op');
  });

  it('isAvailable is true when `op --version` succeeds, false when it throws', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    expect(await backend.isAvailable()).toBe(true);
    const versionCall = execFileMock.mock.calls.find(
      (c) => c[0] === 'op' && (c[1] as string[])[0] === '--version'
    );
    expect(versionCall).toBeDefined();

    opError = new Error('command not found: op');
    expect(await backend.isAvailable()).toBe(false);
  });

  it('listVaults parses the JSON vault list and returns names', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    opStdout = JSON.stringify([{ name: 'Personal' }, { name: 'Work' }]);
    expect(await backend.listVaults()).toEqual(['Personal', 'Work']);
  });

  it('listVaults returns [] when op fails', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();

    opError = new Error('not signed in');
    expect(await backend.listVaults()).toEqual([]);
  });

  it('getSetupInstructions documents the op:// path format', async () => {
    const { OnePasswordBackend } = await import('../../src/lib/secretBackends/onepassword.js');
    const backend = new OnePasswordBackend();
    expect(backend.getSetupInstructions()).toContain('op://vault-name/item-name/field-name');
  });
});
