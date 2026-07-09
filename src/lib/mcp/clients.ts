/**
 * MCP client registry: display names + platform-aware config file locations.
 *
 * Each supported client stores its MCP config in a different place per OS. This
 * table is the single source of truth for those paths; the resolver returns an
 * absolute path (already run through `expandPath`) for the current platform.
 *
 * Paths are intentionally data, not behavior, so they can be unit-tested by
 * overriding the platform + home without touching the filesystem.
 */

import path from 'path';
import { expandPath } from '../paths.js';
import { MCP_CLIENT_IDS, type McpClientId } from '../../schemas/mcpServers.schema.js';

export type ClientPlatform = 'darwin' | 'linux' | 'win32';

export interface McpClientInfo {
  id: McpClientId;
  displayName: string;
}

const CLIENT_DISPLAY_NAMES: Record<McpClientId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  vscode: 'VS Code',
};

/** All supported clients with their human-readable names, in stable order. */
export const listClients = (): McpClientInfo[] =>
  MCP_CLIENT_IDS.map((id) => ({ id, displayName: CLIENT_DISPLAY_NAMES[id] }));

export const clientDisplayName = (id: McpClientId): string => CLIENT_DISPLAY_NAMES[id];

/** Resolve `%APPDATA%` on Windows, falling back to the conventional location. */
const windowsAppData = (
  home: string,
  join: typeof path.win32.join,
  appData: string | undefined
): string => (appData && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming'));

/**
 * Compute a client's config path for a given platform + home directory.
 *
 * Exposed with explicit `platform`/`home` params (rather than reading globals)
 * so tests can assert every OS branch deterministically. `resolveClientConfigPath`
 * wraps it for real use with the current process platform and `expandPath('~')`.
 *
 * The path separator is chosen from `platform` (not the host OS) so that a
 * Windows CI runner still produces posix `darwin`/`linux` paths and vice versa.
 * `%APPDATA%` is injected by the caller (`resolveClientConfigPath` passes
 * `process.env.APPDATA`) so this function stays pure — an explicit `undefined`
 * always exercises the fallback, regardless of the host machine's environment.
 */
export const clientConfigPathFor = (
  id: McpClientId,
  platform: ClientPlatform,
  home: string,
  appData?: string
): string => {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;

  switch (id) {
    case 'claude-desktop':
      if (platform === 'darwin')
        return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      if (platform === 'win32')
        return join(windowsAppData(home, join, appData), 'Claude', 'claude_desktop_config.json');
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');

    case 'claude-code':
      // Claude Code's global config is a home-directory monolith on every OS.
      return join(home, '.claude.json');

    case 'cursor':
      return join(home, '.cursor', 'mcp.json');

    case 'windsurf':
      return join(home, '.codeium', 'windsurf', 'mcp_config.json');

    case 'vscode':
      if (platform === 'darwin')
        return join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
      if (platform === 'win32')
        return join(windowsAppData(home, join, appData), 'Code', 'User', 'mcp.json');
      return join(home, '.config', 'Code', 'User', 'mcp.json');

    default: {
      const _never: never = id;
      return _never;
    }
  }
};

const currentPlatform = (): ClientPlatform => {
  const p = process.platform;
  if (p === 'darwin' || p === 'win32') return p;
  return 'linux';
};

/** Absolute config path for a client on the current machine. */
export const resolveClientConfigPath = (id: McpClientId): string =>
  clientConfigPathFor(id, currentPlatform(), expandPath('~'), process.env.APPDATA);
