/**
 * MCP fleet file management (`mcp-servers.json` under the tuck repo).
 *
 * This file IS version-controlled: it holds the user's MCP server definitions
 * (with `{{PLACEHOLDER}}` references instead of real credentials) so the fleet
 * travels with the dotfiles repo across machines. All reads validate through
 * the zod schema — the file is external data and is never `as`-cast.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { pathExists } from '../paths.js';
import {
  mcpFleetFileSchema,
  mcpServerSchema,
  type McpFleetFileOutput,
  type McpServerInput,
  type McpServerOutput,
} from '../../schemas/mcpServers.schema.js';
import { TuckError } from '../../errors.js';

/** Filename of the version-controlled fleet definition. */
export const MCP_FLEET_FILENAME = 'mcp-servers.json';

/** Absolute path to the fleet file inside a tuck repo. */
export const getMcpFleetPath = (tuckDir: string): string => join(tuckDir, MCP_FLEET_FILENAME);

/**
 * Load and validate the fleet file. A missing file yields an empty fleet; a
 * corrupt/invalid file THROWS (rather than silently discarding definitions) so
 * a typo never causes a server to vanish from every client on the next apply.
 */
export const loadFleet = async (tuckDir: string): Promise<McpFleetFileOutput> => {
  const fleetPath = getMcpFleetPath(tuckDir);
  if (!(await pathExists(fleetPath))) {
    return { version: '1', servers: {} };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(fleetPath, 'utf-8'));
  } catch (error) {
    throw new TuckError(
      `MCP fleet file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'MCP_FLEET_INVALID',
      [`Fix or delete ${MCP_FLEET_FILENAME} in your tuck repo.`]
    );
  }

  const parsed = mcpFleetFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TuckError(
      `MCP fleet file is invalid: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown error'}`,
      'MCP_FLEET_INVALID',
      [`Fix ${MCP_FLEET_FILENAME} in your tuck repo.`]
    );
  }
  return parsed.data;
};

/** Serialize a fleet to disk (pretty-printed, trailing newline for git). */
export const saveFleet = async (tuckDir: string, fleet: McpFleetFileOutput): Promise<void> => {
  const fleetPath = getMcpFleetPath(tuckDir);
  await writeFile(fleetPath, JSON.stringify(fleet, null, 2) + '\n', 'utf-8');
};

/**
 * Insert or replace a server definition. Validates the incoming definition and
 * returns whether an existing entry was overwritten.
 */
export const setServer = async (
  tuckDir: string,
  name: string,
  server: McpServerInput
): Promise<{ existed: boolean; server: McpServerOutput }> => {
  const parsed = mcpServerSchema.safeParse(server);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TuckError(
      `Invalid MCP server definition: ${issue?.message ?? 'unknown error'}`,
      'MCP_SERVER_INVALID',
      issue?.path.length ? [`Problem field: ${issue.path.join('.')}`] : undefined
    );
  }

  const fleet = await loadFleet(tuckDir);
  const existed = name in fleet.servers;
  fleet.servers[name] = parsed.data;
  await saveFleet(tuckDir, fleet);
  return { existed, server: parsed.data };
};

/** Remove a server definition. Returns false when it was not present. */
export const removeServer = async (tuckDir: string, name: string): Promise<boolean> => {
  const fleet = await loadFleet(tuckDir);
  if (!(name in fleet.servers)) return false;
  delete fleet.servers[name];
  await saveFleet(tuckDir, fleet);
  return true;
};

/** Fetch a single server definition, or null if absent. */
export const getServer = async (
  tuckDir: string,
  name: string
): Promise<McpServerOutput | null> => {
  const fleet = await loadFleet(tuckDir);
  return fleet.servers[name] ?? null;
};
