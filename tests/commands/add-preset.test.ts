/**
 * `tuck add --preset <agent>` integration tests (IDEAS 1.2).
 *
 * Drive the real add pipeline against a sandboxed tuck repo + memfs home,
 * proving the two behaviours that matter: safe allowlisted files land in the
 * manifest, and sensitive files (credentials/local/session) are never tracked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME, TEST_TUCK_DIR, initTestTuck } from '../utils/testHelpers.js';
import { loadManifest, clearManifestCache } from '../../src/lib/manifest.js';
import { addCommand } from '../../src/commands/add.js';

// Real tracking copies files but never touches a live remote; stub git so the
// pipeline runs without a repository or network.
vi.mock('simple-git', () => {
  const mockGit = {
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
    getRemotes: vi.fn().mockResolvedValue([]),
    revparse: vi.fn().mockResolvedValue('main'),
    raw: vi.fn().mockResolvedValue('main'),
  };
  return { default: vi.fn(() => mockGit), simpleGit: vi.fn(() => mockGit) };
});

const stageClaudeHome = (): void => {
  vol.mkdirSync(join(TEST_HOME, '.claude', 'commands'), { recursive: true });
  vol.writeFileSync(join(TEST_HOME, '.claude', 'CLAUDE.md'), '# global rules');
  vol.writeFileSync(join(TEST_HOME, '.claude', 'settings.json'), '{"theme":"dark"}');
  vol.writeFileSync(join(TEST_HOME, '.claude', 'commands', 'deploy.md'), 'deploy cmd');
  // Sensitive — must never be tracked.
  vol.writeFileSync(join(TEST_HOME, '.claude', '.credentials.json'), '{"token":"secret"}');
  vol.writeFileSync(join(TEST_HOME, '.claude', 'settings.local.json'), '{"local":true}');
};

describe('tuck add --preset (integration)', () => {
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vol.reset();
    vi.clearAllMocks();
    clearManifestCache();
    await initTestTuck();
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
    clearManifestCache();
    const { setJsonMode } = await import('../../src/lib/jsonOutput.js');
    setJsonMode(false);
  });

  const jsonEnvelope = (): { ok: boolean; command: string; data?: any; error?: any } => {
    const jsonLine = writes.find((w) => w.trim().startsWith('{'));
    return JSON.parse((jsonLine ?? writes.join('')).trim());
  };

  it('tracks the safe allowlist and never the credentials/local files', async () => {
    stageClaudeHome();

    await addCommand.parseAsync(['node', 'tuck', '--preset', 'claude-code', '--yes']);

    const manifest = await loadManifest(TEST_TUCK_DIR);
    const sources = Object.values(manifest.files).map((f) => f.source);

    // Safe files present.
    expect(sources).toContain('~/.claude/CLAUDE.md');
    expect(sources).toContain('~/.claude/settings.json');
    expect(sources).toContain('~/.claude/commands');
    // Sensitive files absent.
    expect(sources.some((s) => s.includes('.credentials'))).toBe(false);
    expect(sources.some((s) => s.includes('settings.local.json'))).toBe(false);
    // All filed under the agents category.
    for (const f of Object.values(manifest.files)) {
      if (f.source.startsWith('~/.claude')) expect(f.category).toBe('agents');
    }
  });

  it('is idempotent — re-running adds nothing new', async () => {
    stageClaudeHome();
    await addCommand.parseAsync(['node', 'tuck', '--preset', 'claude-code', '--yes']);
    const first = Object.keys((await loadManifest(TEST_TUCK_DIR)).files).length;
    clearManifestCache();

    await addCommand.parseAsync(['node', 'tuck', '--preset', 'claude-code', '--yes']);
    const second = Object.keys((await loadManifest(TEST_TUCK_DIR)).files).length;

    expect(second).toBe(first);
  });

  it('reports nothing to track when the agent has no config on disk', async () => {
    await addCommand.parseAsync(['node', 'tuck', '--preset', 'codex', '--json', '--yes']);

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    expect(env.data.added).toBe(0);
    expect(Object.keys((await loadManifest(TEST_TUCK_DIR)).files)).toHaveLength(0);
  });

  it('rejects an unknown preset', async () => {
    await expect(
      addCommand.parseAsync(['node', 'tuck', '--preset', 'not-an-agent', '--json', '--yes'])
    ).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_PRESET' });
  });

  // NOTE: kept last on purpose. Commander stores option values on the shared
  // command instance and does not reset booleans between parseAsync calls, so a
  // `--plan` run must not precede a run that expects normal (mutating) mode.
  it('--plan --json lists safe files and the skipped sensitive ones without mutating', async () => {
    stageClaudeHome();

    await addCommand.parseAsync(['node', 'tuck', '--preset', 'claude-code', '--plan', '--json']);

    const env = jsonEnvelope();
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck add');
    expect(env.data.preset).toBe('claude-code');
    const planned = env.data.plan.map((p: { source: string }) => p.source);
    expect(planned).toContain('~/.claude/CLAUDE.md');
    expect(planned).toContain('~/.claude/commands');
    expect(env.data.skipped).toContain('~/.claude/.credentials.json');
    expect(env.data.skipped).toContain('~/.claude/settings.local.json');

    // Plan is read-only: nothing tracked.
    const manifest = await loadManifest(TEST_TUCK_DIR);
    expect(Object.keys(manifest.files)).toHaveLength(0);
  });
});
