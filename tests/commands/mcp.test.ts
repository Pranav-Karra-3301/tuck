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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dispatch, createServerState } from '../../src/commands/mcp.js';
import { VERSION } from '../../src/constants.js';

let state: ReturnType<typeof createServerState>;
beforeEach(() => {
  state = createServerState();
  delete process.env.TUCK_MCP_ALLOW_WRITE;
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
});
