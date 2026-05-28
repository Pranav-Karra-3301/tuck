/**
 * context apply safety unit tests.
 *
 * `tuck context apply <user/repo>` clones an UNTRUSTED remote and writes files
 * from its context.json into the user's home. Every write target must be
 * validated to stay inside $HOME, and every read source must stay inside the
 * clone dir, BEFORE any directory is created.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { Command } from 'commander';
import { assertContextWriteSafe } from '../../src/commands/context.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

// The apply/list/add actions write through the UI layer; mock it so no clack
// prompt or colored output leaks into the test runner. confirm() defaults to
// true (consent granted) for the github branch, though the local-dir import
// path under test does not reach it.
vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    note: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    multiselect: vi.fn(),
    cancel: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    yellow: (x: string) => x,
    dim: (x: string) => x,
    bold: (x: string) => x,
    green: (x: string) => x,
    cyan: (x: string) => x,
    red: (x: string) => x,
  },
}));

const CLONE = '/test-home/.tuck/.tmp-context/u-r';

describe('assertContextWriteSafe', () => {
  it('accepts a home-scoped write with an in-clone source', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, {
        source: '~/.claude/CLAUDE.md',
        destination: 'context/claude/CLAUDE.md',
      })
    ).not.toThrow();
  });

  it('rejects a write target that escapes $HOME (absolute)', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, { source: '/etc/cron.d/evil', destination: 'context/x' })
    ).toThrow();
  });

  it('rejects a write target that escapes $HOME via ..', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, { source: '~/../../tmp/evil', destination: 'context/x' })
    ).toThrow();
  });

  it('rejects a read source that escapes the clone dir', () => {
    expect(() =>
      assertContextWriteSafe(CLONE, {
        source: '~/.config/ok',
        destination: '../../../../etc/passwd',
      })
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// importContextFromDir — driven via the `apply <local-dir>` subcommand, which
// (when the ref is an existing local path) skips the github clone/consent gate
// and imports straight from the directory. This exercises the new zod
// validation + per-entry assertContextWriteSafe guard + resolveWriteTarget.
// ─────────────────────────────────────────────────────────────────────────────

const runApply = async (ref: string): Promise<void> => {
  // The action throws are surfaced as rejected promises through Commander.
  const { contextCommand } = await import('../../src/commands/context.js');
  const program = new Command('tuck');
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.addCommand(contextCommand);
  await program.parseAsync(['node', 'tuck', 'context', 'apply', ref]);
};

const APPLY_SRC = '/srcrepo';

const validEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: '~/.claude/CLAUDE.md',
  destination: 'context/home/claude-claude.md',
  scope: 'home',
  agent: 'claude',
  added: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z',
  checksum: 'deadbeef',
  ...over,
});

describe('importContextFromDir (via context apply <dir>)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    vol.mkdirSync(APPLY_SRC, { recursive: true });
  });

  it('materializes a valid home-scoped entry into the home write target', async () => {
    const ctx = {
      version: '1',
      entries: { 'home__.claude-claude.md': validEntry() },
    };
    vol.writeFileSync(join(APPLY_SRC, 'context.json'), JSON.stringify(ctx));
    // The payload the manifest points at (cloneDir/entry.destination).
    vol.mkdirSync(join(APPLY_SRC, 'context', 'home'), { recursive: true });
    vol.writeFileSync(join(APPLY_SRC, 'context', 'home', 'claude-claude.md'), '# CLAUDE\n');

    await runApply(APPLY_SRC);

    // resolveWriteTarget('~/.claude/CLAUDE.md') -> /test-home/.claude/CLAUDE.md
    const dest = join(TEST_HOME, '.claude', 'CLAUDE.md');
    expect(vol.existsSync(dest)).toBe(true);
    expect(vol.readFileSync(dest, 'utf-8')).toBe('# CLAUDE\n');
  });

  it('throws INVALID_CONTEXT_MANIFEST on a malformed context.json', async () => {
    // Wrong shape: version literal mismatch + entries not matching the schema.
    const bad = { version: '99', entries: { x: { source: 5 } } };
    vol.writeFileSync(join(APPLY_SRC, 'context.json'), JSON.stringify(bad));

    await expect(runApply(APPLY_SRC)).rejects.toThrow(/Invalid context\.json/);
  });

  it('throws NO_CONTEXT_MANIFEST when context.json is absent', async () => {
    await expect(runApply(APPLY_SRC)).rejects.toThrow(/No context\.json found/);
  });

  it('rejects a home entry whose source escapes $HOME, writing nothing', async () => {
    const ctx = {
      version: '1',
      entries: {
        evil: validEntry({ source: '/etc/cron.d/evil', destination: 'context/home/evil' }),
      },
    };
    vol.writeFileSync(join(APPLY_SRC, 'context.json'), JSON.stringify(ctx));
    vol.mkdirSync(join(APPLY_SRC, 'context', 'home'), { recursive: true });
    vol.writeFileSync(join(APPLY_SRC, 'context', 'home', 'evil'), 'PWNED');

    await expect(runApply(APPLY_SRC)).rejects.toThrow();

    // The hostile absolute target must never have been created.
    expect(vol.existsSync('/etc/cron.d/evil')).toBe(false);
  });

  it('rejects an entry whose read source escapes the clone dir, writing nothing', async () => {
    const ctx = {
      version: '1',
      entries: {
        evil: validEntry({
          source: '~/.config/ok',
          destination: '../../../../etc/passwd',
        }),
      },
    };
    vol.writeFileSync(join(APPLY_SRC, 'context.json'), JSON.stringify(ctx));

    await expect(runApply(APPLY_SRC)).rejects.toThrow();

    // Nothing should have been planted at the would-be home target either.
    expect(vol.existsSync(join(TEST_HOME, '.config', 'ok'))).toBe(false);
  });

  it('skips repo-scoped entries during import (home-only materialization)', async () => {
    const ctx = {
      version: '1',
      entries: {
        repoEntry: validEntry({
          scope: 'repo',
          repoRoot: '/some/repo',
          source: '/some/repo/CLAUDE.md',
          destination: 'context/repos/r/claude.md',
        }),
      },
    };
    vol.writeFileSync(join(APPLY_SRC, 'context.json'), JSON.stringify(ctx));
    vol.mkdirSync(join(APPLY_SRC, 'context', 'repos', 'r'), { recursive: true });
    vol.writeFileSync(join(APPLY_SRC, 'context', 'repos', 'r', 'claude.md'), 'REPO');

    // Should succeed (valid manifest) but write nothing to home.
    await runApply(APPLY_SRC);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON envelope shape for `context list` and `context add`.
// ─────────────────────────────────────────────────────────────────────────────

const writeBaseManifest = (): void => {
  // Minimal valid .tuckmanifest.json so ensureInitialized() passes.
  vol.writeFileSync(
    join(TEST_TUCK_DIR, '.tuckmanifest.json'),
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: {},
    })
  );
};

const captureStdout = (): { writes: string[]; restore: () => void } => {
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
  return { writes, restore: () => spy.mockRestore() };
};

const runContext = async (...args: string[]): Promise<void> => {
  const { contextCommand } = await import('../../src/commands/context.js');
  const { clearManifestCache } = await import('../../src/lib/manifest.js');
  clearManifestCache();
  const program = new Command('tuck');
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.addCommand(contextCommand);
  await program.parseAsync(['node', 'tuck', 'context', ...args]);
};

describe('context list/add --json envelope', () => {
  beforeEach(async () => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    const { __resetJsonEmitState, setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
    __resetJsonEmitState();
  });

  it('list --json emits an ok envelope with count and entries on an empty manifest', async () => {
    writeBaseManifest();
    const { writes, restore } = captureStdout();
    try {
      await runContext('list', '--json');
    } finally {
      restore();
    }
    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck context list');
    expect(env.data.count).toBe(0);
    expect(env.data.entries).toEqual([]);
  });

  it('add --json emits an ok envelope describing the tracked entry', async () => {
    writeBaseManifest();
    // A home-scoped agent config that lives outside any git tree.
    vol.mkdirSync(join(TEST_HOME, '.claude'), { recursive: true });
    vol.writeFileSync(join(TEST_HOME, '.claude', 'CLAUDE.md'), '# global\n');

    const { writes, restore } = captureStdout();
    try {
      await runContext('add', join(TEST_HOME, '.claude', 'CLAUDE.md'), '--json');
    } finally {
      restore();
    }

    const env = JSON.parse(writes.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck context add');
    expect(env.data.scope).toBe('home');
    expect(env.data.agent).toBe('claude');
    expect(env.data.source).toBe('~/.claude/CLAUDE.md');
    expect(env.data.id).toMatch(/^home__/);
    // The destination is the in-repo bundle key under context/home.
    expect(env.data.destination).toMatch(/^context\/home\//);
  });

  it('list --json reflects an entry after add, with the same id and shape', async () => {
    writeBaseManifest();
    vol.mkdirSync(join(TEST_HOME, '.claude'), { recursive: true });
    vol.writeFileSync(join(TEST_HOME, '.claude', 'CLAUDE.md'), '# global\n');

    // First add.
    let cap = captureStdout();
    try {
      await runContext('add', join(TEST_HOME, '.claude', 'CLAUDE.md'), '--json');
    } finally {
      cap.restore();
    }
    const addEnv = JSON.parse(cap.writes.join('').trim());

    // Then list.
    cap = captureStdout();
    try {
      await runContext('list', '--json');
    } finally {
      cap.restore();
    }
    const listEnv = JSON.parse(cap.writes.join('').trim());

    expect(listEnv.data.count).toBe(1);
    expect(listEnv.data.entries).toHaveLength(1);
    expect(listEnv.data.entries[0].id).toBe(addEnv.data.id);
    expect(listEnv.data.entries[0].agent).toBe('claude');
    expect(listEnv.data.entries[0].scope).toBe('home');
  });
});
