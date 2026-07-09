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
import { getSecret, setSecret } from '../../src/lib/secrets/store.js';
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
    const original = JSON.stringify({
      mcpServers: { s: { env: { API_KEY: 'realsecretvalue1234567' } } },
    });
    vol.writeFileSync(MCP_PATH, original);

    await runExtract([], { mcp: true, yes: true });

    const { getSnapshotsDir } = await import('../../src/lib/state.js');
    const snapshotsDir = getSnapshotsDir();
    expect(vol.existsSync(snapshotsDir)).toBe(true);
    // At least one snapshot directory was created.
    const entries = vol.readdirSync(snapshotsDir);
    expect(entries.length).toBeGreaterThan(0);

    // The snapshot must actually capture the PRE-REWRITE MCP contents (including
    // the original inline secret), not merely create an empty/mislabeled dir —
    // this is the recoverable copy the destructive rewrite depends on.
    const { listSnapshots } = await import('../../src/lib/timemachine.js');
    const snapshots = await listSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    const backedUp = snapshots
      .flatMap((s) => s.files)
      .find((f) => f.originalPath === MCP_PATH);
    expect(backedUp, 'the MCP file must be recorded in the snapshot').toBeDefined();
    expect(backedUp?.existed).toBe(true);
    const backedUpContent = vol.readFileSync(backedUp!.backupPath, 'utf-8') as string;
    // Byte-for-byte the original, and the live file (now rewritten) confirms the
    // snapshot was taken from the pre-rewrite state.
    expect(backedUpContent).toBe(original);
    expect(backedUpContent).toContain('realsecretvalue1234567');
    expect(vol.readFileSync(MCP_PATH, 'utf-8')).not.toContain('realsecretvalue1234567');
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

  it('never overwrites a pre-existing stored secret on a name collision', async () => {
    // A secret named GITHUB_TOKEN already exists with a DIFFERENT value. The
    // secrets store is the only cleartext copy and is not covered by the
    // pre-extract snapshot, so overwriting it would be unrecoverable.
    const PRE_EXISTING = 'ghp_' + 'preexisting'.padEnd(36, 'z');
    await setSecret(TUCK, 'GITHUB_TOKEN', PRE_EXISTING, { description: 'set by hand' });

    vol.writeFileSync(
      MCP_PATH,
      JSON.stringify({ mcpServers: { github: { env: { GITHUB_TOKEN: GH_TOKEN } } } }, null, 2)
    );

    await runExtract([], { mcp: true, yes: true });

    // The original secret is intact...
    expect(await getSecret(TUCK, 'GITHUB_TOKEN')).toBe(PRE_EXISTING);
    // ...and the newly-extracted value landed under a suffixed name instead.
    expect(await getSecret(TUCK, 'GITHUB_TOKEN_1')).toBe(GH_TOKEN);

    // The file references the NEW (suffixed) placeholder, not the old one.
    const rewritten = vol.readFileSync(MCP_PATH, 'utf-8') as string;
    expect(rewritten).not.toContain(GH_TOKEN);
    expect(rewritten).toContain('{{GITHUB_TOKEN_1}}');
  });

  it('avoids collisions with names that exist only as a mapping', async () => {
    const { setMapping } = await import('../../src/lib/secretBackends/mappings.js');
    // A committed mapping references API_KEY even though no value is stored yet.
    await setMapping(TUCK, 'API_KEY', 'local', true);

    vol.writeFileSync(
      MCP_PATH,
      JSON.stringify({ mcpServers: { s: { env: { API_KEY: 'freshsecretvalue123456' } } } })
    );

    await runExtract([], { mcp: true, yes: true });

    // The extracted value is stored under the suffixed name, leaving the
    // pre-existing mapping's namespace untouched.
    expect(await getSecret(TUCK, 'API_KEY_1')).toBe('freshsecretvalue123456');
  });

  it('does not store/rewrite values it cannot match verbatim (escape variants)', async () => {
    // `\/`-escaped value: valid JSON, parses to a slash, but re-encodes without
    // the escaped slash, so the token cannot be located in the source.
    const original = '{"mcpServers":{"s":{"env":{"API_KEY":"secret\\/value\\/abcdef123456"}}}}';
    vol.writeFileSync(MCP_PATH, original);

    await runExtract([], { mcp: true, yes: true });

    // File is untouched — the plaintext is (intentionally) still present.
    expect(vol.readFileSync(MCP_PATH, 'utf-8')).toBe(original);
    // Nothing was stored or mapped for the unmatched value.
    expect(await getSecret(TUCK, 'API_KEY')).toBeUndefined();
    expect(await getMapping(TUCK, 'API_KEY')).toBeNull();
  });

  it('does not report skipped values as extracted in JSON output', async () => {
    const original = '{"mcpServers":{"s":{"env":{"API_KEY":"secret\\/value\\/abcdef123456"}}}}';
    vol.writeFileSync(MCP_PATH, original);

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await runExtract([], { mcp: true, json: true, yes: true });

    const envelope = JSON.parse(writes.join('').trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.totalExtracted).toBe(0);
    expect(envelope.data.totalSkipped).toBe(1);
    expect(envelope.data.changed).toBe(false);
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
