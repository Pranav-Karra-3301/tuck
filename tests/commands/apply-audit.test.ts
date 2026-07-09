/**
 * Audit-regression tests for `tuck apply`.
 *
 * Covers three confirmed defects:
 *  - Binary tracked files must be copied byte-for-byte, not UTF-8 round-tripped
 *    (which replaces invalid sequences with U+FFFD and corrupts the file).
 *  - The pre-apply snapshot must include destinations that do NOT yet exist, so
 *    `tuck undo` can delete files the apply newly created.
 *  - Under a sandbox (`--root`) write context, local-store secret restoration
 *    must target the file apply ACTUALLY wrote (the sandbox copy), never the
 *    operator's real ~ path.
 *
 * Uses the same memfs + local-directory-source pattern as apply-permissions.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join, resolve } from 'path';
import { createMockManifest, createMockTrackedFile } from '../utils/factories.js';
import { TEST_HOME, TEST_TUCK_DIR } from '../setup.js';

const findPlaceholdersMock = vi.fn();
const restoreContentMock = vi.fn();
const restoreSecretsMock = vi.fn();
const getSecretCountMock = vi.fn();
const getAllSecretsMock = vi.fn();
const createPreApplySnapshotMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  banner: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    note: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('replace'),
    multiselect: vi.fn().mockResolvedValue([]),
    cancel: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
    dim: vi.fn(),
    debug: vi.fn(),
  },
  colors: {
    yellow: (x: string) => x,
    dim: (x: string) => x,
    bold: (x: string) => x,
    green: (x: string) => x,
    cyan: (x: string) => x,
  },
}));

vi.mock('../../src/lib/git.js', () => ({ cloneRepo: vi.fn() }));
vi.mock('../../src/lib/github.js', () => ({
  isGhInstalled: vi.fn().mockResolvedValue(false),
  findDotfilesRepo: vi.fn().mockResolvedValue(null),
  ghCloneRepo: vi.fn(),
  repoExists: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/lib/timemachine.js', () => ({
  createPreApplySnapshot: createPreApplySnapshotMock,
}));
vi.mock('../../src/lib/merge.js', () => ({
  smartMerge: vi.fn(async (_destination: string, content: string) => ({
    content,
    preservedBlocks: 0,
  })),
  isShellFile: vi.fn().mockReturnValue(false),
  generateMergePreview: vi.fn().mockResolvedValue(''),
}));
vi.mock('../../src/lib/secrets/index.js', () => ({
  findPlaceholders: findPlaceholdersMock,
  restoreContent: restoreContentMock,
  restoreFiles: restoreSecretsMock,
  getAllSecrets: getAllSecretsMock,
  getSecretCount: getSecretCountMock,
}));
vi.mock('../../src/lib/secretBackends/index.js', () => ({ createResolver: vi.fn() }));
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ security: { secretBackend: 'local' } }),
}));
vi.mock('../../src/lib/platform.js', () => ({ IS_WINDOWS: false }));

import { resetWriteContext, setWriteContext } from '../../src/lib/writeContext.js';

describe('tuck apply — audit regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
    resetWriteContext();

    findPlaceholdersMock.mockReturnValue([]);
    restoreContentMock.mockImplementation((content: string) => ({
      restoredContent: content,
      unresolved: [],
    }));
    restoreSecretsMock.mockResolvedValue({ totalRestored: 0, allUnresolved: [] });
    getSecretCountMock.mockResolvedValue(0);
    getAllSecretsMock.mockResolvedValue({});
    createPreApplySnapshotMock.mockResolvedValue({ id: 'snapshot-test' });
  });
  afterEach(() => {
    vol.reset();
    resetWriteContext();
  });

  it('should copy a binary file byte-for-byte when the file is not valid UTF-8', async () => {
    // Bytes that are NOT valid UTF-8 (a lone 0xFF etc.) — a toString('utf8')
    // round-trip would replace them with U+FFFD and corrupt the file.
    const binaryBytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0x02]);
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        font: createMockTrackedFile({
          source: '~/.local/share/fonts/Custom.bin',
          destination: 'files/misc/Custom.bin',
          category: 'misc',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'misc'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    vol.writeFileSync(join(localSrc, 'files', 'misc', 'Custom.bin'), binaryBytes);

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    const target = join(TEST_HOME, '.local', 'share', 'fonts', 'Custom.bin');
    expect(vol.existsSync(target)).toBe(true);
    const written = vol.readFileSync(target) as Buffer;
    expect(Buffer.compare(written, binaryBytes)).toBe(0);
  });

  it('should snapshot destinations that do not yet exist so undo can remove them', async () => {
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        tmux: createMockTrackedFile({
          source: '~/.tmux.conf',
          destination: 'files/misc/tmux.conf',
          category: 'misc',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'misc'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    vol.writeFileSync(join(localSrc, 'files', 'misc', 'tmux.conf'), 'set -g mouse on\n');

    // ~/.tmux.conf does NOT exist on this machine.
    expect(vol.existsSync(join(TEST_HOME, '.tmux.conf'))).toBe(false);

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    expect(createPreApplySnapshotMock).toHaveBeenCalledTimes(1);
    const [snapshotPaths] = createPreApplySnapshotMock.mock.calls[0] as [string[], string];
    // The not-yet-existing destination is included, so restoreSnapshot (undo) can
    // delete it (createSnapshot records it as existed:false).
    // resolve() so the expectation matches resolveWriteTarget's output on
    // Windows too, where resolving '/test-home' adds the current drive letter.
    expect(snapshotPaths).toContain(resolve(TEST_HOME, '.tmux.conf'));

    // The printed undo instruction must reference the real `tuck undo` command,
    // pinned to the snapshot just created, not the non-existent
    // `tuck restore --latest` flag.
    const ui = await import('../../src/ui/index.js');
    expect(vi.mocked(ui.logger.info)).toHaveBeenCalledWith(
      'Undo this change: tuck undo snapshot-test  (or tuck undo --latest)'
    );
  });

  it('should restore local-store secrets into the sandbox write target under --root, not the real home', async () => {
    const SANDBOX = join(TEST_HOME, 'sandbox');
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        env: createMockTrackedFile({
          source: '~/.config/app/config',
          destination: 'files/misc/config',
          category: 'misc',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'misc'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    vol.writeFileSync(join(localSrc, 'files', 'misc', 'config'), 'token={{TOKEN}}\n');

    // The repo content carries a placeholder the configured backend can't resolve,
    // but the local secret store CAN.
    findPlaceholdersMock.mockReturnValue(['TOKEN']);
    getSecretCountMock.mockResolvedValue(1);
    getAllSecretsMock.mockResolvedValue({ TOKEN: 'shhh' });

    setWriteContext({ root: SANDBOX, isSandbox: true });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    // The local-store secret restore must target the SANDBOX copy, never the real
    // ~/.config/app/config path — that would escape the sandbox and rewrite the
    // operator's real file with plaintext secrets.
    expect(restoreSecretsMock).toHaveBeenCalledTimes(1);
    const [pathsToRestore] = restoreSecretsMock.mock.calls[0] as [string[], string];
    // apply builds the write target via resolveWriteTarget (resolve()), which adds
    // the drive letter on Windows; resolve() the expectations too so the assertion
    // is path-form agnostic while still proving the target is the SANDBOX copy and
    // never the real ~/.config/app/config.
    expect(pathsToRestore).toEqual([resolve(join(SANDBOX, '.config', 'app', 'config'))]);
    expect(pathsToRestore).not.toContain(resolve(join(TEST_HOME, '.config', 'app', 'config')));
  });

  it('snapshots the SANDBOX write targets under --root, not the untouched real home', async () => {
    const SANDBOX = join(TEST_HOME, 'sandbox');
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        zshrc: createMockTrackedFile({
          source: '~/.zshrc',
          destination: 'files/shell/zshrc',
          category: 'shell',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'shell'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    vol.writeFileSync(join(localSrc, 'files', 'shell', 'zshrc'), 'export SANDBOX=1\n');

    setWriteContext({ root: SANDBOX, isSandbox: true });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    // The pre-apply snapshot must cover the SANDBOX write target so `tuck undo`
    // restores the sandbox copy — never the real ~/.zshrc the apply never wrote.
    expect(createPreApplySnapshotMock).toHaveBeenCalledTimes(1);
    const [snapshotPaths] = createPreApplySnapshotMock.mock.calls[0] as [string[], string];
    expect(snapshotPaths).toEqual([resolve(join(SANDBOX, '.zshrc'))]);
    expect(snapshotPaths).not.toContain(resolve(join(TEST_HOME, '.zshrc')));
  });

  it('reads the jsonKey merge base from the sandbox, never the real home, under --root', async () => {
    const SANDBOX = join(TEST_HOME, 'sandbox');
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        claude: createMockTrackedFile({
          source: '~/.claude.json',
          destination: 'files/misc/claude.json',
          category: 'misc',
          jsonKey: 'mcpServers',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'misc'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    // Repo stores ONLY the tracked subtree.
    vol.writeFileSync(
      join(localSrc, 'files', 'misc', 'claude.json'),
      JSON.stringify({ server1: { cmd: 'x' } })
    );

    // The REAL home file carries a secret untracked key that must never be read.
    vol.writeFileSync(
      join(TEST_HOME, '.claude.json'),
      JSON.stringify({ realSecret: 'tokenXYZ', mcpServers: { fromRealHome: true } })
    );
    // The SANDBOX already has its own live file with an untracked key to preserve.
    vol.mkdirSync(SANDBOX, { recursive: true });
    vol.writeFileSync(
      join(SANDBOX, '.claude.json'),
      JSON.stringify({ sandboxKeep: 'ok', mcpServers: { old: true } })
    );

    setWriteContext({ root: SANDBOX, isSandbox: true });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    const written = JSON.parse(vol.readFileSync(join(SANDBOX, '.claude.json'), 'utf-8'));
    // The tracked subtree replaced the sandbox's mcpServers...
    expect(written.mcpServers).toEqual({ server1: { cmd: 'x' } });
    // ...the sandbox's untracked key is preserved...
    expect(written.sandboxKeep).toBe('ok');
    // ...and the real home's untracked secret was NEVER copied into the sandbox.
    expect(written.realSecret).toBeUndefined();
    // The real home file is untouched.
    expect(JSON.parse(vol.readFileSync(join(TEST_HOME, '.claude.json'), 'utf-8')).realSecret).toBe(
      'tokenXYZ'
    );
  });

  it('never substitutes a secret into an untracked jsonKey remainder', async () => {
    const SANDBOX = join(TEST_HOME, 'sandbox');
    const localSrc = join(TEST_HOME, 'dotfiles-src');
    const manifest = createMockManifest({
      files: {
        claude: createMockTrackedFile({
          source: '~/.claude.json',
          destination: 'files/misc/claude.json',
          category: 'misc',
          jsonKey: 'mcpServers',
        }),
      },
    });
    vol.mkdirSync(join(localSrc, 'files', 'misc'), { recursive: true });
    vol.writeFileSync(join(localSrc, '.tuckmanifest.json'), JSON.stringify(manifest, null, 2));
    // Tracked subtree contains NO placeholder.
    vol.writeFileSync(
      join(localSrc, 'files', 'misc', 'claude.json'),
      JSON.stringify({ server1: { cmd: 'x' } })
    );

    // The sandbox live file has an UNTRACKED key containing a placeholder that a
    // configured secret would otherwise resolve.
    vol.mkdirSync(SANDBOX, { recursive: true });
    vol.writeFileSync(
      join(SANDBOX, '.claude.json'),
      JSON.stringify({ greeting: 'Hello {{NAME}}', mcpServers: { old: true } })
    );

    // A stored secret IS available — proving the untracked key is still not touched.
    getSecretCountMock.mockResolvedValue(1);
    getAllSecretsMock.mockResolvedValue({ NAME: 'SECRET_VALUE' });

    setWriteContext({ root: SANDBOX, isSandbox: true });

    const { runApply } = await import('../../src/commands/apply.js');
    await runApply(localSrc, { replace: true });

    const written = JSON.parse(vol.readFileSync(join(SANDBOX, '.claude.json'), 'utf-8'));
    // The untracked key's placeholder text is preserved verbatim — never resolved.
    expect(written.greeting).toBe('Hello {{NAME}}');
    expect(written.mcpServers).toEqual({ server1: { cmd: 'x' } });

    // Secret resolution only ever saw the tracked SUBTREE, never the merged whole
    // file — so it was never given the untracked "greeting" content.
    for (const call of findPlaceholdersMock.mock.calls) {
      expect(String(call[0])).not.toContain('greeting');
    }
  });
});
