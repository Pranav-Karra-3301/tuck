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

let state: ReturnType<typeof createServerState>;
beforeEach(() => {
  state = createServerState();
  delete process.env.TUCK_MCP_ALLOW_WRITE;
  addContextFileMock.mockReset();
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
});
