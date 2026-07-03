/**
 * pass gpgId injection regression test.
 *
 * gpgId comes from the committed .tuckrc.json and is embedded into
 * PASSWORD_STORE_GPG_OPTS, which `pass` word-splits into extra gpg argv. A value
 * with whitespace or a leading dash could inject arbitrary gpg options (e.g.
 * `--output <path>`), so it must be validated before use — mirroring the
 * leading-dash guard already applied to backendPath.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretBackendError } from '../../src/errors.js';

const execFileMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    execFileMock(...args.slice(0, -1));
    callback(null, { stdout: 'mypassword\n', stderr: '' });
  },
}));

describe('PassBackend gpgId validation', () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });

  it('throws instead of running pass when gpgId contains injected gpg options', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend({ gpgId: 'AAAA --output /home/victim/pwned' });

    await expect(
      backend.getSecret({ name: 'GITHUB_TOKEN', backendPath: 'github/token' })
    ).rejects.toBeInstanceOf(SecretBackendError);

    // The guard fires BEFORE pass is ever invoked.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects a gpgId that starts with a dash', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend({ gpgId: '-oProxyCommand=evil' });

    await expect(
      backend.getSecret({ name: 'X', backendPath: 'github/token' })
    ).rejects.toBeInstanceOf(SecretBackendError);
  });

  it('accepts a normal key id / email and resolves the secret', async () => {
    const { PassBackend } = await import('../../src/lib/secretBackends/pass.js');
    const backend = new PassBackend({ gpgId: 'user@example.com' });

    const value = await backend.getSecret({ name: 'X', backendPath: 'github/token' });
    expect(value).toBe('mypassword');
    expect(execFileMock).toHaveBeenCalled();
  });
});
