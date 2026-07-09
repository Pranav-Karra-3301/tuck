import { z } from 'zod';

/**
 * MCP fleet definition (`mcp-servers.json` under the tuck repo).
 *
 * This file is the single, git-versioned source of truth for a user's Model
 * Context Protocol servers. Each server is declared ONCE here (name, transport,
 * command/url, env, headers) and `tuck mcp render`/`tuck mcp apply` project it
 * into every MCP client's native config format (Claude Desktop, Claude Code,
 * Cursor, Windsurf, VS Code).
 *
 * Credentials are NEVER stored here. Any `{{PLACEHOLDER}}` inside an env value,
 * header value, url, command, or arg is resolved from tuck's secret backends at
 * apply time — mirroring how tracked dotfiles handle secrets. The file is safe
 * to commit because it only ever holds placeholders, never real secrets.
 *
 * Validated (never `as`-cast) since it is read off disk.
 */

/** MCP transport kinds tuck understands. */
export const mcpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** Supported MCP client targets. */
export const mcpClientIdSchema = z.enum([
  'claude-desktop',
  'claude-code',
  'cursor',
  'windsurf',
  'vscode',
]);
export type McpClientId = z.infer<typeof mcpClientIdSchema>;

/** All known client ids, ordered for stable output. */
export const MCP_CLIENT_IDS: readonly McpClientId[] = [
  'claude-desktop',
  'claude-code',
  'cursor',
  'windsurf',
  'vscode',
] as const;

/**
 * A single MCP server definition.
 *
 * `command`/`args`/`env` describe a `stdio` server (a local process); `url`/
 * `headers` describe a remote `http`/`sse` server. A `.refine` enforces that
 * the fields present match the declared transport so a malformed definition is
 * rejected at load time rather than silently rendering an unusable client entry.
 */
export const mcpServerSchema = z
  .object({
    /** Transport kind. Defaults to stdio (the overwhelmingly common case). */
    transport: mcpTransportSchema.default('stdio'),
    /** Executable for a stdio server (e.g. `npx`, `uvx`, an absolute path). */
    command: z.string().min(1).optional(),
    /** Arguments passed to `command`. */
    args: z.array(z.string()).default([]),
    /** Environment variables for a stdio server; values may hold `{{SECRET}}`. */
    env: z.record(z.string()).default({}),
    /** Endpoint URL for a remote (http/sse) server; may hold `{{SECRET}}`. */
    url: z.string().min(1).optional(),
    /** HTTP headers for a remote server; values may hold `{{SECRET}}`. */
    headers: z.record(z.string()).default({}),
    /** Human-readable description. */
    description: z.string().optional(),
    /**
     * Which clients this server renders to. Omitted / empty ⇒ every supported
     * client. Lets a user scope, e.g., a JetBrains-only server away from others.
     */
    clients: z.array(mcpClientIdSchema).default([]),
    /** When false, the server is retained in the fleet but skipped on apply. */
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((s) => (s.transport === 'stdio' ? !!s.command : true), {
    message: 'A stdio MCP server requires a "command".',
    path: ['command'],
  })
  .refine((s) => (s.transport === 'stdio' ? !s.url : true), {
    message: 'A stdio MCP server cannot have a "url".',
    path: ['url'],
  })
  .refine((s) => (s.transport !== 'stdio' ? !!s.url : true), {
    message: 'A remote (http/sse) MCP server requires a "url".',
    path: ['url'],
  })
  .refine((s) => (s.transport !== 'stdio' ? !s.command : true), {
    message: 'A remote (http/sse) MCP server cannot have a "command".',
    path: ['command'],
  });

export type McpServerInput = z.input<typeof mcpServerSchema>;
export type McpServerOutput = z.output<typeof mcpServerSchema>;

/** Server names: safe for use as JSON keys and client identifiers. */
export const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_.-]+$/u;

export const mcpFleetFileSchema = z.object({
  version: z.literal('1').default('1'),
  servers: z
    .record(mcpServerSchema)
    .default({})
    .refine((servers) => Object.keys(servers).every((name) => MCP_SERVER_NAME_RE.test(name)), {
      message:
        'MCP server names may only contain letters, digits, dot, dash, and underscore.',
    }),
});

export type McpFleetFileInput = z.input<typeof mcpFleetFileSchema>;
export type McpFleetFileOutput = z.output<typeof mcpFleetFileSchema>;
