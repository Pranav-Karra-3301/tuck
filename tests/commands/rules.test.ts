/**
 * `tuck rules` command integration tests.
 *
 * Drives the command through Commander against memfs (mocked in tests/setup.ts),
 * asserting the JSON envelope shape and the on-disk fan-out result end to end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { Command } from 'commander';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';
import { resetWriteContext } from '../../src/lib/writeContext.js';

// Silence the UI layer so no clack prompt / colored output leaks into the runner.
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

const runRules = async (...args: string[]): Promise<void> => {
  const { createRulesCommand } = await import('../../src/commands/rules.js');
  const program = new Command('tuck');
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  // A fresh command tree per run so Commander option state never leaks between
  // invocations within this file.
  program.addCommand(createRulesCommand());
  await program.parseAsync(['node', 'tuck', 'rules', ...args]);
};

const runJson = async (...args: string[]): Promise<Record<string, unknown>> => {
  const { writes, restore } = captureStdout();
  try {
    await runRules(...args, '--json');
  } finally {
    restore();
  }
  return JSON.parse(writes.join('').trim());
};

const writeBaseManifest = (): void => {
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

beforeEach(async () => {
  vol.reset();
  resetWriteContext();
  vol.mkdirSync(TEST_HOME, { recursive: true });
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  writeBaseManifest();
  const { clearManifestCache } = await import('../../src/lib/manifest.js');
  clearManifestCache();
  const { __resetJsonEmitState, setJsonMode } = await import('../../src/lib/jsonOutput.js');
  setJsonMode(false);
  __resetJsonEmitState();
});

afterEach(() => {
  resetWriteContext();
});

const AGENTS = `${TEST_HOME}/AGENTS.md`;

describe('tuck rules track --json', () => {
  it('tracks a home source and reports the set', async () => {
    vol.writeFileSync(AGENTS, '# Rules\n');
    const env = await runJson('track', AGENTS, '--tool', 'claude,gemini');
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck rules track');
    const data = env.data as Record<string, unknown>;
    expect(data.scope).toBe('home');
    expect(data.source).toBe('~/AGENTS.md');
    expect(data.id).toBe('home__agents.md');
    expect((data.tools as { tool: string }[]).map((t) => t.tool)).toEqual(['claude', 'gemini']);
  });

  it('rejects an unknown tool name', async () => {
    vol.writeFileSync(AGENTS, '# Rules\n');
    await expect(runRules('track', AGENTS, '--tool', 'bogus', '--json')).rejects.toThrow();
  });
});

describe('tuck rules apply --json', () => {
  beforeEach(() => {
    vol.writeFileSync(
      AGENTS,
      '# Rules\n{{#if tool == "cursor"}}CURSOR{{/if}}{{#if tool == "claude"}}CLAUDE{{/if}}\n'
    );
  });

  it('fans out variants with per-tool content', async () => {
    await runJson('track', AGENTS, '--tool', 'claude,cursor');
    const env = await runJson('apply', '--yes', '--force');
    expect(env.ok).toBe(true);
    const applied = (env.data as { applied: { tool: string; action: string }[] }).applied;
    expect(applied.map((a) => [a.tool, a.action])).toEqual([
      ['claude', 'created'],
      ['cursor', 'created'],
    ]);
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).toContain('CLAUDE');
    expect(vol.readFileSync(join(TEST_HOME, 'CLAUDE.md'), 'utf-8')).not.toContain('CURSOR');
    expect(vol.readFileSync(join(TEST_HOME, '.cursorrules'), 'utf-8')).toContain('CURSOR');
  });

  it('dry-run reports actions but writes nothing', async () => {
    await runJson('track', AGENTS, '--tool', 'claude');
    const env = await runJson('apply', '--dry-run', '--yes');
    expect((env.data as { dryRun: boolean }).dryRun).toBe(true);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(false);
  });

  it('reports an empty apply when nothing is tracked', async () => {
    const env = await runJson('apply', '--yes');
    expect(env.ok).toBe(true);
    expect((env.data as { applied: unknown[] }).applied).toEqual([]);
  });
});

describe('tuck rules list --json', () => {
  it('reports per-tool status transitioning to in-sync after apply', async () => {
    vol.writeFileSync(AGENTS, '# Rules\n');
    await runJson('track', AGENTS, '--tool', 'claude');

    let env = await runJson('list');
    let sets = (env.data as { sets: { tools: { status: string }[] }[] }).sets;
    expect(sets[0].tools[0].status).toBe('missing');

    await runJson('apply', '--yes', '--force');
    env = await runJson('list');
    sets = (env.data as { sets: { tools: { status: string }[] }[] }).sets;
    expect(sets[0].tools[0].status).toBe('in-sync');
  });
});

describe('tuck rules untrack --json', () => {
  it('removes a set and optionally cleans generated files', async () => {
    vol.writeFileSync(AGENTS, '# Rules\n');
    const track = await runJson('track', AGENTS, '--tool', 'claude');
    const id = (track.data as { id: string }).id;
    await runJson('apply', '--yes', '--force');
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(true);

    const env = await runJson('untrack', id, '--clean', '--yes');
    expect(env.ok).toBe(true);
    expect((env.data as { removed: boolean }).removed).toBe(true);
    expect(vol.existsSync(join(TEST_HOME, 'CLAUDE.md'))).toBe(false);

    const list = await runJson('list');
    expect((list.data as { count: number }).count).toBe(0);
  });

  it('errors on an unknown id', async () => {
    await expect(runRules('untrack', 'ghost', '--json')).rejects.toThrow();
  });
});
