import { open, stat } from 'fs/promises';
import { expandPath } from './paths.js';

/**
 * Magic numbers for binary executable detection
 */
const MAGIC_NUMBERS = {
  // ELF (Linux)
  ELF: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  // Mach-O (macOS) - 32-bit
  MACHO_32: Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  // Mach-O (macOS) - 64-bit
  MACHO_64: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  // Mach-O (macOS) - Universal binary
  MACHO_UNIVERSAL: Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  // PE (Windows)
  PE: Buffer.from([0x4d, 0x5a]), // "MZ"
};

/**
 * Script file extensions
 */
const SCRIPT_EXTENSIONS = [
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.py',
  '.rb',
  '.pl',
  '.js',
  '.ts',
  '.lua',
  '.php',
  '.tcl',
  '.awk',
  '.sed',
];

/**
 * Check if a buffer starts with a magic number
 */
const bufferStartsWith = (buffer: Buffer, magic: Buffer): boolean => {
  if (buffer.length < magic.length) {
    return false;
  }
  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) {
      return false;
    }
  }
  return true;
};

/**
 * Check if file is an executable binary by reading magic numbers
 */
export const isBinaryExecutable = async (path: string): Promise<boolean> => {
  const expandedPath = expandPath(path);

  try {
    // Check if file exists and get stats
    const stats = await stat(expandedPath);

    // Directories are not binaries
    if (stats.isDirectory()) {
      return false;
    }

    // Check execute permissions (Unix-like systems)
    // 0o111 = execute bit for owner, group, and others
    const hasExecutePermission = (stats.mode & 0o111) !== 0;

    // Read first 512 bytes to check magic numbers
    const fileHandle = await open(expandedPath, 'r');
    const buffer = Buffer.alloc(512);
    
    try {
      await fileHandle.read(buffer, 0, 512, 0);
    } finally {
      await fileHandle.close();
    }

    // Check for binary magic numbers
    if (
      bufferStartsWith(buffer, MAGIC_NUMBERS.ELF) ||
      bufferStartsWith(buffer, MAGIC_NUMBERS.MACHO_32) ||
      bufferStartsWith(buffer, MAGIC_NUMBERS.MACHO_64) ||
      bufferStartsWith(buffer, MAGIC_NUMBERS.MACHO_UNIVERSAL) ||
      bufferStartsWith(buffer, MAGIC_NUMBERS.PE)
    ) {
      return true;
    }

    // If has execute permission but no magic number, might be a script
    // Check if it's actually a script (has shebang)
    if (hasExecutePermission) {
      const startsWithShebang = buffer[0] === 0x23 && buffer[1] === 0x21; // "#!"
      return !startsWithShebang; // Binary if no shebang
    }

    return false;
  } catch {
    return false;
  }
};

/**
 * Check if file is a script based on shebang or extension
 */
export const isScriptFile = async (path: string): Promise<boolean> => {
  const expandedPath = expandPath(path);

  try {
    // Check extension first
    const hasScriptExtension = SCRIPT_EXTENSIONS.some((ext) => expandedPath.endsWith(ext));
    if (hasScriptExtension) {
      return true;
    }

    // Check for shebang
    const stats = await stat(expandedPath);
    if (stats.isDirectory()) {
      return false;
    }

    const fileHandle = await open(expandedPath, 'r');
    const buffer = Buffer.alloc(2);
    
    try {
      await fileHandle.read(buffer, 0, 2, 0);
    } finally {
      await fileHandle.close();
    }

    // Check for shebang "#!"
    return buffer[0] === 0x23 && buffer[1] === 0x21;
  } catch {
    return false;
  }
};

/**
 * Check if file should be excluded from bin directory tracking
 * Returns true for binary executables in ~/bin or ~/.local/bin
 * Returns false for script files
 */
export const shouldExcludeFromBin = async (path: string): Promise<boolean> => {
  const expandedPath = expandPath(path);

  // Check if file is in a bin directory
  const isInBinDir = expandedPath.includes('/bin/') || 
                     expandedPath.includes('/.local/bin/') ||
                     expandedPath.endsWith('/bin') ||
                     expandedPath.endsWith('/.local/bin');

  if (!isInBinDir) {
    return false;
  }

  // Check if it's a directory (don't exclude directories themselves)
  try {
    const stats = await stat(expandedPath);
    if (stats.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  // If it's a script, don't exclude it
  if (await isScriptFile(expandedPath)) {
    return false;
  }

  // If it's a binary executable, exclude it
  return await isBinaryExecutable(expandedPath);
};

/**
 * Get a human-readable description of why a file is being excluded
 */
export const getBinaryExclusionReason = async (path: string): Promise<string | null> => {
  if (await shouldExcludeFromBin(path)) {
    return 'Binary executable in bin directory';
  }
  return null;
};

