/**
 * `tuck diff` secret-safety for JSON-key-tracked files.
 *
 * Covers two findings in the jsonKey diff paths:
 *   1. When the repo copy is MISSING, the diff must show ONLY the tracked subtree
 *      — never the whole live file (which holds untracked keys like oauthToken
 *      that a jsonKey add never wrote to the local secrets store, so redaction
 *      cannot cover them).
 *   2. The normal jsonKey diff branch must redact known stored secret values on
 *      BOTH the live-subtree and repo-copy sides before display.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_TUCK_DIR, initTestTuck, createTestDotfile } from '../utils/testHelpers.js';
import { getTrackedFileBySource, clearManifestCache } from '../../src/lib/manifest.js';
import { addFilesFromPaths } from '../../src/commands/add.js';
import { getFileDiff } from '../../src/commands/diff.js';
import { setSecret, getStoredValueMap } from '../../src/lib/secrets/index.js';

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

describe('tuck diff — JSON-key secret safety', () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    clearManifestCache();
  });
  afterEach(() => {
    vol.reset();
    clearManifestCache();
  });

  it('shows ONLY the tracked subtree (not the whole live file) when the repo copy is missing', async () => {
    await initTestTuck();
    createTestDotfile(
      '.claude.json',
      JSON.stringify(
        {
          mcpServers: { git: { command: 'git-mcp' } },
          oauthToken: 'SUPER-SECRET-TOKEN',
          history: [{ prompt: 'do not leak me' }],
        },
        null,
        2
      )
    );
    await addFilesFromPaths([CLAUDE_JSON], { key: 'mcpServers', force: true });

    // Simulate a missing repo copy (e.g. never pushed / partial clone).
    const tracked = await getTrackedFileBySource(TEST_TUCK_DIR, CLAUDE_JSON);
    vol.unlinkSync(join(TEST_TUCK_DIR, tracked!.file.destination));

    const diff = await getFileDiff(TEST_TUCK_DIR, CLAUDE_JSON);
    expect(diff).not.toBeNull();
    expect(diff!.hasChanges).toBe(true);
    expect(diff!.systemContent).toBeDefined();
    // The untracked OAuth token and history must NOT appear — only the subtree.
    expect(diff!.systemContent).not.toContain('SUPER-SECRET-TOKEN');
    expect(diff!.systemContent).not.toContain('oauthToken');
    expect(diff!.systemContent).not.toContain('history');
    expect(JSON.parse(diff!.systemContent!)).toEqual({ git: { command: 'git-mcp' } });
  });

  it('redacts known stored secrets on both sides of the jsonKey diff', async () => {
    await initTestTuck();
    const secret = 'sk-live-abcdef0123456789';
    createTestDotfile(
      '.claude.json',
      JSON.stringify(
        { mcpServers: { git: { command: 'git-mcp' }, apiKey: secret }, oauthToken: 't' },
        null,
        2
      )
    );
    // force so the secret-bearing subtree is tracked verbatim into the repo copy.
    await addFilesFromPaths([CLAUDE_JSON], { key: 'mcpServers', force: true });

    // Register the secret in the local store so diff's redaction can catch it.
    await setSecret(TEST_TUCK_DIR, 'API_KEY', secret);

    // Make the live subtree diverge from the repo copy (add a server) so the
    // diff branch emits content for both sides. Rewrite the live file directly.
    const { expandPath } = await import('../../src/lib/paths.js');
    vol.writeFileSync(
      expandPath(CLAUDE_JSON),
      JSON.stringify(
        {
          mcpServers: { git: { command: 'git-mcp' }, apiKey: secret, fs: { command: 'fs-mcp' } },
          oauthToken: 't',
        },
        null,
        2
      )
    );

    const valueMap = await getStoredValueMap(TEST_TUCK_DIR);
    const diff = await getFileDiff(TEST_TUCK_DIR, CLAUDE_JSON, valueMap);

    expect(diff).not.toBeNull();
    expect(diff!.hasChanges).toBe(true);
    // The cleartext secret must never appear on EITHER side of the diff.
    expect(diff!.systemContent).toBeDefined();
    expect(diff!.repoContent).toBeDefined();
    expect(diff!.systemContent).not.toContain(secret);
    expect(diff!.repoContent).not.toContain(secret);
    // Redaction substituted the stored placeholder in its place.
    expect(diff!.systemContent).toContain('API_KEY');
    expect(diff!.repoContent).toContain('API_KEY');
  });
});
