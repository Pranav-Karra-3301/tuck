/**
 * tuck bootstrap tests.
 *
 * Fully sandboxed: $HOME is memfs (/test-home via setup.ts), the repo source is
 * a local directory (no network/git clone), package installation is driven
 * through a stub CommandRunner (no real Homebrew/apt), and the deep file-apply
 * step is stubbed (it is exercised exhaustively by the apply tests). This test
 * focuses on bootstrap's ORCHESTRATION: dependency gating, plan building,
 * idempotent package installation, and the combined report/JSON envelope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
import type { CommandRunner, RunResult } from '../../src/lib/packageInstall.js';
import { __resetJsonEmitState } from '../../src/lib/jsonOutput.js';

// Silence the terminal UI (also avoids clack touching a non-TTY stdin).
vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  colors: { yellow: (x: string) => x, dim: (x: string) => x, green: (x: string) => x },
}));

// Stub only the deep apply step + secret restore; keep resolveSource /
// cloneSource / readClonedManifest REAL so the local-source → clone → manifest →
// plan path is genuinely exercised.
const applyRepoDirMock = vi.fn();
vi.mock('../../src/commands/apply.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/commands/apply.js')>();
  return {
    ...actual,
    applyRepoDir: applyRepoDirMock,
    tryRestoreSecretsFromLocalStore: vi.fn().mockResolvedValue({ restored: 0, unresolved: [] }),
  };
});

// Doctor is read-only; make it deterministic here.
// Inline async impl (not mockResolvedValue) so clearAllMocks can't wipe it.
vi.mock('../../src/lib/doctor.js', () => ({
  runDoctorChecks: vi.fn(async () => ({ summary: { passed: 3, warnings: 1, failed: 0 }, checks: [] })),
}));

const REPO_DIR = `${TEST_HOME}/dots`;

/** Write a local "dotfiles repo" into memfs with the given manifest. */
const writeRepo = (manifest: unknown): void => {
  vol.mkdirSync(join(REPO_DIR, 'files', 'shell'), { recursive: true });
  vol.writeFileSync(join(REPO_DIR, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
  vol.writeFileSync(join(REPO_DIR, 'files', 'shell', 'zshrc'), 'export OK=1');
};

/** A scripted runner: which(bin)∈present, package checks reported via installed. */
const makeRunner = (opts: {
  present: string[];
  installed?: string[]; // "<manager>:<pkg>" already-present
}): { runner: CommandRunner; installCalls: string[] } => {
  const present = new Set(opts.present);
  const installed = new Set(opts.installed ?? []);
  const installCalls: string[] = [];
  const runner: CommandRunner = {
    which: vi.fn(async (bin: string) => present.has(bin)),
    run: vi.fn(async (bin: string, args: string[]): Promise<RunResult> => {
      if (args[0] === 'list') {
        // brew list <pkg> — 0 when already installed.
        return { code: installed.has(`brew:${args[1]}`) ? 0 : 1, stdout: '', stderr: '' };
      }
      installCalls.push(`${bin} ${args.join(' ')}`);
      return { code: 0, stdout: 'ok', stderr: '' };
    }),
  };
  return { runner, installCalls };
};

let runBootstrap: typeof import('../../src/commands/bootstrap.js').runBootstrap;

beforeEach(async () => {
  vi.clearAllMocks();
  vol.reset();
  __resetJsonEmitState();
  vol.mkdirSync(TEST_HOME, { recursive: true });
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  applyRepoDirMock.mockResolvedValue({
    applied: 1,
    skipped: [],
    filesWithPlaceholders: [],
    unsafe: [],
    strategy: 'merge',
  });
  ({ runBootstrap } = await import('../../src/commands/bootstrap.js'));
});

afterEach(() => {
  vol.reset();
});

describe('runBootstrap', () => {
  it('fails fast when git is not available', async () => {
    writeRepo(createMockManifest({ files: { z: createMockTrackedFile({ source: '~/.zshrc' }) } }));
    const { runner } = makeRunner({ present: [] }); // no git
    await expect(
      runBootstrap(REPO_DIR, { yes: true, skipDoctor: true }, { runner })
    ).rejects.toThrow(/git is required/);
  });

  it('installs declared packages then applies dotfiles (happy path)', async () => {
    writeRepo(
      createMockManifest({
        files: {
          z: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }),
        },
      })
    );
    const { runner, installCalls } = makeRunner({ present: ['git', 'brew'] });

    const report = await runBootstrap(REPO_DIR, { yes: true, skipDoctor: true }, { runner });

    expect(installCalls).toEqual(['brew install starship']);
    expect(report.packages.installed).toBe(1);
    expect(report.applied).toBe(1);
    expect(applyRepoDirMock).toHaveBeenCalledOnce();
    expect(report.plan.packages.map((p) => p.raw)).toEqual(['brew:starship']);
  });

  it('is idempotent: an already-installed package is not reinstalled on re-run', async () => {
    writeRepo(
      createMockManifest({
        files: { z: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }) },
      })
    );
    const { runner, installCalls } = makeRunner({
      present: ['git', 'brew'],
      installed: ['brew:starship'],
    });

    const report = await runBootstrap(REPO_DIR, { yes: true, skipDoctor: true }, { runner });

    expect(installCalls).toEqual([]); // never runs `brew install`
    expect(report.packages.alreadyInstalled).toBe(1);
    expect(report.packages.installed).toBe(0);
  });

  it('skips (does not fail) a package whose manager is unavailable', async () => {
    writeRepo(
      createMockManifest({
        files: { z: createMockTrackedFile({ source: '~/.zshrc', requires: ['winget:Foo.Bar'] }) },
      })
    );
    const { runner } = makeRunner({ present: ['git'] }); // no winget

    const report = await runBootstrap(REPO_DIR, { yes: true, skipDoctor: true }, { runner });
    expect(report.packages.skipped).toBe(1);
    expect(report.packages.failed).toBe(0);
  });

  it('dry-run installs nothing and does not apply', async () => {
    writeRepo(
      createMockManifest({
        files: { z: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }) },
      })
    );
    const { runner, installCalls } = makeRunner({ present: ['git', 'brew'] });

    const report = await runBootstrap(REPO_DIR, { dryRun: true }, { runner });

    expect(installCalls).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.packages.wouldInstall).toBe(1);
    // apply still runs in dry-run mode; first arg is the temp clone dir, second
    // is the original source, and it receives dryRun:true.
    expect(applyRepoDirMock).toHaveBeenCalledWith(
      expect.any(String),
      REPO_DIR,
      expect.objectContaining({ dryRun: true })
    );
  });

  it('--skip-packages bypasses the install phase', async () => {
    writeRepo(
      createMockManifest({
        files: { z: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }) },
      })
    );
    const { runner, installCalls } = makeRunner({ present: ['git', 'brew'] });

    const report = await runBootstrap(
      REPO_DIR,
      { yes: true, skipPackages: true, skipDoctor: true },
      { runner }
    );
    expect(installCalls).toEqual([]);
    expect(report.packages.skippedPhase).toBe(true);
  });

  it('runs doctor and includes its summary when not skipped', async () => {
    writeRepo(createMockManifest({ files: { z: createMockTrackedFile({ source: '~/.zshrc' }) } }));
    const { runner } = makeRunner({ present: ['git'] });

    const report = await runBootstrap(REPO_DIR, { yes: true }, { runner });
    expect(report.doctor).toEqual({ passed: 3, warnings: 1, failed: 0, skipped: false });
  });

  it('emits a single JSON envelope in --json mode', async () => {
    writeRepo(
      createMockManifest({
        files: { z: createMockTrackedFile({ source: '~/.zshrc', requires: ['brew:starship'] }) },
      })
    );
    const { runner } = makeRunner({ present: ['git', 'brew'] });

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        writes.push(String(c));
        return true;
      });

    await runBootstrap(REPO_DIR, { json: true, skipDoctor: true }, { runner });
    spy.mockRestore();

    const envelopes = writes.filter((w) => w.trim().startsWith('{'));
    expect(envelopes).toHaveLength(1);
    const parsed = JSON.parse(envelopes[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('tuck bootstrap');
    expect(parsed.data.applied).toBe(1);
    expect(parsed.data.packages.installed).toBe(1);
  });

  it('fails with a typed error when the repo has no manifest', async () => {
    vol.mkdirSync(REPO_DIR, { recursive: true }); // empty repo, no .tuckmanifest.json
    const { runner } = makeRunner({ present: ['git'] });
    await expect(
      runBootstrap(REPO_DIR, { yes: true, skipDoctor: true }, { runner })
    ).rejects.toThrow(/no tuck manifest/i);
  });
});
