/**
 * tuck verify sandbox tests — `--root` confinement and `--apply` dry-apply diff.
 *
 * These cover the "sandboxed preview" story: an agent must be able to preview
 * what `tuck apply` WOULD do (created/modified/unchanged per file, smart-merge
 * conflicts, and any path that would escape the sandbox) WITHOUT touching the
 * operator's real ~. All writes are confined to a memfs sandbox root; the live
 * comparison reads the real (memfs) home read-only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { resolve } from 'path';

// Mock the UI layer so logger.* (which prepareFilesToApply uses for skipped
// entries) does not pollute stdout — the only thing we parse is the JSON
// envelope emitted via process.stdout.write by emitJsonOk.
vi.mock('../../src/ui/index.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    warning: (x: string) => x,
    dim: (x: string) => x,
    green: (x: string) => x,
    yellow: (x: string) => x,
  },
}));

import { runVerify } from '../../src/commands/verify.js';
import { clearManifestCache } from '../../src/lib/manifest.js';
import { clearConfigCache } from '../../src/lib/config.js';
import {
  resetWriteContext,
  setWriteContext,
  getWriteRoot,
  isSandbox,
} from '../../src/lib/writeContext.js';

const TUCK = '/test-home/.tuck';
const SANDBOX = '/test-home/sandbox';

interface ManifestFileInput {
  source: string;
  destination: string;
  category?: string;
  checksum: string;
}

const writeManifestFiles = (files: Record<string, ManifestFileInput>) => {
  const fileEntries: Record<string, unknown> = {};
  for (const [id, f] of Object.entries(files)) {
    fileEntries[id] = {
      source: f.source,
      destination: f.destination,
      category: f.category ?? 'shell',
      strategy: 'copy',
      checksum: f.checksum,
      added: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    };
  }
  vol.writeFileSync(
    `${TUCK}/.tuckmanifest.json`,
    JSON.stringify({
      version: '1',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      files: fileEntries,
      bundles: {},
    })
  );
};

const checksum = async (path: string): Promise<string> => {
  const { getFileChecksum } = await import('../../src/lib/files.js');
  return getFileChecksum(path);
};

describe('verify --root / --apply', () => {
  let writes: string[];

  beforeEach(() => {
    vol.reset();
    clearManifestCache();
    clearConfigCache();
    resetWriteContext();
    process.exitCode = 0;
    vol.mkdirSync('/test-home', { recursive: true });
    vol.mkdirSync(`${TUCK}/files/shell`, { recursive: true });
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      writes.push(String(c));
      return true;
    });
  });

  afterEach(() => {
    resetWriteContext();
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  const envelope = () => JSON.parse(writes.join('').trim());

  it('--root confines target resolution under the sandbox root (writes nothing to real home)', async () => {
    // Repo copy exists; live file is absent → would be a "created" change.
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'export A=1\n');
    writeManifestFiles({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        checksum: await checksum(`${TUCK}/files/shell/zshrc`),
      },
    });

    await runVerify({ json: true, apply: true, root: SANDBOX });

    const env = envelope();
    expect(env.ok).toBe(true);
    const change = env.data.changes.find((ch: { target: string }) => ch.target.includes('.zshrc'));
    expect(change).toBeTruthy();
    // The resolved write target is confined under the sandbox root.
    expect(resolve(change.target).startsWith(resolve(SANDBOX))).toBe(true);
    // The real live home file was never created by the preview.
    expect(vol.existsSync('/test-home/.zshrc')).toBe(false);
  });

  it('restores a prior global sandbox boundary after --apply (does not nuke it)', async () => {
    // Simulate a global --root installed by the CLI preAction hook — the danger
    // case is long-running (MCP) mode, where a blind reset would drop the global
    // sandbox and let later commands write to the real home.
    const globalRoot = '/test-home/global-sandbox';
    setWriteContext({ root: globalRoot, isSandbox: true });

    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'export A=1\n');
    writeManifestFiles({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        checksum: await checksum(`${TUCK}/files/shell/zshrc`),
      },
    });

    // --apply with NO command-level --root → uses an internal temp sandbox, then
    // must RESTORE the global boundary in its finally (not reset to null).
    await runVerify({ json: true, apply: true });

    expect(resolve(getWriteRoot())).toBe(resolve(globalRoot));
    expect(isSandbox()).toBe(true);
  });

  it('classifies created / modified / unchanged correctly against the live target', async () => {
    // created: repo has it, live does not.
    vol.writeFileSync(`${TUCK}/files/shell/newrc`, 'NEW\n');
    // modified: repo differs from live.
    vol.writeFileSync(`${TUCK}/files/shell/modrc`, 'REPO VERSION\n');
    vol.writeFileSync('/test-home/.modrc', 'LIVE VERSION\n');
    // unchanged: repo equals live.
    vol.writeFileSync(`${TUCK}/files/shell/samerc`, 'SAME\n');
    vol.writeFileSync('/test-home/.samerc', 'SAME\n');

    writeManifestFiles({
      newrc: {
        source: '~/.newrc',
        destination: 'files/shell/newrc',
        checksum: await checksum(`${TUCK}/files/shell/newrc`),
      },
      modrc: {
        source: '~/.modrc',
        destination: 'files/shell/modrc',
        checksum: await checksum(`${TUCK}/files/shell/modrc`),
      },
      samerc: {
        source: '~/.samerc',
        destination: 'files/shell/samerc',
        checksum: await checksum(`${TUCK}/files/shell/samerc`),
      },
    });

    await runVerify({ json: true, apply: true, root: SANDBOX });

    const env = envelope();
    const byTarget = (needle: string) =>
      env.data.changes.find((ch: { target: string }) => ch.target.includes(needle));

    expect(byTarget('.newrc').status).toBe('created');
    expect(byTarget('.modrc').status).toBe('modified');
    expect(byTarget('.samerc').status).toBe('unchanged');

    // bytesBefore/bytesAfter are surfaced.
    expect(byTarget('.newrc').bytesBefore).toBe(0);
    expect(byTarget('.newrc').bytesAfter).toBe('NEW\n'.length);
    expect(byTarget('.modrc').bytesBefore).toBe('LIVE VERSION\n'.length);
  });

  it('reports a traversal/escaping manifest entry in wouldEscapeRoot and writes NOTHING', async () => {
    // A safe entry alongside an escaping one.
    vol.writeFileSync(`${TUCK}/files/shell/okrc`, 'OK\n');
    vol.writeFileSync(`${TUCK}/files/shell/evil`, 'PWNED\n');

    writeManifestFiles({
      okrc: {
        source: '~/.okrc',
        destination: 'files/shell/okrc',
        checksum: await checksum(`${TUCK}/files/shell/okrc`),
      },
      evil: {
        // A source that escapes the home/sandbox via traversal.
        source: '~/../../etc/passwd',
        destination: 'files/shell/evil',
        checksum: await checksum(`${TUCK}/files/shell/evil`),
      },
    });

    await runVerify({ json: true, apply: true, root: SANDBOX });

    const env = envelope();
    expect(env.data.wouldEscapeRoot.length).toBeGreaterThan(0);
    // The escaping entry produced no change row.
    const escaped = env.data.changes.find((ch: { target: string }) =>
      ch.target.includes('passwd')
    );
    expect(escaped).toBeFalsy();
    // Nothing was written outside the sandbox.
    expect(vol.existsSync('/etc/passwd')).toBe(false);
  });

  it('surfaces smartMerge conflicts that plain apply silently discards', async () => {
    // A shell file with a conflicting export between live and repo copies.
    vol.writeFileSync('/test-home/.zshrc', 'export EDITOR=vim\n');
    vol.writeFileSync(`${TUCK}/files/shell/zshrc`, 'export EDITOR=nano\n');

    writeManifestFiles({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        checksum: await checksum(`${TUCK}/files/shell/zshrc`),
      },
    });

    await runVerify({ json: true, apply: true, root: SANDBOX });

    const env = envelope();
    expect(Array.isArray(env.data.conflicts)).toBe(true);
    expect(env.data.conflicts.length).toBeGreaterThan(0);
    expect(env.data.conflicts[0].name).toBe('EDITOR');
  });
});
