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
import { getTuckDir, collapsePath } from '../lib/paths.js';
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
import { computeStateModel, summarizeStateModel } from '../lib/stateModel.js';
import { hasDrift, dryApplyIntoSandbox } from './verify.js';
import { getFileDiff } from './diff.js';
import { scanForSecrets } from '../lib/secrets/index.js';
import { snapshotWriteContext, setWriteContext, restoreWriteContext } from '../lib/writeContext.js';
import { resolveLiveTarget } from '../lib/repoScope.js';
import { join, relative } from 'path';

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
  {
    name: 'verify',
    description:
      'Verify that the live system, the repo, and the manifest agree. Reports per-file drift state and a ' +
      'summary. `drift:true` mirrors `tuck verify --exit-code` (the CI gate) as a boolean — the server never exits.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const tuckDir = getTuckDir();
      await loadManifest(tuckDir); // throws → caught → isError tool result
      const entries = await computeStateModel(tuckDir);
      const summary = summarizeStateModel(entries);
      return {
        summary,
        drift: hasDrift(summary),
        files: entries.map((e) => ({ source: e.source, state: e.state })),
      };
    },
  },
  {
    name: 'diff',
    description:
      'Preview which tracked files differ between the live system and the repo. Returns METADATA ONLY ' +
      '(sizes/flags); file contents are elided to keep the response small and avoid leaking secret-bearing lines.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', description: 'Limit to these tracked source paths (default: all tracked files)' },
        category: { type: 'string', description: 'Limit to a single category' },
      },
    },
    handler: async (args) => {
      const tuckDir = getTuckDir();
      const all = await getAllTrackedFiles(tuckDir);
      const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : null;
      const category = args.category ? String(args.category) : undefined;
      const wanted = Object.values(all).filter(
        (f) => (!paths || paths.includes(f.source)) && (!category || f.category === category)
      );
      const files: Array<Record<string, unknown>> = [];
      for (const f of wanted) {
        // getFileDiff is read-only; swallow per-file errors (permission/missing) so
        // one unreadable file never aborts the whole preview.
        const d = await getFileDiff(tuckDir, f.source).catch(() => null);
        if (d && d.hasChanges) {
          files.push({
            source: d.source,
            destination: d.destination,
            isBinary: d.isBinary ?? false,
            isDirectory: d.isDirectory ?? false,
            systemSize: d.systemSize,
            repoSize: d.repoSize,
          });
        }
      }
      return { count: files.length, files };
    },
  },
  {
    name: 'scan_untracked',
    description:
      'List dotfiles detected on this system that tuck does NOT yet track (the actionable delta). Each entry ' +
      'carries a `sensitive` flag so an agent knows which to review before adding.',
    inputSchema: { type: 'object', properties: { category: { type: 'string' } } },
    handler: async (args) => {
      const tuckDir = getTuckDir();
      const all = await getAllTrackedFiles(tuckDir);
      const tracked = new Set(Object.values(all).map((f) => f.source));
      const category = args.category ? String(args.category) : undefined;
      const detected = await detectDotfiles();
      const untracked = detected.filter(
        (d) => !tracked.has(d.path) && (!category || d.category === category)
      );
      return {
        count: untracked.length,
        files: untracked.map((d) => ({ path: d.path, category: d.category, sensitive: d.sensitive })),
      };
    },
  },
  {
    name: 'secrets_status',
    description:
      'Scan tracked files for likely secrets — values are REDACTED. Run before sync/commit so an agent never ' +
      'proposes committing a key. Never returns raw secret values, context, or placeholders.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const tuckDir = getTuckDir();
      await loadManifest(tuckDir);
      const all = await getAllTrackedFiles(tuckDir);
      // Resolve each tracked file to its real LIVE path. expandPath would
      // mis-resolve repo-scoped sources (a stable "key:rel" identity, not a home
      // path) and silently skip them; resolveLiveTarget returns null for repos not
      // bound on this machine, which we drop.
      const resolved = await Promise.all(Object.values(all).map((f) => resolveLiveTarget(f)));
      const paths = resolved.filter((p): p is string => p !== null);
      const summary = await scanForSecrets(paths, tuckDir);
      return {
        filesWithSecrets: summary.filesWithSecrets,
        totalSecrets: summary.totalSecrets,
        bySeverity: summary.bySeverity,
        files: summary.results
          .filter((r) => r.hasSecrets)
          .map((r) => ({
            path: r.collapsedPath,
            counts: {
              critical: r.criticalCount,
              high: r.highCount,
              medium: r.mediumCount,
              low: r.lowCount,
            },
            // REDACTION: project ONLY safe fields — never value / context / placeholder.
            matches: r.matches.map((m) => ({
              patternId: m.patternId,
              patternName: m.patternName,
              severity: m.severity,
              line: m.line,
              column: m.column,
              redactedValue: m.redactedValue,
            })),
          })),
      };
    },
  },
  {
    name: 'apply_plan',
    description:
      'Dry-run `tuck apply` into an isolated sandbox and report created/modified/unchanged files, smart-merge ' +
      'conflicts, and any entry that would escape the sandbox. Writes NOTHING to the real system (read-only from the host).',
    inputSchema: {
      type: 'object',
      properties: { bundle: { type: 'string', description: 'Limit the plan to a single bundle' } },
    },
    handler: async (args) => {
      const tuckDir = getTuckDir();
      await loadManifest(tuckDir);
      const { mkdtemp, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const sandboxRoot = await mkdtemp(join(tmpdir(), 'tuck-mcp-apply-'));
      // Snapshot BEFORE setting the sandbox boundary, restore in finally — so a
      // global --root boundary is preserved across this long-running server.
      const prev = snapshotWriteContext();
      setWriteContext({ root: sandboxRoot, isSandbox: true });
      try {
        const res = await dryApplyIntoSandbox(tuckDir, args.bundle ? String(args.bundle) : undefined);
        return {
          summary: {
            created: res.changes.filter((c) => c.status === 'created').length,
            modified: res.changes.filter((c) => c.status === 'modified').length,
            unchanged: res.changes.filter((c) => c.status === 'unchanged').length,
            conflicts: res.conflicts.length,
            wouldEscapeRoot: res.wouldEscapeRoot.length,
          },
          changes: res.changes.map((c) => ({
            // Sandbox-relative target — the sandbox root is under the OS temp dir,
            // so collapsePath wouldn't shorten it (it would leak the host temp path).
            target: c.target.startsWith(sandboxRoot) ? relative(sandboxRoot, c.target) || '.' : collapsePath(c.target),
            status: c.status,
            bytesBefore: c.bytesBefore,
            bytesAfter: c.bytesAfter,
          })),
          conflicts: res.conflicts.map((c) => ({ target: c.target, type: c.type, name: c.name })),
          wouldEscapeRoot: res.wouldEscapeRoot,
        };
      } finally {
        restoreWriteContext(prev);
        await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
      }
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
  // 1) Required args must be present (and non-null).
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return `Missing required argument: ${key}`;
    }
  }
  // 2) Type-check EVERY present key that has a declared type (required OR
  //    optional). Unknown keys are tolerated (forward-compat — hosts may attach
  //    extra metadata); we validate against declared types, not strict-reject.
  for (const [key, val] of Object.entries(args)) {
    if (val === undefined || val === null) continue;
    const expected = (tool.inputSchema.properties[key] as { type?: string } | undefined)?.type;
    if (!expected) continue;
    const ok =
      expected === 'string'
        ? typeof val === 'string'
        : expected === 'boolean'
          ? typeof val === 'boolean'
          : expected === 'number'
            ? typeof val === 'number'
            : expected === 'array'
              ? Array.isArray(val)
              : expected === 'object'
                ? typeof val === 'object' && !Array.isArray(val)
                : true;
    if (!ok) {
      return `Argument "${key}" must be ${expected === 'array' ? 'an array' : `a ${expected}`}`;
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
            // Surface the write-gate so a list-then-call agent knows which tools
            // need TUCK_MCP_ALLOW_WRITE. `readOnlyHint` is a real MCP annotation.
            writeGated: WRITE_TOOLS.has(t.name),
            annotations: { readOnlyHint: !WRITE_TOOLS.has(t.name) },
          })),
        },
      };

    case 'tools/call': {
      if (!state.initialized) return rpcError(id, -32002, 'Server not initialized');
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32601, `Unknown tool: ${params.name}`);

      // `arguments` MUST be a plain object. A JSON string/number/array here would
      // otherwise make validateArgs throw on `key in args` / Object.entries and
      // reject the whole serve chain (crashing the server); report it as a TOOL
      // error instead so the host surfaces it to the model.
      const rawArgs = params.arguments ?? {};
      if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
        return toolError(id, 'Invalid arguments: "arguments" must be an object');
      }
      const args = rawArgs as Record<string, unknown>;
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        respond(rpcError(null, -32700, 'Parse error'));
        return;
      }
      // `JSON.parse('null')`/`'42'`/`'"x"'` all succeed but are not requests.
      // Without this guard, dispatch's `req.id` would throw on a null/primitive
      // and reject the serialized chain — taking the whole server down (exit 1).
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        respond(rpcError(null, -32600, 'Invalid Request'));
        return;
      }
      try {
        const resp = await dispatch(parsed as JsonRpcRequest, state);
        if (resp) respond(resp);
      } catch (err) {
        // A handler/dispatch throw must never crash the server: report it as a
        // JSON-RPC internal error and keep serving subsequent requests.
        const reqId = (parsed as { id?: string | number | null }).id ?? null;
        respond(rpcError(reqId, -32603, err instanceof Error ? err.message : String(err)));
      }
    });
    // The chain is only awaited on close; a rejected link (should be impossible
    // now that the body catches) must not surface as an unhandledRejection.
    chain = chain.catch(() => {});
  });
  // Await any in-flight request before exiting so a host that half-closes stdin
  // after its last request still receives that request's response (process.exit
  // is synchronous and would otherwise drop pending writes).
  rl.on('close', () => {
    void chain.finally(() => process.exit(0));
  });
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
