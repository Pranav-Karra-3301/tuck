/**
 * Fleet file persistence + merge unit tests (memfs-backed).
 *
 * The fleet file is version-controlled external data: load must validate it and
 * refuse to silently drop a malformed definition, and the client merge must
 * never clobber keys or servers tuck does not manage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { readFile, writeFile } from 'fs/promises';
import { TEST_TUCK_DIR } from '../setup.js';
import {
  loadFleet,
  saveFleet,
  setServer,
  removeServer,
  getServer,
  getMcpFleetPath,
} from '../../src/lib/mcp/fleet.js';
import { renderClient, serverTargetsClient, mergeClientConfig } from '../../src/lib/mcp/apply.js';
import { mcpServerSchema } from '../../src/schemas/mcpServers.schema.js';

const fleetPath = getMcpFleetPath(TEST_TUCK_DIR);

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
});

describe('fleet persistence', () => {
  it('returns an empty fleet when no file exists', async () => {
    const fleet = await loadFleet(TEST_TUCK_DIR);
    expect(fleet).toEqual({ version: '1', servers: {} });
  });

  it('round-trips a server through setServer/getServer/disk', async () => {
    await setServer(TEST_TUCK_DIR, 'github', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '{{GITHUB_TOKEN}}' },
    });

    const server = await getServer(TEST_TUCK_DIR, 'github');
    expect(server?.command).toBe('npx');
    expect(server?.env.GITHUB_TOKEN).toBe('{{GITHUB_TOKEN}}');

    const raw = JSON.parse(await readFile(fleetPath, 'utf-8'));
    expect(raw.version).toBe('1');
    expect(raw.servers.github.command).toBe('npx');
  });

  it('reports whether setServer overwrote an existing entry', async () => {
    const first = await setServer(TEST_TUCK_DIR, 'x', { command: 'a' });
    expect(first.existed).toBe(false);
    const second = await setServer(TEST_TUCK_DIR, 'x', { command: 'b' });
    expect(second.existed).toBe(true);
  });

  it('removeServer returns false for an unknown server', async () => {
    expect(await removeServer(TEST_TUCK_DIR, 'nope')).toBe(false);
  });

  it('removeServer deletes an existing server', async () => {
    await setServer(TEST_TUCK_DIR, 'gone', { command: 'x' });
    expect(await removeServer(TEST_TUCK_DIR, 'gone')).toBe(true);
    expect(await getServer(TEST_TUCK_DIR, 'gone')).toBeNull();
  });

  it('rejects a stdio server with no command', async () => {
    await expect(setServer(TEST_TUCK_DIR, 'bad', { transport: 'stdio' })).rejects.toThrow(
      /command/iu
    );
  });

  it('rejects a remote server with no url', async () => {
    await expect(setServer(TEST_TUCK_DIR, 'bad', { transport: 'http' })).rejects.toThrow(
      /url/iu
    );
  });

  it('throws (does not silently reset) on a corrupt fleet file', async () => {
    await writeFile(fleetPath, '{ not json', 'utf-8');
    await expect(loadFleet(TEST_TUCK_DIR)).rejects.toThrow(/not valid JSON/iu);
  });

  it('throws on a schema-invalid fleet file', async () => {
    await saveFleet(TEST_TUCK_DIR, {
      version: '1',
      // @ts-expect-error deliberately invalid to test the loader guard
      servers: { bad: { transport: 'stdio' } },
    });
    await expect(loadFleet(TEST_TUCK_DIR)).rejects.toThrow(/invalid/iu);
  });
});

describe('serverTargetsClient', () => {
  const parse = (input: unknown) => mcpServerSchema.parse(input);

  it('targets all clients when clients is empty', () => {
    const s = parse({ command: 'x' });
    expect(serverTargetsClient(s, 'cursor')).toBe(true);
    expect(serverTargetsClient(s, 'vscode')).toBe(true);
  });

  it('respects an explicit client allowlist', () => {
    const s = parse({ command: 'x', clients: ['cursor'] });
    expect(serverTargetsClient(s, 'cursor')).toBe(true);
    expect(serverTargetsClient(s, 'vscode')).toBe(false);
  });

  it('never targets a disabled server', () => {
    const s = parse({ command: 'x', enabled: false });
    expect(serverTargetsClient(s, 'cursor')).toBe(false);
  });
});

describe('renderClient', () => {
  it('injects secrets and collects unsupported transports', async () => {
    await setServer(TEST_TUCK_DIR, 'stdio-one', {
      command: 'npx',
      env: { TOKEN: '{{TOK}}' },
    });
    await setServer(TEST_TUCK_DIR, 'remote-one', {
      transport: 'http',
      url: 'https://api.example.com',
    });
    const fleet = await loadFleet(TEST_TUCK_DIR);

    const result = renderClient(fleet, 'claude-desktop', { TOK: 'secret123' });
    // stdio renders; remote is unsupported on Claude Desktop.
    expect(result.rendered.map((r) => r.name)).toEqual(['stdio-one']);
    expect(result.rendered[0].entry.env).toEqual({ TOKEN: 'secret123' });
    expect(result.unsupported).toEqual(['remote-one']);
    expect(result.unresolved).toEqual([]);
  });

  it('reports unresolved placeholders when a secret is missing', async () => {
    await setServer(TEST_TUCK_DIR, 'srv', { command: 'npx', env: { K: '{{MISSING}}' } });
    const fleet = await loadFleet(TEST_TUCK_DIR);
    const result = renderClient(fleet, 'cursor', {});
    expect(result.unresolved).toEqual(['MISSING']);
  });
});

describe('mergeClientConfig', () => {
  it('preserves unrelated top-level keys (the ~/.claude.json monolith case)', () => {
    const existing = {
      numStartups: 42,
      projects: { '/x': {} },
      mcpServers: { handAdded: { command: 'keep-me' } },
    };
    const merged = mergeClientConfig(existing, 'mcpServers', [
      { name: 'tuckManaged', entry: { command: 'npx' } },
    ]);

    expect(merged.numStartups).toBe(42);
    expect(merged.projects).toEqual({ '/x': {} });
    expect((merged.mcpServers as Record<string, unknown>).handAdded).toEqual({
      command: 'keep-me',
    });
    expect((merged.mcpServers as Record<string, unknown>).tuckManaged).toEqual({
      command: 'npx',
    });
  });

  it('overwrites a same-named managed server', () => {
    const existing = { mcpServers: { s: { command: 'old' } } };
    const merged = mergeClientConfig(existing, 'mcpServers', [
      { name: 's', entry: { command: 'new' } },
    ]);
    expect((merged.mcpServers as Record<string, unknown>).s).toEqual({ command: 'new' });
  });

  it('creates the container on an empty config and does not mutate the input', () => {
    const existing = {};
    const merged = mergeClientConfig(existing, 'servers', [
      { name: 's', entry: { type: 'stdio', command: 'x' } },
    ]);
    expect(merged.servers).toEqual({ s: { type: 'stdio', command: 'x' } });
    expect(existing).toEqual({});
  });

  it('replaces a non-object container defensively', () => {
    const merged = mergeClientConfig({ mcpServers: 'oops' }, 'mcpServers', [
      { name: 's', entry: { command: 'x' } },
    ]);
    expect(merged.mcpServers).toEqual({ s: { command: 'x' } });
  });
});
