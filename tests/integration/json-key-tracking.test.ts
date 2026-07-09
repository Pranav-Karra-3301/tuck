/**
 * End-to-end integration for JSON-path-scoped tracking (`tuck add --key`).
 *
 * Exercises the full promise on a sandboxed memfs home: only the named subtree
 * lands in the repo, machine-managed keys alongside it are never captured, sync
 * re-captures ONLY the subtree, restore deep-merges it back while preserving
 * every other live key, and the state model reports drift on the subtree only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_TUCK_DIR } from '../utils/testHelpers.js';
import { initTestTuck, createTestDotfile } from '../utils/testHelpers.js';
import {
  loadManifest,
  getTrackedFileBySource,
  clearManifestCache,
} from '../../src/lib/manifest.js';
import { computeStateModel } from '../../src/lib/stateModel.js';
import { addFilesFromPaths } from '../../src/commands/add.js';
import { runSyncCommand } from '../../src/commands/sync.js';
import { runRestoreCommand } from '../../src/commands/restore.js';

vi.mock('simple-git', () => {
  const mockGit = {
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
    status: vi.fn().mockResolvedValue({
      current: 'main',
      tracking: null,
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      not_added: [],
      deleted: [],
      isClean: () => true,
    }),
    getRemotes: vi.fn().mockResolvedValue([]),
    push: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    revparse: vi.fn().mockResolvedValue('main'),
    raw: vi.fn().mockResolvedValue('main'),
    branch: vi.fn().mockResolvedValue(undefined),
  };
  return { default: vi.fn(() => mockGit), simpleGit: vi.fn(() => mockGit) };
});

const CLAUDE_JSON = '~/.claude.json';

/** A realistic mixed config/state file: durable MCP config + machine secrets. */
const makeLiveFile = (overrides?: {
  mcpServers?: Record<string, unknown>;
  oauthToken?: string;
  numStartups?: number;
}): string =>
  JSON.stringify(
    {
      numStartups: overrides?.numStartups ?? 5,
      oauthToken: overrides?.oauthToken ?? 'MACHINE-A-SECRET',
      mcpServers: overrides?.mcpServers ?? { git: { command: 'git-mcp' } },
      history: [{ prompt: 'do not track me' }],
    },
    null,
    2
  );

const repoCopy = async (): Promise<Record<string, unknown>> => {
  const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, CLAUDE_JSON);
  const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
  return JSON.parse(vol.readFileSync(repoPath, 'utf-8') as string);
};

describe('JSON-key-scoped tracking (integration)', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    clearManifestCache();
  });
  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  it('stores ONLY the subtree in the repo and records jsonKey in the manifest', async () => {
    await initTestTuck();
    createTestDotfile('.claude.json', makeLiveFile());

    const added = await addFilesFromPaths([CLAUDE_JSON], { key: 'mcpServers', force: true });
    expect(added).toBe(1);

    const manifest = await loadManifest(TEST_TUCK_DIR);
    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, CLAUDE_JSON);
    expect(tracked?.file.jsonKey).toBe('mcpServers');

    const repo = await repoCopy();
    // The repo copy is exactly the subtree — no oauthToken, numStartups, history.
    expect(repo).toEqual({ git: { command: 'git-mcp' } });
    expect(JSON.stringify(manifest.files)).not.toContain('MACHINE-A-SECRET');
  });

  it('reports ok when unrelated keys change, drift-local when the subtree changes', async () => {
    await initTestTuck();
    const live = createTestDotfile('.claude.json', makeLiveFile());
    await addFilesFromPaths([CLAUDE_JSON], { key: 'mcpServers', force: true });

    clearManifestCache();
    expect((await computeStateModel(TEST_TUCK_DIR))[0].state).toBe('ok');

    // Editing a NON-tracked key (a token rotation) is NOT drift.
    vol.writeFileSync(live, makeLiveFile({ oauthToken: 'ROTATED', numStartups: 99 }));
    expect((await computeStateModel(TEST_TUCK_DIR))[0].state).toBe('ok');

    // Editing the tracked subtree IS drift.
    vol.writeFileSync(
      live,
      makeLiveFile({ mcpServers: { git: { command: 'git-mcp' }, fs: { command: 'fs-mcp' } } })
    );
    expect((await computeStateModel(TEST_TUCK_DIR))[0].state).toBe('drift-local');
  });

  it('sync captures ONLY the changed subtree back into the repo, never the whole file', async () => {
    await initTestTuck();
    const live = createTestDotfile('.claude.json', makeLiveFile());
    await addFilesFromPaths([CLAUDE_JSON], { key: 'mcpServers', force: true });

    // User adds a new MCP server AND rotates a token in the live file.
    vol.writeFileSync(
      live,
      makeLiveFile({
        oauthToken: 'ROTATED-SECRET',
        mcpServers: { git: { command: 'git-mcp' }, fs: { command: 'fs-mcp' } },
      })
    );

    await runSyncCommand(undefined, {
      noCommit: true,
      noHooks: true,
      pull: false,
      push: false,
      force: true,
    });

    const repo = await repoCopy();
    expect(repo).toEqual({ git: { command: 'git-mcp' }, fs: { command: 'fs-mcp' } });
    // The rotated token must NEVER be captured into the repo copy.
    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, CLAUDE_JSON);
    const repoRaw = vol.readFileSync(
      join(TEST_TUCK_DIR, tracked!.file.destination),
      'utf-8'
    ) as string;
    expect(repoRaw).not.toContain('ROTATED-SECRET');
  });

  it('restore deep-merges the subtree back, preserving every other live key', async () => {
    await initTestTuck();
    const live = createTestDotfile('.claude.json', makeLiveFile());
    await addFilesFromPaths([CLAUDE_JSON], { key: 'mcpServers', force: true });

    // Simulate a teammate's pushed update to the tracked subtree (repo copy).
    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, CLAUDE_JSON);
    const repoPath = join(TEST_TUCK_DIR, tracked!.file.destination);
    vol.writeFileSync(
      repoPath,
      JSON.stringify({ git: { command: 'git-mcp' }, shared: { command: 'shared-mcp' } }, null, 2) + '\n'
    );

    // This machine has its OWN token/state in the live file.
    vol.writeFileSync(live, makeLiveFile({ oauthToken: 'MACHINE-B-TOKEN', numStartups: 42 }));

    await runRestoreCommand([CLAUDE_JSON], { noHooks: true, backup: false });

    const merged = JSON.parse(vol.readFileSync(live, 'utf-8') as string);
    // Tracked subtree updated (teammate's server merged in)...
    expect(merged.mcpServers).toEqual({
      git: { command: 'git-mcp' },
      shared: { command: 'shared-mcp' },
    });
    // ...while this machine's own keys are untouched.
    expect(merged.oauthToken).toBe('MACHINE-B-TOKEN');
    expect(merged.numStartups).toBe(42);
    expect(merged.history).toEqual([{ prompt: 'do not track me' }]);
  });

  it('restore creates the key when the live file lacks it entirely', async () => {
    await initTestTuck();
    const live = createTestDotfile('.claude.json', makeLiveFile());
    await addFilesFromPaths([CLAUDE_JSON], { key: 'mcpServers', force: true });

    // Live file on this machine has no mcpServers key at all.
    vol.writeFileSync(live, JSON.stringify({ oauthToken: 'ONLY-TOKEN' }, null, 2));

    await runRestoreCommand([CLAUDE_JSON], { noHooks: true, backup: false });

    const merged = JSON.parse(vol.readFileSync(live, 'utf-8') as string);
    expect(merged.mcpServers).toEqual({ git: { command: 'git-mcp' } });
    expect(merged.oauthToken).toBe('ONLY-TOKEN');
  });

  it('rejects --key on a non-JSON file at add time', async () => {
    await initTestTuck();
    createTestDotfile('.notjson', 'this is not json');
    await expect(
      addFilesFromPaths(['~/.notjson'], { key: 'mcpServers', force: true })
    ).rejects.toThrow(/not valid JSON/i);
  });

  it('rejects --key when the key path is absent from the file', async () => {
    await initTestTuck();
    createTestDotfile('.claude.json', makeLiveFile());
    await expect(
      addFilesFromPaths([CLAUDE_JSON], { key: 'doesNotExist', force: true })
    ).rejects.toThrow(/not found/i);
  });
});
