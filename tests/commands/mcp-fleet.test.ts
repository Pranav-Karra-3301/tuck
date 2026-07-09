/**
 * `tuck mcp` fleet command integration tests (sandboxed, memfs-backed).
 *
 * Exercises the add → apply workflow end-to-end against fake client config
 * files inside a temp $HOME. NEVER touches the real home, keychain, or network:
 * the secret resolver is mocked so credential injection is deterministic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { TEST_TUCK_DIR } from '../setup.js';

// Mock the secret resolver: apply/render must inject credentials WITHOUT hitting
// a real backend. resolveToMap returns whatever secrets the test set up.
const resolveToMapMock = vi.fn(async () => ({}) as Record<string, string>);
const lockAllMock = vi.fn(async () => {});
vi.mock('../../src/lib/secretBackends/index.js', () => ({
  createResolver: () => ({ resolveToMap: resolveToMapMock, lockAll: lockAllMock }),
}));

// Silence UI; force non-interactive so no clack prompt is invoked.
vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    text: vi.fn(),
    select: vi.fn(),
    note: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    cyan: (x: string) => x,
    dim: (x: string) => x,
    bold: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
    red: (x: string) => x,
  },
}));

import { addAction, applyAction, removeAction } from '../../src/commands/mcpFleet.js';
import { getServer, loadFleet } from '../../src/lib/mcp/fleet.js';
import { resolveClientConfigPath } from '../../src/lib/mcp/clients.js';
import { clearConfigCache } from '../../src/lib/config.js';

const writeManifest = async (): Promise<void> => {
  const manifest = {
    version: '1.0.0',
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    files: {},
    bundles: { default: { created: '2024-01-01T00:00:00.000Z' } },
  };
  await writeFile(`${TEST_TUCK_DIR}/.tuckmanifest.json`, JSON.stringify(manifest), 'utf-8');
};

beforeEach(async () => {
  vol.reset();
  vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  clearConfigCache();
  resolveToMapMock.mockReset();
  resolveToMapMock.mockResolvedValue({});
  lockAllMock.mockClear();
  await writeManifest();
});

describe('tuck mcp add', () => {
  it('requires initialization', async () => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    await expect(addAction('x', { command: 'npx' })).rejects.toThrow();
  });

  it('persists a stdio server definition to the fleet file', async () => {
    await addAction('github', {
      command: 'npx',
      arg: ['-y', '@modelcontextprotocol/server-github'],
      env: ['GITHUB_TOKEN={{GITHUB_TOKEN}}'],
    });

    const server = await getServer(TEST_TUCK_DIR, 'github');
    expect(server?.transport).toBe('stdio');
    expect(server?.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(server?.env.GITHUB_TOKEN).toBe('{{GITHUB_TOKEN}}');
  });

  it('rejects a malformed --env pair', async () => {
    await expect(addAction('x', { command: 'npx', env: ['NOEQUALS'] })).rejects.toThrow(
      /Invalid --env/iu
    );
  });

  it('rejects an unknown --client', async () => {
    await expect(
      addAction('x', { command: 'npx', client: ['emacs'] })
    ).rejects.toThrow(/Unknown MCP client/iu);
  });

  it('rejects an invalid server name', async () => {
    await expect(addAction('bad name', { command: 'npx' })).rejects.toThrow(/Invalid MCP server name/iu);
  });
});

describe('tuck mcp apply', () => {
  it('renders a stdio server into every default client config, injecting secrets', async () => {
    resolveToMapMock.mockResolvedValue({ GITHUB_TOKEN: 'ghp_secret' });
    await addAction('github', {
      command: 'npx',
      env: ['GITHUB_TOKEN={{GITHUB_TOKEN}}'],
    });

    await applyAction({ yes: true });

    // Cursor: mcpServers container, secret injected, no leftover placeholder.
    const cursorPath = resolveClientConfigPath('cursor');
    const cursor = JSON.parse(await readFile(cursorPath, 'utf-8'));
    expect(cursor.mcpServers.github.command).toBe('npx');
    expect(cursor.mcpServers.github.env.GITHUB_TOKEN).toBe('ghp_secret');

    // VS Code: servers container with an explicit type discriminator.
    const vscodePath = resolveClientConfigPath('vscode');
    const vscode = JSON.parse(await readFile(vscodePath, 'utf-8'));
    expect(vscode.servers.github.type).toBe('stdio');
    expect(vscode.servers.github.env.GITHUB_TOKEN).toBe('ghp_secret');
  });

  const seedClientConfig = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  };

  it('preserves unrelated keys in an existing client monolith', async () => {
    const claudePath = resolveClientConfigPath('claude-code');
    await writeFile(
      claudePath,
      JSON.stringify({ numStartups: 7, mcpServers: { existing: { command: 'keep' } } }),
      'utf-8'
    );

    await addAction('new', { command: 'npx' });
    await applyAction({ yes: true, client: ['claude-code'] });

    const claude = JSON.parse(await readFile(claudePath, 'utf-8'));
    expect(claude.numStartups).toBe(7);
    expect(claude.mcpServers.existing).toEqual({ command: 'keep' });
    expect(claude.mcpServers.new).toEqual({ command: 'npx' });
  });

  it('backs up an existing client config before overwriting it', async () => {
    const cursorPath = resolveClientConfigPath('cursor');
    await seedClientConfig(cursorPath, JSON.stringify({ mcpServers: {} }));

    await addAction('srv', { command: 'npx' });
    await applyAction({ yes: true, client: ['cursor'] });

    // A dated backup dir is created under ~/.tuck-backups.
    const backupRoot = '/test-home/.tuck-backups';
    expect(vol.existsSync(backupRoot)).toBe(true);
  });

  it('refuses to write when a referenced secret cannot be resolved', async () => {
    resolveToMapMock.mockResolvedValue({}); // nothing resolves
    await addAction('srv', { command: 'npx', env: ['K={{MISSING_SECRET}}'] });

    await expect(applyAction({ yes: true, client: ['cursor'] })).rejects.toThrow(
      /unresolved secret/iu
    );

    // No client file was written.
    expect(vol.existsSync(resolveClientConfigPath('cursor'))).toBe(false);
  });

  it('does nothing when no servers are defined', async () => {
    await applyAction({ yes: true });
    expect(vol.existsSync(resolveClientConfigPath('cursor'))).toBe(false);
  });

  it('dry-run reports a plan without writing any file', async () => {
    await addAction('srv', { command: 'npx' });
    await applyAction({ dryRun: true });
    expect(vol.existsSync(resolveClientConfigPath('cursor'))).toBe(false);
  });

  it('only writes the requested client when --client is scoped', async () => {
    await addAction('srv', { command: 'npx' });
    await applyAction({ yes: true, client: ['cursor'] });

    expect(vol.existsSync(resolveClientConfigPath('cursor'))).toBe(true);
    expect(vol.existsSync(resolveClientConfigPath('windsurf'))).toBe(false);
  });

  it('refuses to clobber a client config that is not valid JSON', async () => {
    const cursorPath = resolveClientConfigPath('cursor');
    await seedClientConfig(cursorPath, '{ broken');
    await addAction('srv', { command: 'npx' });

    await expect(applyAction({ yes: true, client: ['cursor'] })).rejects.toThrow(
      /not valid JSON/iu
    );
    // Original file is untouched.
    expect(await readFile(cursorPath, 'utf-8')).toBe('{ broken');
  });
});

describe('tuck mcp remove', () => {
  it('removes a server without touching client files', async () => {
    await addAction('srv', { command: 'npx' });
    await removeAction('srv', { force: true });
    const fleet = await loadFleet(TEST_TUCK_DIR);
    expect(fleet.servers.srv).toBeUndefined();
  });

  it('errors on an unknown server', async () => {
    await expect(removeAction('ghost', { force: true })).rejects.toThrow(/not found/iu);
  });
});
