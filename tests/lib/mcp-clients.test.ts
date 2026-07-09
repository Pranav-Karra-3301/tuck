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
import { MCP_CLIENT_IDS } from '../../src/schemas/mcpServers.schema.js';

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
  it('honors %APPDATA% for Claude Desktop and VS Code', () => {
    const orig = process.env.APPDATA;
    try {
      process.env.APPDATA = 'C:\\Users\\u\\AppData\\Roaming';
      const desktop = clientConfigPathFor('claude-desktop', 'win32', 'C:\\Users\\u');
      expect(desktop).toContain('Claude');
      expect(desktop).toContain('claude_desktop_config.json');
      expect(desktop).toContain('AppData');
      expect(clientConfigPathFor('vscode', 'win32', 'C:\\Users\\u')).toContain('Code');
    } finally {
      if (orig === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = orig;
    }
  });

  it('falls back to AppData\\Roaming when %APPDATA% is unset', () => {
    const orig = process.env.APPDATA;
    try {
      delete process.env.APPDATA;
      expect(clientConfigPathFor('claude-desktop', 'win32', 'C:\\Users\\u')).toContain(
        'AppData'
      );
    } finally {
      if (orig !== undefined) process.env.APPDATA = orig;
    }
  });
});

describe('listClients', () => {
  it('exposes every supported client id with a display name', () => {
    const ids = listClients().map((client) => client.id);
    expect(ids).toEqual([...MCP_CLIENT_IDS]);
    for (const client of listClients()) {
      expect(client.displayName.length).toBeGreaterThan(0);
    }
  });
});
