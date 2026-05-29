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
  CONFIGURABLE_BACKEND_NAMES: ['auto', 'local', '1password', 'bitwarden', 'pass'],
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

  it('accepts auto as the configured secret backend', async () => {
    const { secretsCommand } = await import('../../src/commands/secrets.js');

    await secretsCommand.parseAsync(['backend', 'set', 'auto'], { from: 'user' });

    expect(saveConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        security: expect.objectContaining({
          secretBackend: 'auto',
        }),
      }),
      '/test-home/.tuck'
    );
  });

  it('emits a redacted JSON envelope for scan --json without leaking secret values', async () => {
    // A known cleartext secret that must NEVER appear in the JSON output.
    const KNOWN_SECRET = 'AKIAIOSFODNN7EXAMPLE-super-secret-value';
    const KNOWN_CONTEXT = `AWS_SECRET=${KNOWN_SECRET}`;

    getAllTrackedFilesMock.mockResolvedValue({
      env: { source: '~/.env', destination: 'files/env', category: 'env' },
    });
    scanForSecretsMock.mockResolvedValue({
      totalFiles: 1,
      scannedFiles: 1,
      skippedFiles: 0,
      filesWithSecrets: 1,
      totalSecrets: 2,
      bySeverity: { critical: 1, high: 1, medium: 0, low: 0 },
      results: [
        {
          path: '/test-home/.env',
          collapsedPath: '~/.env',
          hasSecrets: true,
          criticalCount: 1,
          highCount: 1,
          mediumCount: 0,
          lowCount: 0,
          skipped: false,
          matches: [
            {
              patternId: 'aws-secret',
              patternName: 'AWS Secret Access Key',
              severity: 'critical',
              value: KNOWN_SECRET,
              redactedValue: '[REDACTED]',
              line: 3,
              column: 12,
              context: KNOWN_CONTEXT,
              placeholder: '{{AWS_SECRET}}',
            },
            {
              patternId: 'generic-token',
              patternName: 'Generic Token',
              severity: 'high',
              value: KNOWN_SECRET,
              redactedValue: '[REDACTED]',
              line: 5,
              column: 1,
              context: KNOWN_CONTEXT,
              placeholder: '{{TOKEN}}',
            },
          ],
        },
      ],
    });

    const { secretsCommand } = await import('../../src/commands/secrets.js');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await secretsCommand.parseAsync(['scan', '--json'], { from: 'user' });

    writeSpy.mockRestore();

    const lines = writes.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const env = JSON.parse(lines[0]);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck secrets scan');

    // Counts are present.
    expect(env.data.totalSecrets).toBe(2);
    expect(env.data.filesWithSecrets).toBe(1);
    expect(env.data.bySeverity).toEqual({ critical: 1, high: 1, medium: 0, low: 0 });

    // Per-file summary: path + secretCount, no raw matches.
    expect(env.data.files).toEqual([{ path: '~/.env', secretCount: 2 }]);

    // SECURITY: the full serialized envelope must not contain the cleartext secret
    // or its surrounding raw matched line / context.
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(KNOWN_SECRET);
    expect(serialized).not.toContain(KNOWN_CONTEXT);
    expect(serialized).not.toContain('value');
    expect(serialized).not.toContain('context');
  });

  it('emits an all-zero redacted JSON summary when there are no tracked files to scan', async () => {
    getAllTrackedFilesMock.mockResolvedValue({});
    const { secretsCommand } = await import('../../src/commands/secrets.js');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await secretsCommand.parseAsync(['scan', '--json'], { from: 'user' });

    writeSpy.mockRestore();

    const lines = writes.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const env = JSON.parse(lines[0]);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck secrets scan');
    expect(env.data).toEqual({
      totalFiles: 0,
      scannedFiles: 0,
      skippedFiles: 0,
      filesWithSecrets: 0,
      totalSecrets: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      files: [],
    });

    // In JSON mode the human-readable warning is suppressed and nothing is scanned.
    expect(loggerWarningMock).not.toHaveBeenCalled();
    expect(loggerDimMock).not.toHaveBeenCalled();
    expect(scanForSecretsMock).not.toHaveBeenCalled();
  });

  it('emits an all-zero redacted JSON summary (and no path leak) when no provided files exist', async () => {
    // Path that does not exist on disk -> existingPaths is empty.
    pathExistsMock.mockResolvedValue(false);
    const { secretsCommand } = await import('../../src/commands/secrets.js');

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    await secretsCommand.parseAsync(['scan', '--json', '~/.does-not-exist'], { from: 'user' });

    writeSpy.mockRestore();

    const lines = writes.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const env = JSON.parse(lines[0]);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('tuck secrets scan');
    expect(env.data.totalSecrets).toBe(0);
    expect(env.data.files).toEqual([]);

    // No scan happens, and the missing-file path is not leaked via the warning logger
    // (suppressed in JSON mode) nor anywhere in the JSON envelope.
    expect(scanForSecretsMock).not.toHaveBeenCalled();
    expect(loggerWarningMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(JSON.stringify(env)).not.toContain('does-not-exist');
  });
});
