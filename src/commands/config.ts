import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { prompts, logger, banner } from '../ui/index.js';
import { getTuckDir, getConfigPath, collapsePath } from '../lib/paths.js';
import { loadConfig, saveConfig, resetConfig } from '../lib/config.js';
import { loadManifest } from '../lib/manifest.js';
import { NotInitializedError, ConfigError } from '../errors.js';
import type { TuckConfigOutput } from '../schemas/config.schema.js';

/**
 * Configuration key metadata for validation and help
 */
interface ConfigKeyInfo {
  path: string;
  type: 'boolean' | 'string' | 'enum';
  description: string;
  section: string;
  options?: string[]; // For enum types
}

const CONFIG_KEYS: ConfigKeyInfo[] = [
  // Repository settings
  { path: 'repository.defaultBranch', type: 'string', description: 'Default git branch name', section: 'repository' },
  { path: 'repository.autoCommit', type: 'boolean', description: 'Auto-commit changes on sync', section: 'repository' },
  { path: 'repository.autoPush', type: 'boolean', description: 'Auto-push after commit', section: 'repository' },
  // File settings
  { path: 'files.strategy', type: 'enum', description: 'File copy strategy', section: 'files', options: ['copy', 'symlink'] },
  { path: 'files.backupOnRestore', type: 'boolean', description: 'Create backups before restore', section: 'files' },
  { path: 'files.backupDir', type: 'string', description: 'Backup directory path', section: 'files' },
  // UI settings
  { path: 'ui.colors', type: 'boolean', description: 'Enable colored output', section: 'ui' },
  { path: 'ui.emoji', type: 'boolean', description: 'Enable emoji in output', section: 'ui' },
  { path: 'ui.verbose', type: 'boolean', description: 'Enable verbose logging', section: 'ui' },
  // Hook settings
  { path: 'hooks.preSync', type: 'string', description: 'Command to run before sync', section: 'hooks' },
  { path: 'hooks.postSync', type: 'string', description: 'Command to run after sync', section: 'hooks' },
  { path: 'hooks.preRestore', type: 'string', description: 'Command to run before restore', section: 'hooks' },
  { path: 'hooks.postRestore', type: 'string', description: 'Command to run after restore', section: 'hooks' },
  // Template settings
  { path: 'templates.enabled', type: 'boolean', description: 'Enable template processing', section: 'templates' },
  // Encryption settings
  { path: 'encryption.enabled', type: 'boolean', description: 'Enable file encryption', section: 'encryption' },
  { path: 'encryption.gpgKey', type: 'string', description: 'GPG key for encryption', section: 'encryption' },
];

const getKeyInfo = (path: string): ConfigKeyInfo | undefined => {
  return CONFIG_KEYS.find((k) => k.path === path);
};

const formatConfigValue = (value: unknown): string => {
  if (value === undefined || value === null) return chalk.dim('(not set)');
  if (typeof value === 'boolean') return value ? chalk.green('true') : chalk.yellow('false');
  if (Array.isArray(value)) return value.length ? chalk.cyan(value.join(', ')) : chalk.dim('[]');
  if (typeof value === 'object') return chalk.dim(JSON.stringify(value));
  return chalk.white(String(value));
};

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

/**
 * Show configuration in a visually organized way
 */
const showConfigView = async (config: TuckConfigOutput): Promise<void> => {
  const configObj = config as unknown as Record<string, unknown>;

  const sections = [
    { key: 'repository', title: 'Repository Settings', icon: '*' },
    { key: 'files', title: 'File Management', icon: '>' },
    { key: 'ui', title: 'User Interface', icon: '#' },
    { key: 'hooks', title: 'Hooks', icon: '!' },
    { key: 'templates', title: 'Templates', icon: '%' },
    { key: 'encryption', title: 'Encryption', icon: '@' },
  ];

  for (const section of sections) {
    const sectionConfig = configObj[section.key];
    if (!sectionConfig || typeof sectionConfig !== 'object') continue;

    console.log(chalk.bold.cyan(`${section.icon} ${section.title}`));
    console.log(chalk.dim('-'.repeat(40)));

    for (const [key, value] of Object.entries(sectionConfig as Record<string, unknown>)) {
      const keyInfo = getKeyInfo(`${section.key}.${key}`);
      const displayValue = formatConfigValue(value);
      const description = keyInfo?.description || '';

      console.log(`  ${chalk.white(key)}: ${displayValue}`);
      if (description) {
        console.log(chalk.dim(`    ${description}`));
      }
    }
    console.log();
  }
};

/**
 * Run configuration wizard for guided setup
 */
const runConfigWizard = async (config: TuckConfigOutput, tuckDir: string): Promise<void> => {
  prompts.log.info("Let's configure tuck for your workflow");
  console.log();

  // Repository behavior
  console.log(chalk.bold.cyan('* Repository Behavior'));
  const autoCommit = await prompts.confirm(
    'Auto-commit changes when running sync?',
    config.repository.autoCommit ?? true
  );
  const autoPush = await prompts.confirm(
    'Auto-push to remote after commit?',
    config.repository.autoPush ?? false
  );

  // File strategy
  console.log();
  console.log(chalk.bold.cyan('> File Strategy'));
  const strategy = await prompts.select('How should tuck manage files?', [
    { value: 'copy', label: 'Copy files', hint: 'Safe, independent copies' },
    { value: 'symlink', label: 'Symlink files', hint: 'Real-time updates, single source of truth' },
  ]) as 'copy' | 'symlink';

  const backupOnRestore = await prompts.confirm(
    'Create backups before restoring files?',
    config.files.backupOnRestore ?? true
  );

  // UI preferences
  console.log();
  console.log(chalk.bold.cyan('# User Interface'));
  const colors = await prompts.confirm('Enable colored output?', config.ui.colors ?? true);
  const emoji = await prompts.confirm('Enable emoji in output?', config.ui.emoji ?? true);
  const verbose = await prompts.confirm('Enable verbose logging?', config.ui.verbose ?? false);

  // Apply changes
  const updatedConfig: TuckConfigOutput = {
    ...config,
    repository: {
      ...config.repository,
      autoCommit,
      autoPush,
    },
    files: {
      ...config.files,
      strategy,
      backupOnRestore,
    },
    ui: {
      colors,
      emoji,
      verbose,
    },
  };

  await saveConfig(updatedConfig, tuckDir);

  console.log();
  prompts.log.success('Configuration updated!');
  prompts.note("Run 'tuck config' again to view or edit settings", 'Tip');
};

/**
 * Interactive edit a single setting
 */
const editConfigInteractive = async (config: TuckConfigOutput, tuckDir: string): Promise<void> => {
  const configObj = config as unknown as Record<string, unknown>;

  // Create options for selection
  const options = CONFIG_KEYS.map((key) => {
    const currentValue = getNestedValue(configObj, key.path);
    return {
      value: key.path,
      label: key.path,
      hint: `${key.description} (current: ${formatConfigValue(currentValue)})`,
    };
  });

  const selectedKey = await prompts.select('Select setting to edit:', options) as string;
  const keyInfo = getKeyInfo(selectedKey);
  const currentValue = getNestedValue(configObj, selectedKey);

  if (!keyInfo) {
    logger.error(`Unknown key: ${selectedKey}`);
    return;
  }

  let newValue: unknown;

  switch (keyInfo.type) {
    case 'boolean':
      newValue = await prompts.confirm(keyInfo.description, currentValue as boolean ?? false);
      break;
    case 'enum':
      newValue = await prompts.select(`Select value for ${selectedKey}:`,
        (keyInfo.options || []).map((opt) => ({ value: opt, label: opt }))
      );
      break;
    case 'string':
      newValue = await prompts.text(`Enter value for ${selectedKey}:`, {
        defaultValue: (currentValue as string) || '',
        placeholder: '(leave empty to clear)',
      });
      break;
  }

  setNestedValue(configObj, selectedKey, newValue);
  await saveConfig(config, tuckDir);

  prompts.log.success(`Updated ${selectedKey} = ${formatConfigValue(newValue)}`);
};

/**
 * Run interactive config mode
 */
const runInteractiveConfig = async (): Promise<void> => {
  banner();
  prompts.intro('tuck config');

  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  const action = await prompts.select('What would you like to do?', [
    { value: 'view', label: 'View current configuration', hint: 'See all settings' },
    { value: 'edit', label: 'Edit a setting', hint: 'Modify a specific value' },
    { value: 'wizard', label: 'Run setup wizard', hint: 'Guided configuration' },
    { value: 'reset', label: 'Reset to defaults', hint: 'Restore default values' },
    { value: 'open', label: 'Open in editor', hint: `Edit with ${process.env.EDITOR || 'vim'}` },
  ]) as string;

  console.log();

  switch (action) {
    case 'view':
      await showConfigView(config);
      break;
    case 'edit':
      await editConfigInteractive(config, tuckDir);
      break;
    case 'wizard':
      await runConfigWizard(config, tuckDir);
      break;
    case 'reset':
      await runConfigReset();
      break;
    case 'open':
      await runConfigEdit();
      break;
  }

  prompts.outro('Done!');
};

export const configCommand = new Command('config')
  .description('Manage tuck configuration')
  .action(async () => {
    const tuckDir = getTuckDir();
    try {
      await loadManifest(tuckDir);
    } catch {
      throw new NotInitializedError();
    }
    await runInteractiveConfig();
  })
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
