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

const handleRequest = async (req: JsonRpcRequest): Promise<void> => {
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case 'initialize':
        respond({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'tuck', version: '1.0.0' },
          },
        });
        return;
      case 'tools/list':
        respond({
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });
        return;
      case 'tools/call': {
        const params = req.params as { name: string; arguments?: Record<string, unknown> };
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) {
          respond({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${params.name}` },
          });
          return;
        }
        const result = await tool.handler(params.arguments ?? {});
        respond({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
        return;
      }
      case 'notifications/initialized':
        // No response needed for notifications.
        return;
      case 'ping':
        respond({ jsonrpc: '2.0', id, result: {} });
        return;
      default:
        respond({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
    }
  } catch (err) {
    respond({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
};

const runServe = async (): Promise<void> => {
  // Stdio framing: line-delimited JSON. The official MCP transport supports
  // both LSP-style Content-Length headers and pure line-delimited JSON over
  // stdio; line-delimited is what Claude Code's MCP host uses, so we match.
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest;
      void handleRequest(req);
    } catch {
      respond({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
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
          process.stdout.write(
            JSON.stringify({ ok: true, command: 'tuck mcp tools', data: { tools: list } }) + '\n'
          );
          return;
        }
        console.log(`tuck MCP exposes ${list.length} tools:`);
        for (const t of list) {
          console.log(`  - ${t.name}: ${t.description}`);
        }
      })
  );
