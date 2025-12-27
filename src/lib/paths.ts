import { homedir } from 'os';
import { join, basename, dirname, relative, isAbsolute, resolve } from 'path';
import { stat, access } from 'fs/promises';
import { constants } from 'fs';
import { DEFAULT_TUCK_DIR, FILES_DIR, MANIFEST_FILE, CONFIG_FILE, CATEGORIES } from '../constants.js';

export const expandPath = (path: string): string => {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith('$HOME/')) {
    return join(homedir(), path.slice(6));
  }
  return isAbsolute(path) ? path : resolve(path);
};

export const collapsePath = (path: string): string => {
  const home = homedir();
  if (path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
};

export const getTuckDir = (customDir?: string): string => {
  return expandPath(customDir || DEFAULT_TUCK_DIR);
};

export const getManifestPath = (tuckDir: string): string => {
  return join(tuckDir, MANIFEST_FILE);
};

export const getConfigPath = (tuckDir: string): string => {
  return join(tuckDir, CONFIG_FILE);
};

export const getFilesDir = (tuckDir: string): string => {
  return join(tuckDir, FILES_DIR);
};

export const getCategoryDir = (tuckDir: string, category: string): string => {
  return join(getFilesDir(tuckDir), category);
};

export const getDestinationPath = (tuckDir: string, category: string, filename: string): string => {
  return join(getCategoryDir(tuckDir, category), filename);
};

export const getRelativeDestination = (category: string, filename: string): string => {
  return join(FILES_DIR, category, filename);
};

export const sanitizeFilename = (filepath: string): string => {
  const base = basename(filepath);
  // Remove leading dot for storage, but keep track that it was a dotfile
  return base.startsWith('.') ? base.slice(1) : base;
};

export const detectCategory = (filepath: string): string => {
  const expandedPath = expandPath(filepath);
  const relativePath = collapsePath(expandedPath);

  for (const [category, config] of Object.entries(CATEGORIES)) {
    for (const pattern of config.patterns) {
      // Check if the pattern matches the path
      if (relativePath.endsWith(pattern) || relativePath.includes(pattern)) {
        return category;
      }
      // Check just the filename
      const filename = basename(expandedPath);
      if (filename === pattern || filename === basename(pattern)) {
        return category;
      }
    }
  }

  return 'misc';
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

export const isFile = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
};

export const isSymlink = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
};

export const isReadable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

export const isWritable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export const getRelativePath = (from: string, to: string): string => {
  return relative(dirname(from), to);
};

export const generateFileId = (source: string): string => {
  // Create a unique ID from the source path
  const collapsed = collapsePath(source);
  // Remove special characters and create a readable ID
  return collapsed
    .replace(/^~\//, '')
    .replace(/\//g, '_')
    .replace(/\./g, '-')
    .replace(/^-/, '');
};
