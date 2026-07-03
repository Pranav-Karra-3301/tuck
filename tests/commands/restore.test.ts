import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { vol } from 'memfs';
import { NotInitializedError } from '../../src/errors.js';
import { encryptFileContent } from '../../src/lib/crypto/fileEncryption.js';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const getTrackedFileBySourceMock = vi.fn();
const loadConfigMock = vi.fn();
const copyFileOrDirMock = vi.fn();
const createSymlinkMock = vi.fn();
const createBackupMock = vi.fn();
const runPreRestoreHookMock = vi.fn();
const runPostRestoreHookMock = vi.fn();
const restoreSecretsMock = vi.fn();
const getSecretCountMock = vi.fn();
const pathExistsMock = vi.fn();
const validateSafeSourcePathMock = vi.fn();
const validateSafeManifestDestinationMock = vi.fn();
const validatePathWithinRootMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    multiselect: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  },
  logger: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    heading: vi.fn(),
    blank: vi.fn(),
    file: vi.fn(),
  },
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/ui/theme.js', () => ({
  colors: {
    yellow: (x: string) => x,
    dim: (x: string) => x,
  },
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  expandPath: vi.fn((p: string) => p.replace(/^~\//, '/test-home/')),
  pathExists: pathExistsMock,
  collapsePath: vi.fn((p: string) => p),
  validateSafeSourcePath: validateSafeSourcePathMock,
  validateSafeManifestDestination: validateSafeManifestDestinationMock,
  validatePathWithinRoot: validatePathWithinRootMock,
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
  getTrackedFileBySource: getTrackedFileBySourceMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/lib/files.js', () => ({
  copyFileOrDir: copyFileOrDirMock,
  createSymlink: createSymlinkMock,
}));

vi.mock('../../src/lib/backup.js', () => ({
  createBackup: createBackupMock,
}));

vi.mock('../../src/lib/hooks.js', () => ({
  runPreRestoreHook: runPreRestoreHookMock,
  runPostRestoreHook: runPostRestoreHookMock,
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  restoreFiles: restoreSecretsMock,
  getSecretCount: getSecretCountMock,
}));

vi.mock('../../src/lib/crypto/keystore/index.js', () => ({
  getKeystore: vi.fn(async () => ({ retrieve: vi.fn(async () => 'pw') })),
  TUCK_SERVICE: 'tuck-dotfiles',
  TUCK_ACCOUNT: 'backup-encryption',
}));

describe('restore command behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    getAllTrackedFilesMock.mockResolvedValue({});
    getTrackedFileBySourceMock.mockResolvedValue(null);
    loadConfigMock.mockResolvedValue({
      files: {
        strategy: 'copy',
        backupOnRestore: true,
      },
    });
    copyFileOrDirMock.mockResolvedValue(undefined);
    createSymlinkMock.mockResolvedValue(undefined);
    createBackupMock.mockResolvedValue(undefined);
    runPreRestoreHookMock.mockResolvedValue(undefined);
    runPostRestoreHookMock.mockResolvedValue(undefined);
    getSecretCountMock.mockResolvedValue(0);
    restoreSecretsMock.mockResolvedValue({ totalRestored: 0, allUnresolved: [] });
    pathExistsMock.mockResolvedValue(true);
    validateSafeSourcePathMock.mockImplementation(() => {});
    validateSafeManifestDestinationMock.mockImplementation(() => {});
    validatePathWithinRootMock.mockImplementation(() => {});
  });

  it('throws NotInitializedError when manifest is missing', async () => {
    loadManifestMock.mockRejectedValueOnce(new Error('missing manifest'));
    const { runRestore } = await import('../../src/commands/restore.js');

    await expect(runRestore({ all: true })).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('restores tracked files in all mode', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
      },
    });

    const { runRestore } = await import('../../src/commands/restore.js');

    await runRestore({ all: true, noHooks: true, noSecrets: true });

    expect(copyFileOrDirMock.mock.calls.length + createSymlinkMock.mock.calls.length).toBe(1);
    expect(validatePathWithinRootMock).toHaveBeenCalledWith(
      join('/test-home/.tuck', 'files', 'shell', 'zshrc'),
      '/test-home/.tuck',
      'restore source'
    );
  });

  it('renders a template file on restore (P0-1)', async () => {
    vol.reset();
    vol.mkdirSync('/test-home/.tuck/files/shell', { recursive: true });
    vol.writeFileSync('/test-home/.tuck/files/shell/zshrc', 'os={{os}}');
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
        template: true,
        encrypted: false,
      },
    });

    const { runRestore } = await import('../../src/commands/restore.js');
    await runRestore({ all: true, noHooks: true, noSecrets: true });

    // {{os}} is rendered with the machine platform; written directly, not raw-copied.
    expect(vol.readFileSync('/test-home/.zshrc', 'utf-8')).toBe(`os=${process.platform}`);
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
  });

  it('decrypts an encrypted file on restore (P0-2)', async () => {
    vol.reset();
    const ciphertext = await encryptFileContent(Buffer.from('SECRET=1'), 'pw');
    vol.mkdirSync('/test-home/.tuck/files/shell', { recursive: true });
    vol.writeFileSync('/test-home/.tuck/files/shell/netrc', ciphertext);
    getAllTrackedFilesMock.mockResolvedValue({
      netrc: {
        source: '~/.netrc',
        destination: 'files/shell/netrc',
        category: 'shell',
        template: false,
        encrypted: true,
      },
    });

    const { runRestore } = await import('../../src/commands/restore.js');
    await runRestore({ all: true, noHooks: true, noSecrets: true });

    // TCKE1 ciphertext is decrypted to plaintext on disk, never written as ciphertext.
    expect(vol.readFileSync('/test-home/.netrc', 'utf-8')).toBe('SECRET=1');
  });

  it('force-copies+materializes template/encrypted files under symlink strategy (never symlinks raw source)', async () => {
    vol.reset();
    vol.mkdirSync('/test-home/.tuck/files/shell', { recursive: true });
    vol.writeFileSync('/test-home/.tuck/files/shell/zshrc', 'os={{os}}');
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
        template: true,
        encrypted: false,
      },
    });

    const { runRestore } = await import('../../src/commands/restore.js');
    // useSymlink via --symlink — a template file must STILL be rendered into place,
    // NOT symlinked (a symlink would expose the raw {{ }} source / ciphertext).
    await runRestore({ all: true, symlink: true, noHooks: true, noSecrets: true });

    expect(vol.readFileSync('/test-home/.zshrc', 'utf-8')).toBe(`os=${process.platform}`);
    expect(createSymlinkMock).not.toHaveBeenCalled();
  });

  it('surfaces skipped-file warnings in the JSON envelope.warnings', async () => {
    // A tracked file whose repository copy is missing on disk triggers the
    // "Source not found in repository" skip path. In JSON mode that human
    // warning must also surface in envelope.warnings.
    getTrackedFileBySourceMock.mockResolvedValue({
      id: 'zshrc',
      file: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
      },
    });
    // Repository source does not exist -> the file is skipped with a warning.
    pathExistsMock.mockResolvedValue(false);

    const { runRestoreCommand } = await import('../../src/commands/restore.js');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await runRestoreCommand(['~/.zshrc'], { json: true, yes: true, noHooks: true });

    writeSpy.mockRestore();

    const lines = writes.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const env = JSON.parse(lines[0]);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck restore');
    expect(Array.isArray(env.warnings)).toBe(true);
    expect(env.warnings.length).toBeGreaterThan(0);
    expect(env.warnings.some((w: string) => /source not found in repository/i.test(w))).toBe(true);
    // Nothing was restored.
    expect(env.data.restored).toBe(0);
  });

  it('fails fast when manifest destination is unsafe', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: '../../outside',
        category: 'shell',
      },
    });
    validateSafeManifestDestinationMock.mockImplementationOnce(() => {
      throw new Error('Unsafe manifest destination detected');
    });

    const { runRestore } = await import('../../src/commands/restore.js');

    await expect(runRestore({ all: true, noHooks: true })).rejects.toThrow(
      'Unsafe manifest destination detected'
    );
    expect(copyFileOrDirMock).not.toHaveBeenCalled();
  });

  it('should not write any files when --dry-run is set in the interactive path', async () => {
    // Interactive restore (no paths, no --all, no --yes/--json) previously dropped
    // --dry-run and performed a REAL restore. It must now honor dryRun and write
    // nothing.
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', category: 'shell' },
    });

    const ui = await import('../../src/ui/index.js');
    vi.mocked(ui.prompts.multiselect).mockResolvedValue(['zshrc'] as never);
    vi.mocked(ui.prompts.select).mockResolvedValue(false as never); // copy strategy
    vi.mocked(ui.prompts.confirm).mockResolvedValue(true as never);

    const { runRestoreCommand } = await import('../../src/commands/restore.js');
    await runRestoreCommand([], { dryRun: true } as never);

    expect(copyFileOrDirMock).not.toHaveBeenCalled();
    expect(createSymlinkMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it('should carry --no-hooks through the interactive path', async () => {
    // The interactive restore rebuilt a fresh options object that dropped noHooks;
    // it must now pass the original options (skipHooks) through to the hook runner.
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: { source: '~/.zshrc', destination: 'files/shell/zshrc', category: 'shell' },
    });

    const ui = await import('../../src/ui/index.js');
    vi.mocked(ui.prompts.multiselect).mockResolvedValue(['zshrc'] as never);
    vi.mocked(ui.prompts.select).mockResolvedValue(false as never);
    vi.mocked(ui.prompts.confirm).mockResolvedValue(true as never);

    const { runRestoreCommand } = await import('../../src/commands/restore.js');
    await runRestoreCommand([], { noHooks: true, noSecrets: true } as never);

    expect(runPreRestoreHookMock).toHaveBeenCalledWith(
      '/test-home/.tuck',
      expect.objectContaining({ skipHooks: true })
    );
  });
});
