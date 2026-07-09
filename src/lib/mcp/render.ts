/**
 * Pure rendering + secret injection for the MCP fleet.
 *
 * Two responsibilities, kept separate and side-effect-free so they are trivial
 * to unit test:
 *
 *   1. `collectServerPlaceholders` / `injectServerSecrets` — resolve
 *      `{{PLACEHOLDER}}` references (in command, args, env, url, headers) from a
 *      name→value map produced by tuck's secret backends.
 *   2. `renderServerEntry` — project a resolved server into ONE client's native
 *      config shape. Clients disagree on the container key (`mcpServers` vs
 *      `servers`), whether a `type` discriminator is present, and how remote
 *      transports are named — this function encodes those differences.
 *
 * Neither function touches the filesystem, the network, or any secret store.
 */

import { PLACEHOLDER_REGEX } from '../secrets/redactor.js';
import type { McpClientId, McpServerOutput } from '../../schemas/mcpServers.schema.js';

/** Serialized MCP client entry — a JSON object with string/array/object leaves. */
export type ClientServerEntry = Record<string, unknown>;

/** Collect every distinct `{{PLACEHOLDER}}` name referenced by a server. */
export const collectServerPlaceholders = (server: McpServerOutput): string[] => {
  const found = new Set<string>();
  const scan = (text: string | undefined): void => {
    if (!text) return;
    for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
      found.add(match[1]);
    }
  };

  scan(server.command);
  scan(server.url);
  for (const arg of server.args) scan(arg);
  for (const value of Object.values(server.env)) scan(value);
  for (const value of Object.values(server.headers)) scan(value);

  return [...found];
};

/**
 * Substitute `{{PLACEHOLDER}}` occurrences in a single string. A replacer
 * FUNCTION is used so `$`-sequences inside a secret ($&, $$, …) are inserted
 * literally rather than interpreted as regex replacement patterns — the same
 * corruption guard tuck's dotfile restore uses.
 */
const substitute = (
  text: string,
  secrets: Record<string, string>,
  unresolved: Set<string>
): string =>
  text.replace(PLACEHOLDER_REGEX, (whole, name: string) => {
    if (name in secrets) return secrets[name];
    unresolved.add(name);
    return whole;
  });

export interface InjectResult {
  server: McpServerOutput;
  unresolved: string[];
}

/**
 * Return a copy of `server` with every `{{PLACEHOLDER}}` replaced by its value
 * from `secrets`. Placeholders with no matching secret are left verbatim and
 * reported in `unresolved` so the caller can refuse to write a config that
 * still carries an unresolved credential.
 */
export const injectServerSecrets = (
  server: McpServerOutput,
  secrets: Record<string, string>
): InjectResult => {
  const unresolved = new Set<string>();
  const sub = (text: string): string => substitute(text, secrets, unresolved);

  const mapValues = (record: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) out[key] = sub(value);
    return out;
  };

  const resolved: McpServerOutput = {
    ...server,
    command: server.command === undefined ? undefined : sub(server.command),
    url: server.url === undefined ? undefined : sub(server.url),
    args: server.args.map(sub),
    env: mapValues(server.env),
    headers: mapValues(server.headers),
  };

  return { server: resolved, unresolved: [...unresolved] };
};

/** The container key each client nests its servers under. */
export const clientContainerKey = (client: McpClientId): 'mcpServers' | 'servers' =>
  client === 'vscode' ? 'servers' : 'mcpServers';

/**
 * Project a (secret-resolved) server into a single client's native entry shape,
 * or `null` when the client cannot express this server's transport.
 *
 * Transport support matrix:
 *   - Claude Desktop: stdio only (the GUI app has no remote-server UI).
 *   - Claude Code / Cursor / VS Code: stdio + http + sse.
 *   - Windsurf: stdio + remote via a `serverUrl` field (its own dialect).
 */
export const renderServerEntry = (
  client: McpClientId,
  server: McpServerOutput
): ClientServerEntry | null => {
  const isStdio = server.transport === 'stdio';

  if (isStdio) {
    const entry: ClientServerEntry = { command: server.command };
    if (server.args.length > 0) entry.args = [...server.args];
    if (Object.keys(server.env).length > 0) entry.env = { ...server.env };
    // VS Code discriminates every entry with an explicit `type`.
    if (client === 'vscode') return { type: 'stdio', ...entry };
    return entry;
  }

  // Remote (http/sse) transports.
  switch (client) {
    case 'claude-desktop':
      // Claude Desktop config has no remote-server format.
      return null;
    case 'windsurf': {
      // Windsurf uses `serverUrl` and does not carry a transport discriminator.
      const entry: ClientServerEntry = { serverUrl: server.url };
      if (Object.keys(server.headers).length > 0) entry.headers = { ...server.headers };
      return entry;
    }
    case 'claude-code':
    case 'cursor':
    case 'vscode': {
      const entry: ClientServerEntry = { type: server.transport, url: server.url };
      if (Object.keys(server.headers).length > 0) entry.headers = { ...server.headers };
      return entry;
    }
    default: {
      // Exhaustiveness guard: adding a client id without a case is a type error.
      const _never: never = client;
      return _never;
    }
  }
};
