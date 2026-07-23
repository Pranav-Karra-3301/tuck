/**
 * Client config-path resolution unit tests.
 *
 * Each MCP client stores its config in a different place per OS; getting these
 * paths wrong means apply writes to a file the client never reads. We assert
 * every (client × platform) branch deterministically via the injectable
 * `clientConfigPathFor(id, platform, home)`.
 */
import { describe, it, expect } from 'vitest';
import { clientConfigPathFor, listClients } from '../../src/lib/mcp/clients.js';

const HOME = '/home/u';

describe('clientConfigPathFor — macOS', () => {
  it('resolves each client to its documented darwin path', () => {
    expect(clientConfigPathFor('claude-desktop', 'darwin', HOME)).toBe(
      '/home/u/Library/Application Support/Claude/claude_desktop_config.json'
    );
    expect(clientConfigPathFor('claude-code', 'darwin', HOME)).toBe('/home/u/.claude.json');
    expect(clientConfigPathFor('cursor', 'darwin', HOME)).toBe('/home/u/.cursor/mcp.json');
    expect(clientConfigPathFor('windsurf', 'darwin', HOME)).toBe(
      '/home/u/.codeium/windsurf/mcp_config.json'
    );
    expect(clientConfigPathFor('vscode', 'darwin', HOME)).toBe(
      '/home/u/Library/Application Support/Code/User/mcp.json'
    );
  });
});

describe('clientConfigPathFor — linux', () => {
  it('uses XDG-style ~/.config locations for GUI apps', () => {
    expect(clientConfigPathFor('claude-desktop', 'linux', HOME)).toBe(
      '/home/u/.config/Claude/claude_desktop_config.json'
    );
    expect(clientConfigPathFor('vscode', 'linux', HOME)).toBe(
      '/home/u/.config/Code/User/mcp.json'
    );
    // Home-relative clients are platform-independent.
    expect(clientConfigPathFor('claude-code', 'linux', HOME)).toBe('/home/u/.claude.json');
    expect(clientConfigPathFor('cursor', 'linux', HOME)).toBe('/home/u/.cursor/mcp.json');
  });
});

describe('clientConfigPathFor — windows', () => {
  const APPDATA = 'C:\\Users\\u\\AppData\\Roaming';

  it('honors injected %APPDATA% for Claude Desktop and VS Code', () => {
    const desktop = clientConfigPathFor('claude-desktop', 'win32', 'C:\\Users\\u', APPDATA);
    expect(desktop).toBe('C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
    expect(clientConfigPathFor('vscode', 'win32', 'C:\\Users\\u', APPDATA)).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Code\\User\\mcp.json'
    );
  });

  it('uses win32 separators for home-relative clients regardless of host OS', () => {
    expect(clientConfigPathFor('claude-code', 'win32', 'C:\\Users\\u', APPDATA)).toBe(
      'C:\\Users\\u\\.claude.json'
    );
    expect(clientConfigPathFor('cursor', 'win32', 'C:\\Users\\u', APPDATA)).toBe(
      'C:\\Users\\u\\.cursor\\mcp.json'
    );
  });

  it('falls back to AppData\\Roaming when %APPDATA% is unset', () => {
    expect(clientConfigPathFor('claude-desktop', 'win32', 'C:\\Users\\u', undefined)).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json'
    );
  });
});

describe('listClients', () => {
  it('exposes every supported client id with a display name', () => {
    const ids = listClients().map((client) => client.id);
    // Assert against an INDEPENDENTLY written literal (not MCP_CLIENT_IDS, which
    // listClients maps over — that would be a tautology). Adding or removing a
    // supported client id must break this test on purpose.
    expect(ids).toEqual(['claude-desktop', 'claude-code', 'cursor', 'windsurf', 'vscode']);
    for (const client of listClients()) {
      expect(client.displayName.length).toBeGreaterThan(0);
    }
  });
});
