import { readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { cosmiconfig } from 'cosmiconfig';
import { tuckConfigSchema, defaultConfig, type TuckConfigOutput } from '../schemas/config.schema.js';
import { getConfigPath, pathExists, getTuckDir } from './paths.js';
import { ConfigError } from '../errors.js';
import { BACKUP_DIR } from '../constants.js';

let cachedConfig: TuckConfigOutput | null = null;
let cachedTuckDir: string | null = null;

export const loadConfig = async (tuckDir?: string): Promise<TuckConfigOutput> => {
  const dir = tuckDir || getTuckDir();

  // Return cached config if same directory
  if (cachedConfig && cachedTuckDir === dir) {
    return cachedConfig;
  }

  const configPath = getConfigPath(dir);

  if (!(await pathExists(configPath))) {
    // Return default config if no config file exists
    cachedConfig = { ...defaultConfig, repository: { ...defaultConfig.repository, path: dir } };
    cachedTuckDir = dir;
    return cachedConfig;
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const rawConfig = JSON.parse(content);
    const result = tuckConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      throw new ConfigError(`Invalid configuration: ${result.error.message}`);
    }

    // Merge with defaults
    cachedConfig = {
      ...defaultConfig,
      ...result.data,
      repository: {
        ...defaultConfig.repository,
        ...result.data.repository,
        path: dir,
      },
      files: {
        ...defaultConfig.files,
        ...result.data.files,
        backupDir: result.data.files?.backupDir || BACKUP_DIR,
      },
    };
    cachedTuckDir = dir;

    return cachedConfig;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new ConfigError('Configuration file contains invalid JSON');
    }
    throw new ConfigError(`Failed to load configuration: ${error}`);
  }
};

export const saveConfig = async (
  config: Partial<TuckConfigOutput>,
  tuckDir?: string
): Promise<void> => {
  const dir = tuckDir || getTuckDir();
  const configPath = getConfigPath(dir);

  // Load existing config and merge
  const existing = await loadConfig(dir);
  const merged = {
    ...existing,
    ...config,
    repository: {
      ...existing.repository,
      ...config.repository,
    },
    files: {
      ...existing.files,
      ...config.files,
    },
    hooks: {
      ...existing.hooks,
      ...config.hooks,
    },
    templates: {
      ...existing.templates,
      ...config.templates,
    },
    encryption: {
      ...existing.encryption,
      ...config.encryption,
    },
    ui: {
      ...existing.ui,
      ...config.ui,
    },
  };

  // Validate before saving
  const result = tuckConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration: ${result.error.message}`);
  }

  try {
    await writeFile(configPath, JSON.stringify(result.data, null, 2) + '\n', 'utf-8');
    // Update cache
    cachedConfig = result.data;
    cachedTuckDir = dir;
  } catch (error) {
    throw new ConfigError(`Failed to save configuration: ${error}`);
  }
};

export const getConfigValue = async <K extends keyof TuckConfigOutput>(
  key: K,
  tuckDir?: string
): Promise<TuckConfigOutput[K]> => {
  const config = await loadConfig(tuckDir);
  return config[key];
};

export const setConfigValue = async <K extends keyof TuckConfigOutput>(
  key: K,
  value: TuckConfigOutput[K],
  tuckDir?: string
): Promise<void> => {
  await saveConfig({ [key]: value } as Partial<TuckConfigOutput>, tuckDir);
};

export const resetConfig = async (tuckDir?: string): Promise<void> => {
  const dir = tuckDir || getTuckDir();
  const configPath = getConfigPath(dir);

  const resetTo = { ...defaultConfig, repository: { ...defaultConfig.repository, path: dir } };

  try {
    await writeFile(configPath, JSON.stringify(resetTo, null, 2) + '\n', 'utf-8');
    cachedConfig = resetTo;
    cachedTuckDir = dir;
  } catch (error) {
    throw new ConfigError(`Failed to reset configuration: ${error}`);
  }
};

export const clearConfigCache = (): void => {
  cachedConfig = null;
  cachedTuckDir = null;
};

export const findTuckDir = async (): Promise<string | null> => {
  // First check default location
  const defaultDir = getTuckDir();
  if (await pathExists(getConfigPath(defaultDir))) {
    return defaultDir;
  }

  // Try cosmiconfig to find config in current directory or parents
  const explorer = cosmiconfig('tuck', {
    searchPlaces: [
      '.tuckrc',
      '.tuckrc.json',
      '.tuckrc.yaml',
      '.tuckrc.yml',
      'tuck.config.js',
      'tuck.config.cjs',
    ],
  });

  try {
    const result = await explorer.search();
    if (result?.filepath) {
      // Return the directory containing the config file, not the file path itself
      return dirname(result.filepath);
    }
  } catch {
    // Ignore search errors
  }

  return null;
};
