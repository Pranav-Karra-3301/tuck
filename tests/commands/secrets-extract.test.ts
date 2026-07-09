/**
 * Sandboxed integration test for `tuck secrets extract --mcp`.
 *
 * Exercises the real pipeline (discovery → analysis → snapshot → store →
 * rewrite) against a memfs sandbox rooted at the mocked homedir. Only the UI
 * layer is mocked; the filesystem, secrets store, mappings, and time-machine
 * snapshot all run for real against the virtual FS. Never touches the real
 * $HOME, keychain, or network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  colors: {
    bold: Object.assign((x: string) => x, { cyan: (x: string) => x }),
    dim: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
    red: (x: string) => x,
    cyan: (x: string) => x,
    white: (x: string) => x,
  },
  logger: {
    info: vi.fn(),
    warning: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: confirmMock,
    note: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  },
}));

import { runExtract } from '../../src/commands/secrets.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { clearConfigCache } from '../../src/lib/config.js';
import { getSecret } from '../../src/lib/secrets/store.js';
import { getMapping } from '../../src/lib/secretBackends/mappings.js';

const TUCK = '/test-home/.tuck';
const MCP_PATH = '/test-home/.mcp.json';

const writeManifest = () => {
  vol.writeFileSync(
    `${TUCK}/.tuckmanifest.json`,
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: {},
      bundles: {},
    })
  );
};

const GH_TOKEN = 'ghp_' + 'a'.repeat(36);

describe('tuck secrets extract --mcp', () => {
  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
    confirmMock.mockReset();
    process.exitCode = 0;
    vol.mkdirSync(`${TUCK}/files`, { recursive: true });
    writeManifest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('rewrites inline credentials, stores them, and records a mapping', async () => {
    vol.writeFileSync(
      MCP_PATH,
      JSON.stringify(
        {
          mcpServers: {
            github: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: GH_TOKEN, NODE_ENV: 'production' },
            },
          },
        },
        null,
        2
      )
    );

    await runExtract([], { mcp: true, yes: true });

    // File rewritten: token gone, placeholder present, non-secret preserved.
    const rewritten = vol.readFileSync(MCP_PATH, 'utf-8') as string;
    expect(rewritten).not.toContain(GH_TOKEN);
    expect(rewritten).toContain('{{GITHUB_PERSONAL_ACCESS_TOKEN}}');
    expect(rewritten).toContain('"NODE_ENV": "production"');
    expect(() => JSON.parse(rewritten)).not.toThrow();

    // Secret stored locally with the real value.
    const stored = await getSecret(TUCK, 'GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(stored).toBe(GH_TOKEN);

    // Committed mapping records that the placeholder resolves locally.
    const mapping = await getMapping(TUCK, 'GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(mapping?.local).toBe(true);
  });

  it('creates a snapshot backup before rewriting', async () => {
    vol.writeFileSync(
      MCP_PATH,
      JSON.stringify({ mcpServers: { s: { env: { API_KEY: 'realsecretvalue1234567' } } } })
    );

    await runExtract([], { mcp: true, yes: true });

    const { getSnapshotsDir } = await import('../../src/lib/state.js');
    const snapshotsDir = getSnapshotsDir();
    expect(vol.existsSync(snapshotsDir)).toBe(true);
    // At least one snapshot directory was created.
    const entries = vol.readdirSync(snapshotsDir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('dry-run does not modify files or store secrets', async () => {
    const original = JSON.stringify({
      mcpServers: { s: { env: { API_KEY: 'realsecretvalue1234567' } } },
    });
    vol.writeFileSync(MCP_PATH, original);

    await runExtract([], { mcp: true, dryRun: true, yes: true });

    expect(vol.readFileSync(MCP_PATH, 'utf-8')).toBe(original);
    expect(await getSecret(TUCK, 'API_KEY')).toBeUndefined();
  });

  it('cancelling the confirmation makes no changes', async () => {
    const original = JSON.stringify({
      mcpServers: { s: { env: { API_KEY: 'realsecretvalue1234567' } } },
    });
    vol.writeFileSync(MCP_PATH, original);
    confirmMock.mockResolvedValue(false);

    await runExtract([], { mcp: true });

    expect(vol.readFileSync(MCP_PATH, 'utf-8')).toBe(original);
    expect(await getSecret(TUCK, 'API_KEY')).toBeUndefined();
  });

  it('does nothing when the config has no inline credentials', async () => {
    const original = JSON.stringify({ mcpServers: { s: { env: { NODE_ENV: 'production' } } } });
    vol.writeFileSync(MCP_PATH, original);

    await runExtract([], { mcp: true, yes: true });

    expect(vol.readFileSync(MCP_PATH, 'utf-8')).toBe(original);
  });

  it('emits a redacted JSON envelope without leaking values', async () => {
    vol.writeFileSync(
      MCP_PATH,
      JSON.stringify({ mcpServers: { github: { env: { GITHUB_TOKEN: GH_TOKEN } } } })
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await runExtract([], { mcp: true, json: true, yes: true });

    const output = writes.join('');
    expect(output).not.toContain(GH_TOKEN);
    const envelope = JSON.parse(output.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.totalExtracted).toBe(1);
    expect(envelope.data.files[0].credentials[0].placeholder).toBe('GITHUB_TOKEN');
    expect(JSON.stringify(envelope)).not.toContain(GH_TOKEN);
  });
});
