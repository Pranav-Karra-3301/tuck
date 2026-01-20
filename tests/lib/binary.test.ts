import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the platform module with all required exports
const mockIsWindows = vi.fn();
vi.mock('../../src/lib/platform.js', () => ({
  get IS_WINDOWS() {
    return mockIsWindows();
  },
  IS_MACOS: false,
  IS_LINUX: true,
  expandWindowsEnvVars: (path: string) => path,
  toPosixPath: (path: string) => path.replace(/\\/g, '/'),
  fromPosixPath: (path: string) => path,
  normalizePath: (path: string) => path,
}));

describe('binary', () => {
  let testDir: string;

  beforeEach(async () => {
    vi.resetModules();
    testDir = join(tmpdir(), `tuck-binary-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('isScriptFile', () => {
    describe('Unix script extensions', () => {
      beforeEach(() => {
        mockIsWindows.mockReturnValue(false);
      });

      it('should detect .sh files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.sh');
        await writeFile(filePath, '#!/bin/bash\necho hello');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .bash files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.bash');
        await writeFile(filePath, 'echo hello');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .zsh files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.zsh');
        await writeFile(filePath, 'echo hello');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .fish files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'config.fish');
        await writeFile(filePath, 'echo hello');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .py files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.py');
        await writeFile(filePath, 'print("hello")');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect files with shebang', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'myscript');
        await writeFile(filePath, '#!/usr/bin/env node\nconsole.log("hello")');
        expect(await isScriptFile(filePath)).toBe(true);
      });
    });

    describe('Windows script extensions', () => {
      beforeEach(() => {
        mockIsWindows.mockReturnValue(true);
      });

      it('should detect .ps1 PowerShell files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.ps1');
        await writeFile(filePath, 'Write-Host "Hello"');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .psm1 PowerShell module files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'module.psm1');
        await writeFile(filePath, 'function Test { }');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .psd1 PowerShell data files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'data.psd1');
        await writeFile(filePath, '@{ }');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .bat batch files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.bat');
        await writeFile(filePath, '@echo off\necho hello');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .cmd command files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.cmd');
        await writeFile(filePath, '@echo off\necho hello');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .vbs VBScript files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.vbs');
        await writeFile(filePath, 'WScript.Echo "Hello"');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .wsf Windows Script files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'script.wsf');
        await writeFile(filePath, '<job></job>');
        expect(await isScriptFile(filePath)).toBe(true);
      });
    });

    describe('cross-platform script extensions', () => {
      it('should detect .py on any platform', async () => {
        mockIsWindows.mockReturnValue(false);
        let { isScriptFile } = await import('../../src/lib/binary.js');
        let filePath = join(testDir, 'script1.py');
        await writeFile(filePath, 'print("hello")');
        expect(await isScriptFile(filePath)).toBe(true);

        vi.resetModules();
        mockIsWindows.mockReturnValue(true);
        ({ isScriptFile } = await import('../../src/lib/binary.js'));
        filePath = join(testDir, 'script2.py');
        await writeFile(filePath, 'print("hello")');
        expect(await isScriptFile(filePath)).toBe(true);
      });

      it('should detect .js on any platform', async () => {
        mockIsWindows.mockReturnValue(false);
        let { isScriptFile } = await import('../../src/lib/binary.js');
        let filePath = join(testDir, 'script1.js');
        await writeFile(filePath, 'console.log("hello")');
        expect(await isScriptFile(filePath)).toBe(true);

        vi.resetModules();
        mockIsWindows.mockReturnValue(true);
        ({ isScriptFile } = await import('../../src/lib/binary.js'));
        filePath = join(testDir, 'script2.js');
        await writeFile(filePath, 'console.log("hello")');
        expect(await isScriptFile(filePath)).toBe(true);
      });
    });

    describe('non-script files', () => {
      beforeEach(() => {
        mockIsWindows.mockReturnValue(false);
      });

      it('should not detect text files without shebang', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'readme.txt');
        await writeFile(filePath, 'This is just a readme');
        expect(await isScriptFile(filePath)).toBe(false);
      });

      it('should not detect binary files', async () => {
        const { isScriptFile } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'binary');
        await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
        expect(await isScriptFile(filePath)).toBe(false);
      });
    });
  });

  describe('isBinaryExecutable', () => {
    describe('on Unix', () => {
      beforeEach(() => {
        mockIsWindows.mockReturnValue(false);
      });

      it('should detect files with execute permission and binary magic', async () => {
        const { isBinaryExecutable } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'executable');
        // ELF header
        const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
        await writeFile(filePath, elfHeader);
        await chmod(filePath, 0o755);

        expect(await isBinaryExecutable(filePath)).toBe(true);
      });

      it('should not detect files without execute permission', async () => {
        const { isBinaryExecutable } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'non-executable');
        await writeFile(filePath, 'just text');
        await chmod(filePath, 0o644);

        expect(await isBinaryExecutable(filePath)).toBe(false);
      });

      it('should not detect scripts as binary executables', async () => {
        const { isBinaryExecutable } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'shebang-script');
        await writeFile(filePath, '#!/bin/bash\necho hello');
        await chmod(filePath, 0o755);

        // Scripts are scripts, not binary executables
        // isBinaryExecutable checks for binary magic numbers, not just execute permission
        expect(await isBinaryExecutable(filePath)).toBe(false);
      });
    });

    describe('on Windows', () => {
      beforeEach(() => {
        mockIsWindows.mockReturnValue(true);
      });

      it('should detect .exe files', async () => {
        const { isBinaryExecutable } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'program.exe');
        // Write a minimal PE header (MZ magic number)
        const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
        await writeFile(filePath, peHeader);

        expect(await isBinaryExecutable(filePath)).toBe(true);
      });

      it('should detect .com files', async () => {
        const { isBinaryExecutable } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'program.com');
        await writeFile(filePath, Buffer.from([0x00, 0x00]));

        expect(await isBinaryExecutable(filePath)).toBe(true);
      });

      it('should detect .dll files', async () => {
        const { isBinaryExecutable } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'library.dll');
        // Write MZ header
        const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
        await writeFile(filePath, peHeader);

        expect(await isBinaryExecutable(filePath)).toBe(true);
      });

      it('should not detect regular text files on Windows', async () => {
        const { isBinaryExecutable } = await import('../../src/lib/binary.js');
        const filePath = join(testDir, 'regular.txt');
        await writeFile(filePath, 'just text');

        // On Windows, regular text files should not be detected as binary executables
        expect(await isBinaryExecutable(filePath)).toBe(false);
      });
    });
  });

  describe('magic number detection', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should detect ELF binaries', async () => {
      const { isBinaryExecutable } = await import('../../src/lib/binary.js');
      const filePath = join(testDir, 'elf-binary');
      // ELF magic number: 0x7F 'E' 'L' 'F'
      const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      await writeFile(filePath, elfHeader);
      await chmod(filePath, 0o755);

      expect(await isBinaryExecutable(filePath)).toBe(true);
    });

    it('should detect Mach-O binaries (64-bit)', async () => {
      const { isBinaryExecutable } = await import('../../src/lib/binary.js');
      const filePath = join(testDir, 'macho-binary');
      // Mach-O 64-bit magic number (little endian)
      const machoHeader = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
      await writeFile(filePath, machoHeader);
      await chmod(filePath, 0o755);

      expect(await isBinaryExecutable(filePath)).toBe(true);
    });

    it('should detect PE/Windows executables', async () => {
      const { isBinaryExecutable } = await import('../../src/lib/binary.js');
      const filePath = join(testDir, 'pe-binary');
      // MZ magic number (DOS stub)
      const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
      await writeFile(filePath, peHeader);
      await chmod(filePath, 0o755);

      expect(await isBinaryExecutable(filePath)).toBe(true);
    });
  });
});
