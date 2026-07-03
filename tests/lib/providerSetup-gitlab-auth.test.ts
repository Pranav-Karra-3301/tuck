/**
 * Self-hosted GitLab auth argv regression test.
 *
 * `glab auth login` selects a host with `--hostname` (no short form); `-h` is
 * the inherited `--help` shorthand, so `glab auth login --web -h <host>` printed
 * help and exited 0 WITHOUT authenticating, dead-ending self-hosted setup with
 * "Authentication may have failed." forever. This drives setupProvider('gitlab')
 * through the self-hosted auth path and asserts the exact glab argv.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();
const textMock = vi.fn();
const confirmMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    select: selectMock,
    text: textMock,
    confirm: confirmMock,
    note: vi.fn(),
    cancel: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
  },
  colors: { dim: (x: string) => x, brand: (x: string) => x, bold: (x: string) => x },
}));

// Only the initial getProvider('gitlab') stub matters; the self-hosted branch
// replaces it with a real GitLabProvider.forHost(host), which is NOT mocked.
vi.mock('../../src/lib/providers/index.js', () => ({
  getProviderOptions: vi.fn(() => []),
  getProvider: vi.fn(() => ({ mode: 'gitlab' })),
  buildRemoteConfig: vi.fn((mode: string, extra?: Record<string, unknown>) => ({ mode, ...extra })),
}));

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));

describe('setupProvider (self-hosted GitLab auth)', () => {
  let authLoginArgs: string[] | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    authLoginArgs = undefined;
    let authenticated = false;

    // Stateful glab CLI simulation: unauthenticated until `auth login` runs.
    execFileMock.mockImplementation((cmd, args, optsOrCb, maybeCb) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      const a = (args as string[]) ?? [];

      if (cmd === 'glab' && a[0] === '--version') {
        return cb?.(null, { stdout: 'glab 1.106.0', stderr: '' });
      }
      if (cmd === 'glab' && a[0] === 'auth' && a[1] === 'status') {
        return cb?.(null, {
          stdout: '',
          stderr: authenticated ? 'Logged in to gitlab.example.com as user' : 'Not logged in',
        });
      }
      if (cmd === 'glab' && a[0] === 'auth' && a[1] === 'login') {
        authLoginArgs = a;
        authenticated = true;
        return cb?.(null, { stdout: '', stderr: '' });
      }
      if (cmd === 'glab' && a[0] === 'api' && a[1] === 'user') {
        return cb?.(null, { stdout: JSON.stringify({ username: 'user', name: 'User' }), stderr: '' });
      }
      return cb?.(null, { stdout: '', stderr: '' });
    });

    selectMock
      .mockResolvedValueOnce('self-hosted') // Which GitLab instance?
      .mockResolvedValueOnce('auth'); // Would you like to authenticate now?
    textMock.mockResolvedValueOnce('gitlab.example.com'); // Enter your GitLab host
    confirmMock.mockResolvedValue(true); // Use GitLab account @user?
  });

  it('passes --hostname (never -h) to glab auth login for a self-hosted instance', async () => {
    const { setupProvider } = await import('../../src/lib/providerSetup.js');
    const result = await setupProvider('gitlab');

    expect(result?.mode).toBe('gitlab');
    expect(authLoginArgs).toEqual([
      'auth',
      'login',
      '--web',
      '--hostname',
      'gitlab.example.com',
    ]);
    expect(authLoginArgs).not.toContain('-h');
  });
});
