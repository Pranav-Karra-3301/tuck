import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the os module before importing platform
const mockPlatform = vi.fn();
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    platform: mockPlatform,
    homedir: () => '/home/testuser',
  };
});

describe('platform', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('toPosixPath', () => {
    it('should convert backslashes to forward slashes', async () => {
      mockPlatform.mockReturnValue('win32');
      const { toPosixPath } = await import('../../src/lib/platform.js');
      expect(toPosixPath('C:\\Users\\test\\.zshrc')).toBe('C:/Users/test/.zshrc');
    });

    it('should leave forward slashes unchanged', async () => {
      mockPlatform.mockReturnValue('darwin');
      const { toPosixPath } = await import('../../src/lib/platform.js');
      expect(toPosixPath('/home/user/.zshrc')).toBe('/home/user/.zshrc');
    });

    it('should handle mixed separators', async () => {
      mockPlatform.mockReturnValue('win32');
      const { toPosixPath } = await import('../../src/lib/platform.js');
      expect(toPosixPath('C:/Users\\test/.config\\nvim')).toBe('C:/Users/test/.config/nvim');
    });
  });

  describe('fromPosixPath', () => {
    it('should convert forward slashes to backslashes on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      const { fromPosixPath } = await import('../../src/lib/platform.js');
      expect(fromPosixPath('C:/Users/test/.zshrc')).toBe('C:\\Users\\test\\.zshrc');
    });

    it('should leave paths unchanged on Unix', async () => {
      mockPlatform.mockReturnValue('darwin');
      const { fromPosixPath } = await import('../../src/lib/platform.js');
      expect(fromPosixPath('/home/user/.zshrc')).toBe('/home/user/.zshrc');
    });
  });

  describe('normalizePath', () => {
    it('should convert to backslashes on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      const { normalizePath } = await import('../../src/lib/platform.js');
      expect(normalizePath('/home/user/file')).toBe('\\home\\user\\file');
    });

    it('should convert to forward slashes on Unix', async () => {
      mockPlatform.mockReturnValue('darwin');
      const { normalizePath } = await import('../../src/lib/platform.js');
      expect(normalizePath('C:\\Users\\file')).toBe('C:/Users/file');
    });
  });

  describe('isWindowsAbsolutePath', () => {
    it('should detect drive letter paths', async () => {
      mockPlatform.mockReturnValue('win32');
      const { isWindowsAbsolutePath } = await import('../../src/lib/platform.js');
      expect(isWindowsAbsolutePath('C:\\Users\\test')).toBe(true);
      expect(isWindowsAbsolutePath('D:/Documents')).toBe(true);
      expect(isWindowsAbsolutePath('c:\\lowercase')).toBe(true);
    });

    it('should reject non-drive paths', async () => {
      mockPlatform.mockReturnValue('win32');
      const { isWindowsAbsolutePath } = await import('../../src/lib/platform.js');
      expect(isWindowsAbsolutePath('/unix/path')).toBe(false);
      expect(isWindowsAbsolutePath('relative/path')).toBe(false);
      expect(isWindowsAbsolutePath('~/.zshrc')).toBe(false);
    });
  });

  describe('isAbsoluteForPlatform', () => {
    it('should check for drive letters on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      const { isAbsoluteForPlatform } = await import('../../src/lib/platform.js');
      expect(isAbsoluteForPlatform('C:\\Users\\test')).toBe(true);
      expect(isAbsoluteForPlatform('/unix/style')).toBe(false);
    });

    it('should check for leading slash on Unix', async () => {
      mockPlatform.mockReturnValue('darwin');
      const { isAbsoluteForPlatform } = await import('../../src/lib/platform.js');
      expect(isAbsoluteForPlatform('/home/user')).toBe(true);
      expect(isAbsoluteForPlatform('relative/path')).toBe(false);
    });
  });

  describe('expandWindowsEnvVars', () => {
    it('should expand %USERPROFILE%', async () => {
      mockPlatform.mockReturnValue('win32');
      // Set up mock environment
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        USERPROFILE: 'C:\\Users\\TestUser',
        APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
      };

      const { expandWindowsEnvVars } = await import('../../src/lib/platform.js');
      expect(expandWindowsEnvVars('%USERPROFILE%\\.gitconfig')).toBe(
        'C:\\Users\\TestUser\\.gitconfig'
      );

      process.env = originalEnv;
    });

    it('should expand %APPDATA%', async () => {
      mockPlatform.mockReturnValue('win32');
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        USERPROFILE: 'C:\\Users\\TestUser',
        APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
      };

      const { expandWindowsEnvVars } = await import('../../src/lib/platform.js');
      expect(expandWindowsEnvVars('%APPDATA%\\Code\\User\\settings.json')).toBe(
        'C:\\Users\\TestUser\\AppData\\Roaming\\Code\\User\\settings.json'
      );

      process.env = originalEnv;
    });

    it('should expand %LOCALAPPDATA%', async () => {
      mockPlatform.mockReturnValue('win32');
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        USERPROFILE: 'C:\\Users\\TestUser',
        APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
      };

      const { expandWindowsEnvVars } = await import('../../src/lib/platform.js');
      expect(expandWindowsEnvVars('%LOCALAPPDATA%\\nvim')).toBe(
        'C:\\Users\\TestUser\\AppData\\Local\\nvim'
      );

      process.env = originalEnv;
    });

    it('should return path unchanged on non-Windows', async () => {
      mockPlatform.mockReturnValue('darwin');
      const { expandWindowsEnvVars } = await import('../../src/lib/platform.js');
      expect(expandWindowsEnvVars('%USERPROFILE%\\.gitconfig')).toBe(
        '%USERPROFILE%\\.gitconfig'
      );
    });

    it('should be case-insensitive for env var names', async () => {
      mockPlatform.mockReturnValue('win32');
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        USERPROFILE: 'C:\\Users\\TestUser',
        APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
      };

      const { expandWindowsEnvVars } = await import('../../src/lib/platform.js');
      expect(expandWindowsEnvVars('%userprofile%\\.gitconfig')).toBe(
        'C:\\Users\\TestUser\\.gitconfig'
      );

      process.env = originalEnv;
    });
  });

  describe('platform constants', () => {
    it('should set IS_WINDOWS true on win32', async () => {
      mockPlatform.mockReturnValue('win32');
      const { IS_WINDOWS, IS_MACOS, IS_LINUX } = await import('../../src/lib/platform.js');
      expect(IS_WINDOWS).toBe(true);
      expect(IS_MACOS).toBe(false);
      expect(IS_LINUX).toBe(false);
    });

    it('should set IS_MACOS true on darwin', async () => {
      mockPlatform.mockReturnValue('darwin');
      const { IS_WINDOWS, IS_MACOS, IS_LINUX } = await import('../../src/lib/platform.js');
      expect(IS_WINDOWS).toBe(false);
      expect(IS_MACOS).toBe(true);
      expect(IS_LINUX).toBe(false);
    });

    it('should set IS_LINUX true on linux', async () => {
      mockPlatform.mockReturnValue('linux');
      const { IS_WINDOWS, IS_MACOS, IS_LINUX } = await import('../../src/lib/platform.js');
      expect(IS_WINDOWS).toBe(false);
      expect(IS_MACOS).toBe(false);
      expect(IS_LINUX).toBe(true);
    });

    it('should set correct ENV_PATH_SEP on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      const { ENV_PATH_SEP } = await import('../../src/lib/platform.js');
      expect(ENV_PATH_SEP).toBe(';');
    });

    it('should set correct ENV_PATH_SEP on Unix', async () => {
      mockPlatform.mockReturnValue('darwin');
      const { ENV_PATH_SEP } = await import('../../src/lib/platform.js');
      expect(ENV_PATH_SEP).toBe(':');
    });
  });
});
