/**
 * `tuck repo` command tests.
 *
 * `tuck repo` manages the MACHINE-LOCAL repoKey -> root bindings (repos.json,
 * off-repo under the state dir). These are the bindings that let a committed,
 * machine-independent repo-scoped manifest entry resolve to a concrete absolute
 * path on THIS machine.
 *
 *   repo link <repoKey> <path>  — verify path exists + is a git repo, then bind
 *   repo list                   — show all bindings
 *   repo unlink <repoKey>       — remove a binding
 *
 * link MUST refuse a non-existent path and a path that is not inside a git repo
 * (never bind a key to a phantom or non-repo root).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';

// Silence UI noise (banners/logs/colors). The command's behaviour is observed
// via the registry on disk and via the --json envelope on stdout.
vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    dim: vi.fn(),
    error: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    cyan: (x: string) => x,
    dim: (x: string) => x,
    bold: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
    red: (x: string) => x,
  },
}));

import { resolveRepoRoot, loadReposRegistry } from '../../src/lib/repoScope.js';

/** Stage a directory in memfs that looks like a git repo root (has .git). */
const stageGitRepo = (root: string): void => {
  vol.mkdirSync(root, { recursive: true });
  vol.mkdirSync(`${root}/.git`, { recursive: true });
  vol.writeFileSync(`${root}/.git/HEAD`, 'ref: refs/heads/main\n');
};

/** Stage a plain directory that is NOT a git repo. */
const stagePlainDir = (root: string): void => {
  vol.mkdirSync(root, { recursive: true });
};

const runRepo = async (args: string[]): Promise<void> => {
  const { repoCommand } = await import('../../src/commands/repo.js');
  await repoCommand.parseAsync(['node', 'tuck', ...args]);
};

describe('tuck repo', () => {
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vol.reset();
    vol.mkdirSync('/test-home', { recursive: true });
    const { setJsonMode, __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
    __resetJsonEmitState();
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
  });

  const jsonEnvelope = (): { ok: boolean; command: string; data?: any; error?: any } => {
    const jsonLine = writes.find((w) => w.trim().startsWith('{'));
    return JSON.parse((jsonLine ?? writes.join('')).trim());
  };

  describe('link', () => {
    it('binds a repoKey to a git repo root and resolveRepoRoot returns it', async () => {
      stageGitRepo('/srv/proj');

      await runRepo(['link', 'proj-abcd1234', '/srv/proj', '--json']);

      expect(await resolveRepoRoot('proj-abcd1234')).toBe('/srv/proj');

      const env = jsonEnvelope();
      expect(env.ok).toBe(true);
      expect(env.command).toBe('tuck repo link');
      expect(env.data.repoKey).toBe('proj-abcd1234');
      expect(env.data.root).toBe('/srv/proj');
    });

    it('binds when given a subdirectory of a git repo (findGitRoot walks up)', async () => {
      stageGitRepo('/srv/proj');
      vol.mkdirSync('/srv/proj/src/deep', { recursive: true });

      await runRepo(['link', 'proj-deep', '/srv/proj/src/deep']);

      // It binds to the discovered repo ROOT, not the subdirectory.
      expect(await resolveRepoRoot('proj-deep')).toBe('/srv/proj');
    });

    it('rejects a non-existent path and binds nothing', async () => {
      await expect(runRepo(['link', 'ghost', '/does/not/exist', '--json'])).rejects.toThrow();

      expect(await resolveRepoRoot('ghost')).toBeNull();
    });

    it('rejects a path that is not inside a git repo and binds nothing', async () => {
      stagePlainDir('/srv/plain');

      await expect(runRepo(['link', 'plain', '/srv/plain', '--json'])).rejects.toThrow();

      expect(await resolveRepoRoot('plain')).toBeNull();
    });
  });

  describe('list', () => {
    it('lists all bindings in the --json envelope', async () => {
      stageGitRepo('/srv/a');
      stageGitRepo('/srv/b');
      await runRepo(['link', 'key-a', '/srv/a']);
      await runRepo(['link', 'key-b', '/srv/b']);

      writes = [];
      const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
      __resetJsonEmitState();

      await runRepo(['list', '--json']);

      const env = jsonEnvelope();
      expect(env.ok).toBe(true);
      expect(env.command).toBe('tuck repo list');
      const keys = env.data.repos.map((r: { repoKey: string }) => r.repoKey).sort();
      expect(keys).toEqual(['key-a', 'key-b']);
      const a = env.data.repos.find((r: { repoKey: string }) => r.repoKey === 'key-a');
      expect(a.root).toBe('/srv/a');
    });

    it('returns an empty repos list when nothing is bound', async () => {
      await runRepo(['list', '--json']);
      const env = jsonEnvelope();
      expect(env.ok).toBe(true);
      expect(env.data.repos).toEqual([]);
    });
  });

  describe('unlink', () => {
    it('removes a binding so resolveRepoRoot returns null', async () => {
      stageGitRepo('/srv/proj');
      await runRepo(['link', 'rm-me', '/srv/proj']);
      expect(await resolveRepoRoot('rm-me')).toBe('/srv/proj');

      writes = [];
      const { __resetJsonEmitState } = await import('../../src/lib/jsonOutput.js');
      __resetJsonEmitState();

      await runRepo(['unlink', 'rm-me', '--json']);

      expect(await resolveRepoRoot('rm-me')).toBeNull();
      const reg = await loadReposRegistry();
      expect('rm-me' in reg.repos).toBe(false);

      const env = jsonEnvelope();
      expect(env.ok).toBe(true);
      expect(env.command).toBe('tuck repo unlink');
      expect(env.data.repoKey).toBe('rm-me');
      expect(env.data.removed).toBe(true);
    });

    it('reports removed:false for an unknown key (no throw)', async () => {
      await runRepo(['unlink', 'never-bound', '--json']);
      const env = jsonEnvelope();
      expect(env.ok).toBe(true);
      expect(env.data.removed).toBe(false);
    });
  });
});
