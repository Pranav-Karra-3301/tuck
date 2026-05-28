/**
 * `tuck mcp serve` — minimal Model Context Protocol server over stdio.
 *
 * Exposes tuck operations as MCP tools so any MCP-compatible agent (Claude
 * Code, Cursor, Aider, etc.) can manage dotfiles and agent configs natively.
 *
 * Why hand-rolled instead of @modelcontextprotocol/sdk?
 *   - The doc (§4.5) calls for a ~200-line file. The official SDK is fine but
 *     adds a dep on the dotfiles manager you install onto a fresh box, where
 *     install size matters. We implement the protocol's stdio JSON-RPC framing
 *     directly. Spec: https://spec.modelcontextprotocol.io/
 *   - This is a deliberate tradeoff captured in implementation-notes.html.
 */

import { Command } from 'commander';
import { createInterface } from 'readline';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles } from '../lib/manifest.js';
import {
  addContextFile,
  getContextEntries,
  classifyAgentPath,
} from './context.js';
import { detectDotfiles } from '../lib/detect.js';
import { getStatus } from '../lib/git.js';
import { VERSION } from '../constants.js';
import { setJsonMode, emitJsonOk } from '../lib/jsonOutput.js';

/** Max accepted stdin line length (1 MiB) — guards against memory abuse. */
const MAX_LINE_BYTES = 1024 * 1024;

/** Tools that mutate state; gated behind TUCK_MCP_ALLOW_WRITE. */
const WRITE_TOOLS = new Set(['context_add']);

const writesAllowed = (): boolean =>
  process.env.TUCK_MCP_ALLOW_WRITE === 'true' || process.env.TUCK_MCP_ALLOW_WRITE === '1';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const tools: ToolDef[] = [
  {
    name: 'list_tracked_files',
    description: 'List all files currently tracked by tuck in the user manifest.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const tuckDir = getTuckDir();
      const files = await getAllTrackedFiles(tuckDir);
      return {
        count: Object.keys(files).length,
        files: Object.entries(files).map(([id, f]) => ({
          id,
          source: f.source,
          destination: f.destination,
          category: f.category,
        })),
      };
    },
  },
  {
    name: 'status',
    description: 'Return the current tuck status: branch, tracked count, dirty files.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const tuckDir = getTuckDir();
      const manifest = await loadManifest(tuckDir);
      const git = await getStatus(tuckDir);
      return {
        tuckDir,
        branch: git.branch,
        ahead: git.ahead,
        behind: git.behind,
        modified: git.modified,
        staged: git.staged,
        untracked: git.untracked,
        trackedCount: Object.keys(manifest.files).length,
      };
    },
  },
  {
    name: 'scan',
    description: 'Detect dotfiles on the system without tracking them.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const detected = await detectDotfiles();
      return {
        count: detected.length,
        files: detected.map((d) => ({
          path: d.path,
          category: d.category,
          sensitive: d.sensitive,
        })),
      };
    },
  },
  {
    name: 'context_list',
    description: 'List tracked AI agent configurations (CLAUDE.md, .cursorrules, etc.).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const tuckDir = getTuckDir();
      const entries = await getContextEntries(tuckDir);
      return {
        count: Object.keys(entries).length,
        entries: Object.entries(entries).map(([id, e]) => ({ id, ...e })),
      };
    },
  },
  {
    name: 'context_add',
    description: 'Track an AI agent configuration file (auto-detects home vs repo scope).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the agent config file' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const path = String(args.path);
      const tuckDir = getTuckDir();
      const { id, entry } = await addContextFile(tuckDir, path);
      return { id, ...entry };
    },
  },
  {
    name: 'classify_agent_file',
    description: 'Classify a file path into an agent kind (claude|cursor|aider|copilot|mcp|skill|memory|other).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      return { agent: classifyAgentPath(String(args.path)) };
    },
  },
];

const respond = (resp: JsonRpcResponse): void => {
  process.stdout.write(JSON.stringify(resp) + '\n');
};

export interface ServerState {
  initialized: boolean;
}

export const createServerState = (): ServerState => ({ initialized: false });

const rpcError = (
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** An MCP tool RESULT signalling failure (isError) — NOT a JSON-RPC error. */
const toolError = (id: string | number | null, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result: { content: [{ type: 'text', text: message }], isError: true },
});

/** Validate call arguments against a tool's declared inputSchema. */
const validateArgs = (tool: ToolDef, args: Record<string, unknown>): string | null => {
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return `Missing required argument: ${key}`;
    }
    const expected = (tool.inputSchema.properties[key] as { type?: string } | undefined)?.type;
    if (expected === 'string' && typeof args[key] !== 'string') {
      return `Argument "${key}" must be a string`;
    }
  }
  return null;
};

/**
 * Pure request dispatcher. Returns the response (or null for notifications) so
 * it can be unit-tested and so the serve loop can emit responses in order.
 */
export const dispatch = async (
  req: JsonRpcRequest,
  state: ServerState
): Promise<JsonRpcResponse | null> => {
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      state.initialized = true;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'tuck', version: VERSION },
        },
      };

    case 'notifications/initialized':
      return null; // notification — no response

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      if (!state.initialized) return rpcError(id, -32002, 'Server not initialized');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case 'tools/call': {
      if (!state.initialized) return rpcError(id, -32002, 'Server not initialized');
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32601, `Unknown tool: ${params.name}`);

      const args = params.arguments ?? {};
      // Argument and write-permission failures are TOOL errors (isError), not
      // transport errors — hosts surface them to the model instead of aborting.
      const argErr = validateArgs(tool, args);
      if (argErr) return toolError(id, argErr);
      if (WRITE_TOOLS.has(tool.name) && !writesAllowed()) {
        return toolError(
          id,
          `Tool "${tool.name}" mutates state and is disabled. Set TUCK_MCP_ALLOW_WRITE=1 to enable write tools.`
        );
      }

      try {
        const result = await tool.handler(args);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false },
        };
      } catch (err) {
        return toolError(id, err instanceof Error ? err.message : String(err));
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${req.method}`);
  }
};

const runServe = async (): Promise<void> => {
  // Stdio framing: line-delimited JSON (what Claude Code's MCP host uses).
  const rl = createInterface({ input: process.stdin });
  const state = createServerState();
  // Serialize handling so responses are emitted in request order.
  let chain: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    chain = chain.then(async () => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_LINE_BYTES) {
        respond(rpcError(null, -32600, 'Request exceeds maximum allowed size'));
        return;
      }
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        respond(rpcError(null, -32700, 'Parse error'));
        return;
      }
      const resp = await dispatch(req, state);
      if (resp) respond(resp);
    });
  });
  rl.on('close', () => process.exit(0));
};

export const mcpCommand = new Command('mcp')
  .description('Model Context Protocol server — expose tuck to AI agents')
  .addCommand(
    new Command('serve')
      .description('Start an MCP server over stdio')
      .action(async () => {
        await runServe();
      })
  )
  .addCommand(
    new Command('tools')
      .description('List MCP tools this server exposes (for debugging)')
      .option('--json', 'Emit JSON envelope to stdout')
      .action((opts: { json?: boolean }) => {
        const list = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        if (opts.json) {
          setJsonMode(true, 'tuck mcp tools');
          emitJsonOk({ tools: list }, 'tuck mcp tools');
          return;
        }
        console.log(`tuck MCP exposes ${list.length} tools:`);
        for (const t of list) {
          console.log(`  - ${t.name}: ${t.description}`);
        }
      })
  );
