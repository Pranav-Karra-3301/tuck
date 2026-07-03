/**
 * PassBackend getSecret + listSecrets parsing tests.
 *
 * Complements pass-gpgid.test.ts (which covers the gpgId injection guard). Here
 * we pin the output parsing: first-line-only by default, full content for a
 * `/*` path, not-found → null vs GPG errors → throw, the empty-output null
 * distinction, the storePath env wiring, and the `pass ls` tree parser. The
 * pass binary is fully mocked — no real GPG or password store is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretBackendError } from '../../src/errors.js';

const execFileMock = vi.fn();
let passStdout = 'the-password\nsecond-line\n';
let passError: Error | null = null;

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    execFileMock(...args.slice(0, -1));
    if (passError) {
      callback(passError, { stdout: '', stderr: '' });
      return;
    }
    callback(null, { stdout: passStdout, stderr: '' });
  },
}));

const getShowCall = () =>
  execFileMock.mock.calls.find(
    (c) => c[0] === 'pass' && Array.isArray(c[1]) && c[1][0] === 'show'
  );

describe('PassBackend.getSecret', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    passStdout = 'the-password\nsecond-line\n';
    passError = null;
  });

  it('returns only the first line by default and passes -- before the path', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();

    const value = await backend.getSecret({ name: 'TOKEN', backendPath: 'work/token' });
    expect(value).toBe('the-password');

    const argv = getShowCall()![1] as string[];
    expect(argv).toEqual(['show', '--', 'work/token']);
  });

  it('returns the full trimmed content for a /* path', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();

    passStdout = 'line1\nline2\nline3\n';
    const value = await backend.getSecret({ name: 'MULTI', backendPath: 'work/multi/*' });
    expect(value).toBe('line1\nline2\nline3');
  });

  it('throws (before running pass) when no backendPath is configured', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();
    await expect(backend.getSecret({ name: 'TOKEN' })).rejects.toBeInstanceOf(
      SecretBackendError
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns null when the entry is not in the password store', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();

    passError = new Error('Error: work/ghost is not in the password store.');
    expect(await backend.getSecret({ name: 'X', backendPath: 'work/ghost' })).toBeNull();
  });

  it('wraps a GPG decryption failure in a SecretBackendError', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();

    passError = new Error('gpg: decryption failed: No secret key');
    await expect(
      backend.getSecret({ name: 'X', backendPath: 'work/token' })
    ).rejects.toBeInstanceOf(SecretBackendError);
  });

  it('distinguishes empty output (null) from an empty first line', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();

    // Truly empty output → null (no such secret content).
    passStdout = '';
    expect(await backend.getSecret({ name: 'X', backendPath: 'work/token' })).toBeNull();

    // A leading blank line → empty-string first line (an empty password), not null.
    passStdout = '\nmetadata\n';
    expect(await backend.getSecret({ name: 'X', backendPath: 'work/token' })).toBe('');
  });

  it('wires PASSWORD_STORE_DIR into the exec env when a storePath is configured', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend({ storePath: '/custom/store' });

    await backend.getSecret({ name: 'X', backendPath: 'work/token' });

    const opts = getShowCall()![2] as { env: Record<string, string> };
    expect(opts.env.PASSWORD_STORE_DIR).toBe('/custom/store');
  });
});

describe('PassBackend.listSecrets', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    passError = null;
  });

  it('parses the `pass ls` tree output into flat secret paths', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();

    passStdout = [
      'Password Store',
      '├── github',
      '│   └── token',
      '└── aws',
      '    └── access_key',
      '',
    ].join('\n');

    const secrets = await backend.listSecrets();
    const names = secrets.map((s) => s.name);
    // Header line and directory-only nodes are dropped; leaf entries survive.
    expect(names).toContain('token');
    expect(names).toContain('access_key');
    expect(names).not.toContain('Password Store');
  });

  it('returns [] when pass ls fails', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend();
    passError = new Error('store not initialized');
    expect(await backend.listSecrets()).toEqual([]);
  });
});
