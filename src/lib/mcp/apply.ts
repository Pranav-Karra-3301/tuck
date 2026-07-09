/**
 * Fleet → client projection: decide which servers target which client, inject
 * secrets, render each into its client shape, and merge into the client's
 * existing config WITHOUT clobbering servers or keys tuck doesn't manage.
 *
 * The merge (`mergeClientConfig`) is a pure function: it takes the parsed
 * existing config and returns the new object. The command layer owns all I/O
 * (reading the file, backing it up, writing it back).
 */

import type {
  McpClientId,
  McpFleetFileOutput,
  McpServerOutput,
} from '../../schemas/mcpServers.schema.js';
import {
  clientContainerKey,
  injectServerSecrets,
  renderServerEntry,
  type ClientServerEntry,
} from './render.js';

/** True when a server should render to `client` (empty `clients` ⇒ all). */
export const serverTargetsClient = (server: McpServerOutput, client: McpClientId): boolean =>
  server.enabled && (server.clients.length === 0 || server.clients.includes(client));

export interface RenderedServer {
  name: string;
  entry: ClientServerEntry;
}

export interface RenderClientResult {
  /** Container key the entries nest under (`mcpServers` or `servers`). */
  containerKey: 'mcpServers' | 'servers';
  /** Successfully rendered entries, keyed for merge. */
  rendered: RenderedServer[];
  /** Servers skipped because the client can't express their transport. */
  unsupported: string[];
  /** Placeholder names that had no secret; blocks a real write. */
  unresolved: string[];
}

/**
 * Render every fleet server that targets `client`, injecting secrets from
 * `secrets` (a placeholder→value map). Does not touch disk.
 */
export const renderClient = (
  fleet: McpFleetFileOutput,
  client: McpClientId,
  secrets: Record<string, string>
): RenderClientResult => {
  const rendered: RenderedServer[] = [];
  const unsupported: string[] = [];
  const unresolved = new Set<string>();

  for (const [name, server] of Object.entries(fleet.servers)) {
    if (!serverTargetsClient(server, client)) continue;

    const injected = injectServerSecrets(server, secrets);
    const entry = renderServerEntry(client, injected.server);
    if (entry === null) {
      // Skipped because the client can't express this transport — its secrets
      // are irrelevant to what we'd write, so don't count them as unresolved.
      unsupported.push(name);
      continue;
    }
    for (const missing of injected.unresolved) unresolved.add(missing);
    rendered.push({ name, entry });
  }

  return {
    containerKey: clientContainerKey(client),
    rendered,
    unsupported,
    unresolved: [...unresolved],
  };
};

/**
 * Merge rendered entries into a client's existing config object.
 *
 * Preserves every unrelated top-level key (Claude Code's `~/.claude.json` is a
 * 1300-line monolith — we must never drop conversation history or machine keys)
 * and every server the fleet does not manage. Managed servers are upserted by
 * name. Returns a NEW object; the input is not mutated.
 */
export const mergeClientConfig = (
  existing: Record<string, unknown> | undefined,
  containerKey: 'mcpServers' | 'servers',
  rendered: RenderedServer[]
): Record<string, unknown> => {
  const base: Record<string, unknown> = existing ? { ...existing } : {};

  const priorContainer = base[containerKey];
  const container: Record<string, unknown> =
    priorContainer && typeof priorContainer === 'object' && !Array.isArray(priorContainer)
      ? { ...(priorContainer as Record<string, unknown>) }
      : {};

  for (const { name, entry } of rendered) {
    container[name] = entry;
  }

  base[containerKey] = container;
  return base;
};
