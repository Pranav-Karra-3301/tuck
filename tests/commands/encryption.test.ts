import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEncryptionStatusMock = vi.fn();
const setupEncryptionMock = vi.fn();
const disableEncryptionMock = vi.fn();
const changePasswordMock = vi.fn();
const getKeystoreNameMock = vi.fn();
const verifyStoredPasswordMock = vi.fn();

const promptsIntroMock = vi.fn();
const promptsOutroMock = vi.fn();
const promptsConfirmMock = vi.fn();
const promptsPasswordMock = vi.fn();
const promptsCancelMock = vi.fn();
const promptsLogInfoMock = vi.fn();
const promptsLogSuccessMock = vi.fn();
const promptsLogWarningMock = vi.fn();
const promptsLogErrorMock = vi.fn();

const loggerInfoMock = vi.fn();
const pathExistsMock = vi.fn();

const spinnerStartMock = vi.fn();
const spinnerStopMock = vi.fn();

vi.mock('../../src/ui/index.js', () => ({
  prompts: {
    intro: promptsIntroMock,
    outro: promptsOutroMock,
    confirm: promptsConfirmMock,
    password: promptsPasswordMock,
    cancel: promptsCancelMock,
    spinner: vi.fn(() => ({
      start: spinnerStartMock,
      stop: spinnerStopMock,
    })),
    log: {
      info: promptsLogInfoMock,
      success: promptsLogSuccessMock,
      warning: promptsLogWarningMock,
      error: promptsLogErrorMock,
    },
  },
  logger: {
    info: loggerInfoMock,
  },
}));

vi.mock('../../src/lib/crypto/index.js', () => ({
  getEncryptionStatus: getEncryptionStatusMock,
  setupEncryption: setupEncryptionMock,
  disableEncryption: disableEncryptionMock,
  changePassword: changePasswordMock,
  getKeystoreName: getKeystoreNameMock,
  verifyStoredPassword: verifyStoredPasswordMock,
}));

vi.mock('../../src/lib/paths.js', () => ({
  getTuckDir: vi.fn(() => '/test-home/.tuck'),
  getManifestPath: vi.fn(() => '/test-home/.tuck/manifest.json'),
}));

vi.mock('fs-extra', () => ({
  pathExists: pathExistsMock,
}));

describe('encryption command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    getEncryptionStatusMock.mockResolvedValue({
      enabled: true,
      keystoreType: 'Test Keychain',
      hasStoredPassword: true,
    });
    setupEncryptionMock.mockResolvedValue(undefined);
    disableEncryptionMock.mockResolvedValue(undefined);
    changePasswordMock.mockResolvedValue(undefined);
    getKeystoreNameMock.mockResolvedValue('Test Keychain');
    verifyStoredPasswordMock.mockResolvedValue(true);
    promptsConfirmMock.mockResolvedValue(true);
    promptsPasswordMock.mockResolvedValue('secret');
    pathExistsMock.mockResolvedValue(true);
  });

  it('shows encryption status by default', async () => {
    const { encryptionCommand } = await import('../../src/commands/encryption.js');

    await encryptionCommand.parseAsync([], { from: 'user' });

    expect(getEncryptionStatusMock).toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith('Encryption Status');
  });

  it('throws NOT_INITIALIZED when the manifest is missing', async () => {
    pathExistsMock.mockResolvedValueOnce(false);
    const { encryptionCommand } = await import('../../src/commands/encryption.js');

    await expect(encryptionCommand.parseAsync(['status'], { from: 'user' })).rejects.toMatchObject({
      code: 'NOT_INITIALIZED',
    });
  });

  it('sets up encryption with a prompted password', async () => {
    getEncryptionStatusMock.mockResolvedValueOnce({
      enabled: false,
      keystoreType: 'Test Keychain',
      hasStoredPassword: false,
    });
    promptsPasswordMock.mockResolvedValueOnce('super-secret').mockResolvedValueOnce('super-secret');
    const { encryptionCommand } = await import('../../src/commands/encryption.js');

    await encryptionCommand.parseAsync(['setup'], { from: 'user' });

    expect(setupEncryptionMock).toHaveBeenCalledWith('super-secret');
    expect(getKeystoreNameMock).toHaveBeenCalled();
    expect(promptsOutroMock).toHaveBeenCalledWith('Backup encryption is now enabled');
  });

  it('rejects password rotation when the current password is wrong', async () => {
    promptsPasswordMock.mockResolvedValueOnce('wrong-password');
    verifyStoredPasswordMock.mockResolvedValueOnce(false);
    const { encryptionCommand } = await import('../../src/commands/encryption.js');

    await encryptionCommand.parseAsync(['rotate'], { from: 'user' });

    expect(verifyStoredPasswordMock).toHaveBeenCalledWith('wrong-password');
    expect(changePasswordMock).not.toHaveBeenCalled();
    expect(promptsLogErrorMock).toHaveBeenCalledWith('Current password is incorrect');
  });

  it('cancels disabling encryption when the user declines confirmation', async () => {
    promptsConfirmMock.mockResolvedValueOnce(false);
    const { encryptionCommand } = await import('../../src/commands/encryption.js');

    await encryptionCommand.parseAsync(['disable'], { from: 'user' });

    expect(disableEncryptionMock).not.toHaveBeenCalled();
    expect(promptsCancelMock).toHaveBeenCalledWith('Cancelled');
  });
});
