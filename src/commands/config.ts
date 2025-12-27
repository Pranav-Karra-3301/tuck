import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { prompts, logger } from '../ui/index.js';
import { getTuckDir, getConfigPath, collapsePath } from '../lib/paths.js';
import { loadConfig, saveConfig, resetConfig } from '../lib/config.js';
import { loadManifest } from '../lib/manifest.js';
import { NotInitializedError, ConfigError } from '../errors.js';
import type { TuckConfigOutput } from '../schemas/config.schema.js';

const printConfig = (config: TuckConfigOutput): void => {
  console.log(JSON.stringify(config, null, 2));
};

const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
};

const setNestedValue = (
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void => {
  const keys = path.split('.');
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;
};

const parseValue = (value: string): unknown => {
  // Try to parse as JSON
  try {
    return JSON.parse(value);
  } catch {
    // Return as string if not valid JSON
    return value;
  }
};

const runConfigGet = async (key: string): Promise<void> => {
  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  const value = getNestedValue(config as unknown as Record<string, unknown>, key);

  if (value === undefined) {
    logger.error(`Key not found: ${key}`);
    return;
  }

  if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
};

const runConfigSet = async (key: string, value: string): Promise<void> => {
  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  const parsedValue = parseValue(value);
  const configObj = config as unknown as Record<string, unknown>;

  setNestedValue(configObj, key, parsedValue);

  await saveConfig(config, tuckDir);
  logger.success(`Set ${key} = ${JSON.stringify(parsedValue)}`);
};

const runConfigList = async (): Promise<void> => {
  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  prompts.intro('tuck config');
  console.log();
  console.log(chalk.dim('Configuration file:'), collapsePath(getConfigPath(tuckDir)));
  console.log();

  printConfig(config);
};

const runConfigEdit = async (): Promise<void> => {
  const tuckDir = getTuckDir();
  const configPath = getConfigPath(tuckDir);

  const editor = process.env.EDITOR || process.env.VISUAL || 'vim';

  logger.info(`Opening ${collapsePath(configPath)} in ${editor}...`);

  return new Promise((resolve, reject) => {
    const child = spawn(editor, [configPath], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      if (code === 0) {
        logger.success('Configuration updated');
        resolve();
      } else {
        reject(new ConfigError(`Editor exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(new ConfigError(`Failed to open editor: ${err.message}`));
    });
  });
};

const runConfigReset = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  const confirm = await prompts.confirm('Reset configuration to defaults? This cannot be undone.', false);

  if (!confirm) {
    prompts.cancel('Operation cancelled');
    return;
  }

  await resetConfig(tuckDir);
  logger.success('Configuration reset to defaults');
};

export const configCommand = new Command('config')
  .description('Manage tuck configuration')
  .addCommand(
    new Command('get')
      .description('Get a config value')
      .argument('<key>', 'Config key (e.g., "repository.autoCommit")')
      .action(async (key: string) => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigGet(key);
      })
  )
  .addCommand(
    new Command('set')
      .description('Set a config value')
      .argument('<key>', 'Config key')
      .argument('<value>', 'Value to set (JSON or string)')
      .action(async (key: string, value: string) => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigSet(key, value);
      })
  )
  .addCommand(
    new Command('list')
      .description('List all config')
      .action(async () => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigList();
      })
  )
  .addCommand(
    new Command('edit')
      .description('Open config in editor')
      .action(async () => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigEdit();
      })
  )
  .addCommand(
    new Command('reset')
      .description('Reset to defaults')
      .action(async () => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigReset();
      })
  );
