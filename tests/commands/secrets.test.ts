import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadManifestMock = vi.fn();
const getAllTrackedFilesMock = vi.fn();
const loadConfigMock = vi.fn();
const saveConfigMock = vi.fn();
const listSecretsMock = vi.fn();
const setSecretMock = vi.fn();
const unsetSecretMock = vi.fn();
const getSecretsPathMock = vi.fn();
const isValidSecretNameMock = vi.fn();
const normalizeSecretNameMock = vi.fn();
const scanForSecretsMock = vi.fn();
const createResolverMock = vi.fn();
const setMappingMock = vi.fn();
const listMappingsMock = vi.fn();
const getLogMock = vi.fn();
const pathExistsMock = vi.fn();

const loggerInfoMock = vi.fn();
const loggerDimMock = vi.fn();
const loggerWarningMock = vi.fn();
const loggerErrorMock = vi.fn();
const loggerSuccessMock = vi.fn();

const spinnerStartMock = vi.fn();
const spinnerStopMock = vi.fn();
const spinnerMessageMock = vi.fn();

vi.mock('../../src/ui/index.js', () => {
  const bold = Object.assign((value: string) => value, {
    cyan: (value: string) => value,
    red: (value: string) => value,
  });

  return {
    prompts: {
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      password: vi.fn(),
      text: vi.fn(),
      select: vi.fn(),
      note: vi.fn(),
      cancel: vi.fn(),
      spinner: vi.fn(() => ({
        start: spinnerStartMock,
        stop: spinnerStopMock,
        message: spinnerMessageMock,
      })),
      log: {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
    },
    logger: {
      info: loggerInfoMock,
      dim: loggerDimMock,
      warning: loggerWarningMock,
      error: loggerErrorMock,
      success: loggerSuccessMock,
    },
    colors: {
      bold,
      dim: (value: string) => value,
      green: (value: string) => value,
      cyan: (value: string) => value,
      red: (value: string) => value,
      yellow: (value: string) => value,
      blue: (value: string) => value,
    },
  };
});

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  expandPath: vi.fn((value: string) => value.replace(/^~\//, '/test-home/')),
  pathExists: pathExistsMock,
}));

vi.mock('../../src/lib/manifest.js', () => ({
  loadManifest: loadManifestMock,
  getAllTrackedFiles: getAllTrackedFilesMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: loadConfigMock,
  saveConfig: saveConfigMock,
}));

vi.mock('../../src/lib/secrets/index.js', () => ({
  listSecrets: listSecretsMock,
  setSecret: setSecretMock,
  unsetSecret: unsetSecretMock,
  getSecretsPath: getSecretsPathMock,
  isValidSecretName: isValidSecretNameMock,
  normalizeSecretName: normalizeSecretNameMock,
  scanForSecrets: scanForSecretsMock,
}));

vi.mock('../../src/lib/secretBackends/index.js', () => ({
  createResolver: createResolverMock,
  setMapping: setMappingMock,
  listMappings: listMappingsMock,
  BACKEND_NAMES: ['local', '1password', 'bitwarden', 'pass'],
}));

vi.mock('../../src/lib/git.js', () => ({
  getLog: getLogMock,
}));

describe('secrets command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    loadManifestMock.mockResolvedValue({ files: {} });
    getAllTrackedFilesMock.mockResolvedValue({});
    loadConfigMock.mockResolvedValue({ security: {} });
    saveConfigMock.mockResolvedValue(undefined);
    listSecretsMock.mockResolvedValue([]);
    setSecretMock.mockResolvedValue(undefined);
    unsetSecretMock.mockResolvedValue(false);
    getSecretsPathMock.mockReturnValue('/test-home/.tuck/secrets.local.json');
    isValidSecretNameMock.mockReturnValue(true);
    normalizeSecretNameMock.mockImplementation((value: string) => value);
    scanForSecretsMock.mockResolvedValue({
      totalSecrets: 0,
      filesWithSecrets: 0,
      bySeverity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      },
      results: [],
    });
    createResolverMock.mockReturnValue({
      getBackend: vi.fn(),
      getBackendStatuses: vi.fn().mockResolvedValue([]),
    });
    setMappingMock.mockResolvedValue(undefined);
    listMappingsMock.mockResolvedValue({});
    getLogMock.mockResolvedValue([]);
    pathExistsMock.mockResolvedValue(true);
  });

  it('scans tracked files when no explicit paths are provided', async () => {
    getAllTrackedFilesMock.mockResolvedValue({
      zshrc: {
        source: '~/.zshrc',
        destination: 'files/shell/zshrc',
        category: 'shell',
      },
      gitconfig: {
        source: '~/.gitconfig',
        destination: 'files/git/gitconfig',
        category: 'git',
      },
    });
    const { secretsCommand } = await import('../../src/commands/secrets.js');

    await secretsCommand.parseAsync(['scan'], { from: 'user' });

    expect(getAllTrackedFilesMock).toHaveBeenCalledWith('/test-home/.tuck');
    expect(scanForSecretsMock).toHaveBeenCalledWith(
      ['/test-home/.zshrc', '/test-home/.gitconfig'],
      '/test-home/.tuck'
    );
    expect(loggerSuccessMock).toHaveBeenCalledWith('No secrets detected');
  });

  it('warns when there are no tracked files to scan', async () => {
    getAllTrackedFilesMock.mockResolvedValue({});
    const { secretsCommand } = await import('../../src/commands/secrets.js');

    await secretsCommand.parseAsync(['scan'], { from: 'user' });

    expect(loggerWarningMock).toHaveBeenCalledWith('No tracked files to scan');
    expect(loggerDimMock).toHaveBeenCalledWith("Run 'tuck add <path>' to start tracking files first");
    expect(scanForSecretsMock).not.toHaveBeenCalled();
  });

  it('scans explicitly provided paths without consulting tracked files', async () => {
    const { secretsCommand } = await import('../../src/commands/secrets.js');

    await secretsCommand.parseAsync(['scan', '~/.env'], { from: 'user' });

    expect(getAllTrackedFilesMock).not.toHaveBeenCalled();
    expect(scanForSecretsMock).toHaveBeenCalledWith(['/test-home/.env'], '/test-home/.tuck');
    expect(loggerSuccessMock).toHaveBeenCalledWith('No secrets detected');
  });

  it('forwards since and limit options to history scanning', async () => {
    const { secretsCommand } = await import('../../src/commands/secrets.js');

    await secretsCommand.parseAsync(
      ['scan-history', '--since', '2024-01-01', '--limit', '25'],
      { from: 'user' }
    );

    expect(getLogMock).toHaveBeenCalledWith('/test-home/.tuck', {
      maxCount: 25,
      since: '2024-01-01',
    });
  });
});
