/**
 * MCP server dispatch unit tests.
 *
 * The hand-rolled MCP server must behave correctly as a protocol endpoint:
 *  - report the real package version;
 *  - refuse tools/call before `initialize` (no unauthenticated tool execution);
 *  - return TOOL failures as an MCP tool result with isError:true (not a
 *    JSON-RPC transport error, which hosts treat as a protocol failure);
 *  - validate arguments against each tool's inputSchema;
 *  - gate state-mutating tools behind TUCK_MCP_ALLOW_WRITE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatch, createServerState } from '../../src/commands/mcp.js';
import { VERSION } from '../../src/constants.js';
import { snapshotWriteContext } from '../../src/lib/writeContext.js';
import { vol } from 'memfs';
import { tmpdir } from 'os';

// Keep the real classifier/listing behaviour (other tests depend on it) but
// replace the single state-mutating entry point so write-gate tests can run
// without touching the filesystem.
const addContextFileMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/commands/context.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/commands/context.js')>(
    '../../src/commands/context.js'
  );
  return { ...actual, addContextFile: addContextFileMock };
});

// Library-boundary mocks for the new read tools: the tool HANDLERS run their real
// projection/redaction logic over controlled inputs (so the redaction test is
// meaningful), while the underlying fs/scan/state work is stubbed.
const loadManifestMock = vi.hoisted(() => vi.fn());
const getAllTrackedFilesMock = vi.hoisted(() => vi.fn());
const computeStateModelMock = vi.hoisted(() => vi.fn());
const scanForSecretsMock = vi.hoisted(() => vi.fn());
const getFileDiffMock = vi.hoisted(() => vi.fn());
const detectDotfilesMock = vi.hoisted(() => vi.fn());
const dryApplyMock = vi.hoisted(() => vi.fn());
const resolveLiveTargetMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/manifest.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/manifest.js')>('../../src/lib/manifest.js');
  return { ...actual, loadManifest: loadManifestMock, getAllTrackedFiles: getAllTrackedFilesMock };
});
vi.mock('../../src/lib/stateModel.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/stateModel.js')>('../../src/lib/stateModel.js');
  return { ...actual, computeStateModel: computeStateModelMock }; // keep summarizeStateModel real
});
vi.mock('../../src/lib/secrets/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/secrets/index.js')>('../../src/lib/secrets/index.js');
  return { ...actual, scanForSecrets: scanForSecretsMock };
});
vi.mock('../../src/commands/diff.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/commands/diff.js')>('../../src/commands/diff.js');
  return { ...actual, getFileDiff: getFileDiffMock };
});
vi.mock('../../src/lib/detect.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/detect.js')>('../../src/lib/detect.js');
  return { ...actual, detectDotfiles: detectDotfilesMock };
});
vi.mock('../../src/commands/verify.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/commands/verify.js')>('../../src/commands/verify.js');
  return { ...actual, dryApplyIntoSandbox: dryApplyMock }; // keep hasDrift real
});
vi.mock('../../src/lib/repoScope.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/repoScope.js')>('../../src/lib/repoScope.js');
  return { ...actual, resolveLiveTarget: resolveLiveTargetMock };
});

let state: ReturnType<typeof createServerState>;
beforeEach(() => {
  state = createServerState();
  delete process.env.TUCK_MCP_ALLOW_WRITE;
  addContextFileMock.mockReset();
  loadManifestMock.mockReset().mockResolvedValue({ files: {} });
  getAllTrackedFilesMock.mockReset().mockResolvedValue({});
  computeStateModelMock.mockReset().mockResolvedValue([]);
  scanForSecretsMock.mockReset();
  getFileDiffMock.mockReset();
  detectDotfilesMock.mockReset().mockResolvedValue([]);
  dryApplyMock.mockReset();
  // Default: home-scoped files resolve like expandPath; repo-scoped tests override.
  resolveLiveTargetMock.mockReset();
  resolveLiveTargetMock.mockImplementation(async (f: { source: string }) => f.source.replace(/^~\//, '/test-home/'));
  // apply_plan mkdtemp's under os.tmpdir(); the global setup resets memfs each
  // test, so recreate the temp root (real-path under the memfs vfs) here.
  vol.mkdirSync(tmpdir(), { recursive: true });
});
afterEach(() => {
  delete process.env.TUCK_MCP_ALLOW_WRITE;
});

const init = async () => dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, state);

describe('mcp dispatch', () => {
  it('reports the real package version on initialize', async () => {
    const resp = await init();
    expect((resp as { result: { serverInfo: { version: string } } }).result.serverInfo.version).toBe(VERSION);
    expect(state.initialized).toBe(true);
  });

  it('refuses tools/call before initialize', async () => {
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status' } },
      state
    );
    expect((resp as { error?: unknown }).error).toBeTruthy();
  });

  it('returns isError tool result (not transport error) for an unknown tool after init', async () => {
    await init();
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } },
      state
    );
    // unknown tool is a protocol error (method/name not found) -> JSON-RPC error
    expect((resp as { error?: { code: number } }).error?.code).toBe(-32601);
  });

  it('returns an isError tool result (not a throw) when `arguments` is not an object', async () => {
    await init();
    // `validateArgs` uses `key in args` / Object.entries(args), which throw on a
    // string/number/array. Without coercion this rejected the serve chain and
    // crashed the whole server; it must degrade to a tool error instead.
    for (const bad of ['foo', 42, ['a'], true]) {
      const resp = await dispatch(
        { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'status', arguments: bad } },
        state
      );
      expect((resp as { error?: unknown }).error).toBeUndefined();
      const r = (resp as { result: { isError: boolean; content: { text: string }[] } }).result;
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/arguments.*must be an object/i);
    }
  });

  it('validates required arguments (missing path) as an isError tool result', async () => {
    await init();
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'classify_agent_file', arguments: {} } },
      state
    );
    const r = (resp as { result: { isError: boolean } }).result;
    expect(r.isError).toBe(true);
  });

  it('runs a read-only tool successfully after init', async () => {
    await init();
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'classify_agent_file', arguments: { path: '~/.claude/CLAUDE.md' } },
      },
      state
    );
    const r = (resp as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('claude');
  });

  it('gates the state-mutating context_add tool behind TUCK_MCP_ALLOW_WRITE', async () => {
    await init();
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'context_add', arguments: { path: '~/.claude/CLAUDE.md' } },
      },
      state
    );
    const r = (resp as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('TUCK_MCP_ALLOW_WRITE');
  });

  it('responds to ping with an empty result object', async () => {
    const resp = await dispatch({ jsonrpc: '2.0', id: 7, method: 'ping' }, state);
    expect(resp).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('treats notifications/initialized as a notification (returns null, no response)', async () => {
    const resp = await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, state);
    expect(resp).toBeNull();
  });

  it('refuses tools/list before initialize', async () => {
    const resp = await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, state);
    expect((resp as { error: { code: number } }).error.code).toBe(-32002);
    expect((resp as { result?: unknown }).result).toBeUndefined();
  });

  it('returns the full tool list after initialize', async () => {
    await init();
    const resp = await dispatch({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, state);
    const tools = (resp as { result: { tools: { name: string; description: string; inputSchema: unknown }[] } })
      .result.tools;
    expect(Array.isArray(tools)).toBe(true);
    const names = tools.map((t) => t.name);
    // The known tool surface this server exposes.
    expect(names).toEqual(
      expect.arrayContaining([
        'list_tracked_files',
        'status',
        'scan',
        'context_list',
        'context_add',
        'classify_agent_file',
        'verify',
        'diff',
        'scan_untracked',
        'secrets_status',
        'apply_plan',
      ])
    );
    // Each advertised tool carries its declared schema and description.
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeDefined();
    }
  });

  it('returns -32601 for an unknown METHOD', async () => {
    await init();
    const resp = await dispatch({ jsonrpc: '2.0', id: 10, method: 'does/not/exist' }, state);
    expect((resp as { error: { code: number; message: string } }).error.code).toBe(-32601);
    expect((resp as { error: { message: string } }).error.message).toContain('does/not/exist');
  });

  it('preserves the request id (including null) on errors', async () => {
    const resp = await dispatch({ jsonrpc: '2.0', method: 'unknown/method' }, state);
    expect((resp as { id: string | number | null }).id).toBeNull();
    expect((resp as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('returns an isError tool result (not a -32603 transport error) when a handler throws', async () => {
    await init();
    process.env.TUCK_MCP_ALLOW_WRITE = '1';
    addContextFileMock.mockRejectedValueOnce(new Error('boom: file not found'));
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'context_add', arguments: { path: '~/.claude/CLAUDE.md' } },
      },
      state
    );
    // A throwing handler is reported as a TOOL failure, never as a JSON-RPC
    // transport error — hosts surface tool errors to the model.
    expect((resp as { error?: unknown }).error).toBeUndefined();
    const r = (resp as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('boom: file not found');
  });

  it('permits the context_add write tool past the gate when TUCK_MCP_ALLOW_WRITE=1', async () => {
    await init();
    process.env.TUCK_MCP_ALLOW_WRITE = '1';
    addContextFileMock.mockResolvedValueOnce({
      id: 'home__claude_md',
      entry: { source: '~/.claude/CLAUDE.md', destination: 'context/home/claude_md' },
    });
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'context_add', arguments: { path: '~/.claude/CLAUDE.md' } },
      },
      state
    );
    // It got past the write-gate and actually invoked the (mocked) handler.
    expect(addContextFileMock).toHaveBeenCalledTimes(1);
    expect(addContextFileMock.mock.calls[0][1]).toBe('~/.claude/CLAUDE.md');
    const r = (resp as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('home__claude_md');
  });

  it('also accepts the literal "true" value for TUCK_MCP_ALLOW_WRITE', async () => {
    await init();
    process.env.TUCK_MCP_ALLOW_WRITE = 'true';
    addContextFileMock.mockResolvedValueOnce({
      id: 'home__claude_md',
      entry: { source: '~/.claude/CLAUDE.md', destination: 'context/home/claude_md' },
    });
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'context_add', arguments: { path: '~/.claude/CLAUDE.md' } },
      },
      state
    );
    expect(addContextFileMock).toHaveBeenCalledTimes(1);
    const r = (resp as { result: { isError: boolean } }).result;
    expect(r.isError).toBe(false);
  });

  // ── widened read tools (P0-3) ──

  const callTool = async (id: number, name: string, args: Record<string, unknown> = {}) =>
    dispatch({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, state);
  const okPayload = (resp: unknown): { isError: boolean; text: string } => {
    const r = (resp as { result: { isError: boolean; content: { text: string }[] } }).result;
    return { isError: r.isError, text: r.content[0].text };
  };

  it('verify tool reports a summary and a drift boolean (never exits the process)', async () => {
    await init();
    computeStateModelMock.mockResolvedValueOnce([
      { id: 'a', source: '~/.zshrc', destination: 'files/shell/zshrc', state: 'drift-local', liveChecksum: 'x', repoChecksum: 'y', manifestChecksum: 'y' },
    ]);
    const { isError, text } = okPayload(await callTool(30, 'verify'));
    expect(isError).toBe(false);
    const payload = JSON.parse(text);
    expect(payload.drift).toBe(true);
    expect(payload.summary.total).toBe(1);
    expect(payload.files[0]).toEqual({ source: '~/.zshrc', state: 'drift-local' });
  });

  it('diff tool returns changed files as metadata only (content elided)', async () => {
    await init();
    getAllTrackedFilesMock.mockResolvedValueOnce({
      z: { source: '~/.zshrc', destination: 'files/shell/zshrc', category: 'shell' },
    });
    getFileDiffMock.mockResolvedValueOnce({
      source: '~/.zshrc', destination: 'files/shell/zshrc', hasChanges: true,
      systemSize: 10, repoSize: 8, systemContent: 'SECRET_LINE', repoContent: 'x',
    });
    const { isError, text } = okPayload(await callTool(31, 'diff'));
    expect(isError).toBe(false);
    const payload = JSON.parse(text);
    expect(payload.count).toBe(1);
    expect(payload.files[0].source).toBe('~/.zshrc');
    expect(text).not.toContain('SECRET_LINE'); // contents are not exposed
  });

  it('diff tool rejects a non-array `paths` argument (B2 optional type-check)', async () => {
    await init();
    const { isError, text } = okPayload(await callTool(32, 'diff', { paths: 'x' }));
    expect(isError).toBe(true);
    expect(text).toMatch(/paths.*array/i);
  });

  it('scan_untracked returns detected minus tracked', async () => {
    await init();
    getAllTrackedFilesMock.mockResolvedValueOnce({
      z: { source: '~/.zshrc', destination: 'd', category: 'shell' },
    });
    detectDotfilesMock.mockResolvedValueOnce([
      { path: '~/.zshrc', category: 'shell', sensitive: false },
      { path: '~/.gitconfig', category: 'git', sensitive: false },
    ]);
    const { text } = okPayload(await callTool(33, 'scan_untracked'));
    const payload = JSON.parse(text);
    expect(payload.count).toBe(1);
    expect(payload.files[0].path).toBe('~/.gitconfig');
  });

  it('secrets_status NEVER returns raw values, context, or placeholders (redaction gate)', async () => {
    await init();
    getAllTrackedFilesMock.mockResolvedValueOnce({ e: { source: '~/.env', destination: 'd', category: 'env' } });
    scanForSecretsMock.mockResolvedValueOnce({
      totalFiles: 1, scannedFiles: 1, skippedFiles: 0, filesWithSecrets: 1, totalSecrets: 1,
      bySeverity: { critical: 1, high: 0, medium: 0, low: 0 },
      results: [{
        path: '/home/u/.env', collapsedPath: '~/.env', hasSecrets: true,
        criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0, skipped: false,
        matches: [{
          patternId: 'aws', patternName: 'AWS Key', severity: 'critical',
          value: 'AKIAIOSFODNN7EXAMPLE', redactedValue: '[REDACTED]', line: 3, column: 5,
          context: 'key=AKIAIOSFODNN7EXAMPLE', placeholder: '{{AWS}}',
        }],
      }],
    });
    const { isError, text } = okPayload(await callTool(34, 'secrets_status'));
    expect(isError).toBe(false);
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE'); // raw value
    expect(text).not.toContain('key=AKIAIOSFODNN7EXAMPLE'); // context
    expect(text).not.toContain('{{AWS}}'); // placeholder
    expect(text).toContain('[REDACTED]');
    const m = JSON.parse(text).files[0].matches[0];
    expect(m).not.toHaveProperty('value');
    expect(m).not.toHaveProperty('context');
    expect(m).not.toHaveProperty('placeholder');
    expect(m.redactedValue).toBe('[REDACTED]');
  });

  it('secrets_status resolves repo-scoped files via resolveLiveTarget (not expandPath)', async () => {
    await init();
    getAllTrackedFilesMock.mockResolvedValueOnce({
      r: {
        source: 'repokey:cfg/app.conf',
        destination: 'context/repo/x',
        category: 'misc',
        scope: 'repo',
        repoKey: 'repokey',
        repoRelative: 'cfg/app.conf',
      },
    });
    resolveLiveTargetMock.mockResolvedValueOnce('/Users/me/projects/app/cfg/app.conf');
    scanForSecretsMock.mockResolvedValueOnce({
      totalFiles: 1, scannedFiles: 1, skippedFiles: 0, filesWithSecrets: 0, totalSecrets: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, results: [],
    });
    await callTool(38, 'secrets_status');
    // Scanned via the RESOLVED live path — never expandPath('repokey:cfg/app.conf').
    expect(scanForSecretsMock).toHaveBeenCalledWith(['/Users/me/projects/app/cfg/app.conf'], expect.any(String));
  });

  it('apply_plan returns a created/modified/unchanged summary WITHOUT the write gate', async () => {
    await init(); // TUCK_MCP_ALLOW_WRITE unset (dry-run is read-only from the host)
    dryApplyMock.mockResolvedValueOnce({
      changes: [{ target: '/sandbox/.zshrc', status: 'created', bytesBefore: 0, bytesAfter: 10 }],
      conflicts: [], wouldEscapeRoot: [],
    });
    const { isError, text } = okPayload(await callTool(35, 'apply_plan'));
    expect(isError).toBe(false);
    expect(JSON.parse(text).summary.created).toBe(1);
  });

  it('apply_plan restores the prior write context even when the dry-apply throws', async () => {
    await init();
    const before = snapshotWriteContext();
    dryApplyMock.mockRejectedValueOnce(new Error('prepare blew up'));
    const { isError } = okPayload(await callTool(36, 'apply_plan'));
    expect(isError).toBe(true); // surfaced as a tool error
    expect(snapshotWriteContext()).toEqual(before); // sandbox boundary not leaked
  });

  it('annotates write-gated tools in tools/list with writeGated + readOnlyHint', async () => {
    await init();
    const resp = await dispatch({ jsonrpc: '2.0', id: 37, method: 'tools/list' }, state);
    const list = (resp as { result: { tools: Array<{ name: string; writeGated?: boolean; annotations?: { readOnlyHint?: boolean } }> } }).result.tools;
    const ctxAdd = list.find((t) => t.name === 'context_add')!;
    const verify = list.find((t) => t.name === 'verify')!;
    expect(ctxAdd.writeGated).toBe(true);
    expect(ctxAdd.annotations?.readOnlyHint).toBe(false);
    expect(verify.writeGated).toBe(false);
    expect(verify.annotations?.readOnlyHint).toBe(true);
  });
});
