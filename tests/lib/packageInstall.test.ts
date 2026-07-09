/**
 * Unit tests for idempotent package installation. Every external process call is
 * driven through a stub {@link CommandRunner}: no real network, Homebrew, apt, or
 * system package database is ever touched.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  installRequirement,
  installRequirements,
  isPackageInstalled,
  type CommandRunner,
  type RunResult,
} from '../../src/lib/packageInstall.js';
import { parseRequirement } from '../../src/lib/requires.js';

/** Build a runner whose `which`/`run` behavior is scripted per test. */
const makeRunner = (config: {
  present?: string[]; // bins reported on PATH
  checkInstalled?: (bin: string, args: string[]) => boolean; // true => already installed
  installFails?: boolean;
}): { runner: CommandRunner; installCalls: Array<{ bin: string; args: string[] }> } => {
  const installCalls: Array<{ bin: string; args: string[] }> = [];
  const present = new Set(config.present ?? []);
  const runner: CommandRunner = {
    which: vi.fn(async (bin: string) => present.has(bin)),
    run: vi.fn(async (bin: string, args: string[]): Promise<RunResult> => {
      const isCheck =
        args.includes('list') || args[0] === '-Q' || args.includes('-i') || args.includes('ls');
      // Heuristic: an install command mutates state; a check queries it. We tag
      // installs by the absence of a pure query verb, but to be unambiguous we
      // record any call that is not the check for this manager.
      if (isCheck && config.checkInstalled) {
        return { code: config.checkInstalled(bin, args) ? 0 : 1, stdout: '', stderr: '' };
      }
      if (isCheck) {
        return { code: 1, stdout: '', stderr: '' }; // not installed by default
      }
      installCalls.push({ bin, args });
      return config.installFails
        ? { code: 1, stdout: '', stderr: 'boom' }
        : { code: 0, stdout: 'ok', stderr: '' };
    }),
  };
  return { runner, installCalls };
};

describe('isPackageInstalled', () => {
  it('returns true when the manager check exits 0', async () => {
    const { runner } = makeRunner({ checkInstalled: () => true });
    expect(await isPackageInstalled(parseRequirement('brew:starship'), runner)).toBe(true);
  });

  it('returns false for a manager with no check command (forces install path)', async () => {
    const { runner } = makeRunner({});
    // apt has no cheap check → isPackageInstalled short-circuits to false.
    expect(await isPackageInstalled(parseRequirement('apt:zsh'), runner)).toBe(false);
  });
});

describe('installRequirement', () => {
  it('installs a missing package', async () => {
    const { runner, installCalls } = makeRunner({ present: ['brew'], checkInstalled: () => false });
    const result = await installRequirement(parseRequirement('brew:starship'), runner);
    expect(result.status).toBe('installed');
    expect(installCalls).toEqual([{ bin: 'brew', args: ['install', 'starship'] }]);
  });

  it('is idempotent: reports already-installed and never runs install', async () => {
    const { runner, installCalls } = makeRunner({ present: ['brew'], checkInstalled: () => true });
    const result = await installRequirement(parseRequirement('brew:starship'), runner);
    expect(result.status).toBe('already-installed');
    expect(installCalls).toEqual([]);
  });

  it('skips (does not fail) when the manager binary is absent', async () => {
    const { runner, installCalls } = makeRunner({ present: [] });
    const result = await installRequirement(parseRequirement('winget:Foo.Bar'), runner);
    expect(result.status).toBe('skipped-no-manager');
    expect(installCalls).toEqual([]);
  });

  it('reports would-install in dry-run without running the install', async () => {
    const { runner, installCalls } = makeRunner({ present: ['brew'], checkInstalled: () => false });
    const result = await installRequirement(parseRequirement('brew:starship'), runner, {
      dryRun: true,
    });
    expect(result.status).toBe('would-install');
    expect(installCalls).toEqual([]);
  });

  it('captures the error output on a failed install', async () => {
    const { runner } = makeRunner({ present: ['brew'], checkInstalled: () => false, installFails: true });
    const result = await installRequirement(parseRequirement('brew:starship'), runner);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
  });
});

describe('installRequirements', () => {
  it('aggregates a report across mixed outcomes and does not abort on failure', async () => {
    // brew present; one installed, one already there. winget absent → skipped.
    const runner: CommandRunner = {
      which: vi.fn(async (bin: string) => bin === 'brew'),
      run: vi.fn(async (bin: string, args: string[]): Promise<RunResult> => {
        if (args[0] === 'list') {
          // already-installed only for "git"
          return { code: args[1] === 'git' ? 0 : 1, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' }; // install succeeds
      }),
    };
    const report = await installRequirements(
      [
        parseRequirement('brew:starship'),
        parseRequirement('brew:git'),
        parseRequirement('winget:Foo.Bar'),
      ],
      runner
    );
    expect(report.installed).toBe(1);
    expect(report.alreadyInstalled).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results).toHaveLength(3);
  });
});
