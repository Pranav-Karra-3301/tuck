import { Command } from 'commander';
import { spawn } from 'child_process';
import { prompts, logger, banner, colors as c } from '../ui/index.js';
import { getTuckDir, getConfigPath, collapsePath } from '../lib/paths.js';
import { loadConfig, saveConfig, resetConfig, clearConfigCache } from '../lib/config.js';
import { loadManifest } from '../lib/manifest.js';
import { upsertRemote } from '../lib/git.js';
import { NotInitializedError, ConfigError } from '../errors.js';
import type { TuckConfigOutput } from '../schemas/config.schema.js';
import { setupProvider } from '../lib/providerSetup.js';
import { describeProviderConfig, getProvider } from '../lib/providers/index.js';
import { setupRemoteForProvider } from '../lib/remoteSetup.js';
import { setJsonMode, isJsonMode, emitJsonOk } from '../lib/jsonOutput.js';
import { IS_WINDOWS } from '../lib/platform.js';

/**
 * Resolve the editor to open config files with. Honors $EDITOR then $VISUAL,
 * falling back to a sane platform default (Windows has no vim/vi out of the box).
 */
export const getDefaultEditor = (): string =>
  process.env.EDITOR || process.env.VISUAL || (IS_WINDOWS ? 'notepad' : 'vim');

interface ConfigGetOptions {
  json?: boolean;
}

interface ConfigSetOptions {
  json?: boolean;
}

interface ConfigListOptions {
  json?: boolean;
}

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
  {
    path: 'repository.defaultBranch',
    type: 'string',
    description: 'Default git branch name',
    section: 'repository',
  },
  {
    path: 'repository.autoCommit',
    type: 'boolean',
    description: 'Auto-commit changes on sync',
    section: 'repository',
  },
  {
    path: 'repository.autoPush',
    type: 'boolean',
    description: 'Auto-push after commit',
    section: 'repository',
  },
  // File settings
  {
    path: 'files.strategy',
    type: 'enum',
    description: 'File copy strategy',
    section: 'files',
    options: ['copy', 'symlink'],
  },
  {
    path: 'files.backupOnRestore',
    type: 'boolean',
    description: 'Create backups before restore',
    section: 'files',
  },
  {
    path: 'files.backupDir',
    type: 'string',
    description: 'Backup directory path',
    section: 'files',
  },
  // UI settings
  { path: 'ui.colors', type: 'boolean', description: 'Enable colored output', section: 'ui' },
  { path: 'ui.emoji', type: 'boolean', description: 'Enable emoji in output', section: 'ui' },
  { path: 'ui.verbose', type: 'boolean', description: 'Enable verbose logging', section: 'ui' },
  // Hook settings
  {
    path: 'hooks.preSync',
    type: 'string',
    description: 'Command to run before sync',
    section: 'hooks',
  },
  {
    path: 'hooks.postSync',
    type: 'string',
    description: 'Command to run after sync',
    section: 'hooks',
  },
  {
    path: 'hooks.preRestore',
    type: 'string',
    description: 'Command to run before restore',
    section: 'hooks',
  },
  {
    path: 'hooks.postRestore',
    type: 'string',
    description: 'Command to run after restore',
    section: 'hooks',
  },
  // Encryption settings
  {
    path: 'encryption.backupsEnabled',
    type: 'boolean',
    description: 'Enable backup encryption',
    section: 'encryption',
  },
];

const UNSUPPORTED_CONFIG_KEY_PREFIXES = [
  'templates',
  'encryption.enabled',
  'encryption.gpgKey',
  'encryption.files',
];

const getKeyInfo = (path: string): ConfigKeyInfo | undefined => {
  return CONFIG_KEYS.find((k) => k.path === path);
};

const formatConfigValue = (value: unknown): string => {
  if (value === undefined || value === null) return c.dim('(not set)');
  if (typeof value === 'boolean') return value ? c.green('true') : c.yellow('false');
  if (Array.isArray(value)) return value.length ? c.cyan(value.join(', ')) : c.dim('[]');
  if (typeof value === 'object') return c.dim(JSON.stringify(value));
  return c.white(String(value));
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

const setNestedValue = (obj: Record<string, unknown>, path: string, value: unknown): void => {
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

const runConfigGet = async (key: string, options: ConfigGetOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck config get');

  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  const value = getNestedValue(config as unknown as Record<string, unknown>, key);

  if (value === undefined) {
    if (isJsonMode()) {
      emitJsonOk({ key, value: null });
      return;
    }
    logger.error(`Key not found: ${key}`);
    return;
  }

  if (isJsonMode()) {
    emitJsonOk({ key, value });
    return;
  }

  if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
};

export const runConfigSet = async (
  key: string,
  value: string,
  options: ConfigSetOptions = {}
): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck config set');

  const unsupportedPrefix = UNSUPPORTED_CONFIG_KEY_PREFIXES.find(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`)
  );

  if (unsupportedPrefix) {
    throw new ConfigError(
      `Unsupported config key: ${key}. This setting is reserved but not wired yet.`
    );
  }

  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  const parsedValue = parseValue(value);
  const configObj = config as unknown as Record<string, unknown>;

  setNestedValue(configObj, key, parsedValue);

  await saveConfig(config, tuckDir);
  // saveConfig leaves the cache populated with the just-written value. Drop it so
  // a later loadConfig re-reads disk and an out-of-band change isn't masked by a
  // stale in-memory cache for the rest of this run.
  clearConfigCache();

  if (isJsonMode()) {
    emitJsonOk({ key, value: parsedValue, updated: true });
    return;
  }

  logger.success(`Set ${key} = ${JSON.stringify(parsedValue)}`);
};

const runConfigList = async (options: ConfigListOptions = {}): Promise<void> => {
  if (options.json) setJsonMode(true, 'tuck config list');

  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  if (isJsonMode()) {
    emitJsonOk({ config });
    return;
  }

  prompts.intro('tuck config');
  console.log();
  console.log(c.dim('Configuration file:'), collapsePath(getConfigPath(tuckDir)));
  console.log();

  printConfig(config);
};

const runConfigEdit = async (): Promise<void> => {
  const tuckDir = getTuckDir();
  const configPath = getConfigPath(tuckDir);

  const editor = getDefaultEditor();

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

  const confirm = await prompts.confirm(
    'Reset configuration to defaults? This cannot be undone.',
    false
  );

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

  // Show remote configuration first
  if (config.remote) {
    console.log(c.bold.cyan('~ Remote Provider'));
    console.log(c.dim('-'.repeat(40)));
    console.log(`  ${describeProviderConfig(config.remote)}`);
    console.log();
  }

  const sections = [
    { key: 'repository', title: 'Repository Settings', icon: '*' },
    { key: 'files', title: 'File Management', icon: '>' },
    { key: 'ui', title: 'User Interface', icon: '#' },
    { key: 'hooks', title: 'Hooks', icon: '!' },
    { key: 'encryption', title: 'Encryption', icon: '@' },
  ];

  for (const section of sections) {
    const sectionConfig = configObj[section.key];
    if (!sectionConfig || typeof sectionConfig !== 'object') continue;

    console.log(c.bold.cyan(`${section.icon} ${section.title}`));
    console.log(c.dim('-'.repeat(40)));

    const sectionEntries = Object.entries(sectionConfig as Record<string, unknown>).filter(
      ([key]) => {
        if (section.key === 'encryption') {
          return getKeyInfo(`${section.key}.${key}`) !== undefined;
        }
        return true;
      }
    );

    for (const [key, value] of sectionEntries) {
      const keyInfo = getKeyInfo(`${section.key}.${key}`);
      const displayValue = formatConfigValue(value);
      const description = keyInfo?.description || '';

      console.log(`  ${c.white(key)}: ${displayValue}`);
      if (description) {
        console.log(c.dim(`    ${description}`));
      }
    }
    console.log();
  }

  if (config.templates?.enabled || Object.keys(config.templates?.variables || {}).length > 0) {
    console.log(c.yellow('! Templates config is currently reserved and not applied during restore/sync.'));
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
  console.log(c.bold.cyan('* Repository Behavior'));
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
  console.log(c.bold.cyan('> File Strategy'));
  const rawStrategy = await prompts.select('How should tuck manage files?', [
    { value: 'copy', label: 'Copy files', hint: 'Safe, independent copies' },
    { value: 'symlink', label: 'Symlink files', hint: 'Real-time updates, single source of truth' },
  ]);
  const strategy: 'copy' | 'symlink' =
    rawStrategy === 'copy' || rawStrategy === 'symlink'
      ? rawStrategy
      : (config.files.strategy ?? 'copy');

  const backupOnRestore = await prompts.confirm(
    'Create backups before restoring files?',
    config.files.backupOnRestore ?? true
  );

  // UI preferences
  console.log();
  console.log(c.bold.cyan('# User Interface'));
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
  // Drop the now-stale cache so a later read in the same run sees the write.
  clearConfigCache();

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

  const selectedKey = (await prompts.select('Select setting to edit:', options)) as string;
  const keyInfo = getKeyInfo(selectedKey);
  const currentValue = getNestedValue(configObj, selectedKey);

  if (!keyInfo) {
    logger.error(`Unknown key: ${selectedKey}`);
    return;
  }

  let newValue: unknown;

  switch (keyInfo.type) {
    case 'boolean': {
      const defaultValue = typeof currentValue === 'boolean' ? currentValue : false;
      newValue = await prompts.confirm(keyInfo.description, defaultValue);
      break;
    }
    case 'enum':
      newValue = await prompts.select(
        `Select value for ${selectedKey}:`,
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
  // Drop the now-stale cache so a later read in the same run sees the write.
  clearConfigCache();

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

  const action = (await prompts.select('What would you like to do?', [
    { value: 'view', label: 'View current configuration', hint: 'See all settings' },
    { value: 'edit', label: 'Edit a setting', hint: 'Modify a specific value' },
    { value: 'remote', label: 'Configure remote', hint: 'Set up GitHub, GitLab, or local mode' },
    { value: 'wizard', label: 'Run setup wizard', hint: 'Guided configuration' },
    { value: 'reset', label: 'Reset to defaults', hint: 'Restore default values' },
    { value: 'open', label: 'Open in editor', hint: `Edit with ${getDefaultEditor()}` },
  ])) as string;

  console.log();

  switch (action) {
    case 'view':
      await showConfigView(config);
      break;
    case 'edit':
      await editConfigInteractive(config, tuckDir);
      break;
    case 'remote':
      await runConfigRemote();
      return; // runConfigRemote has its own outro
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

/**
 * Run the remote provider configuration flow.
 *
 * Exported for unit testing the provider-agnostic remote-setup dedup.
 */
export const runConfigRemote = async (): Promise<void> => {
  banner();
  prompts.intro('tuck config remote');

  const tuckDir = getTuckDir();
  const config = await loadConfig(tuckDir);

  // Show current configuration
  if (config.remote) {
    console.log();
    console.log(c.dim('Current remote configuration:'));
    console.log(`  ${describeProviderConfig(config.remote)}`);
    console.log();
  }

  // Ask if they want to change
  const shouldChange = await prompts.confirm('Configure remote provider?', true);

  if (!shouldChange) {
    prompts.outro('No changes made');
    return;
  }

  // Run provider setup
  const result = await setupProvider();

  if (!result) {
    prompts.outro('Configuration cancelled');
    return;
  }

  // Update config with new remote settings
  const updatedConfig: TuckConfigOutput = {
    ...config,
    remote: result.config,
  };

  await saveConfig(updatedConfig, tuckDir);
  // Drop the post-write cache so any subsequent load re-reads disk (avoids a
  // stale in-memory config masking an out-of-band change during this run).
  clearConfigCache();

  // Track whether a remote URL was ACTUALLY configured so the final message
  // reflects reality (and never prints a false "Remote configured" success).
  let configuredRemoteUrl: string | null = result.remoteUrl ?? null;

  // If a remote URL was provided, update the git remote.
  if (result.remoteUrl) {
    try {
      // Idempotent upsert: set-url if origin exists, else add. This avoids the
      // remove-then-add race (a transient state with NO origin) that the old
      // code created when reconfiguring an existing repo.
      await upsertRemote(tuckDir, 'origin', result.remoteUrl);
      prompts.log.success('Git remote updated');
    } catch (error) {
      prompts.log.warning(
        `Could not update git remote: ${error instanceof Error ? error.message : String(error)}`
      );
      prompts.log.info(`Manually add remote: git remote add origin ${result.remoteUrl}`);
      // The remote wasn't actually wired up; don't claim it was.
      configuredRemoteUrl = null;
    }
  }

  // If no remote URL was configured yet and the provider needs one (github /
  // gitlab / custom), route through the SAME provider-agnostic remote-setup
  // helper that `tuck init` uses. This deduplicates the old ad-hoc
  // createRepo/getPreferredRepoUrl flow and ensures gitlab/custom go through
  // their own provider instead of a github-shaped path.
  //
  // The helper now UPSERTS `origin` itself (no pre-remove dance here), so a
  // reconfiguration won't hit the remove-then-add race.
  if (result.mode !== 'local' && !result.remoteUrl) {
    const provider = getProvider(result.mode, result.config);
    const { remoteUrl } = await setupRemoteForProvider(provider, tuckDir);

    if (remoteUrl) {
      configuredRemoteUrl = remoteUrl;
      // The shared helper already wired up `origin`; persist the config so the
      // remote selection survives across runs.
      updatedConfig.remote = {
        ...updatedConfig.remote,
      };
      await saveConfig(updatedConfig, tuckDir);
      clearConfigCache();
    }
  }

  console.log();
  // Final message must mirror reality. For a remote-requiring provider, only
  // claim success if a remote URL was genuinely configured; otherwise warn with
  // an actionable next step instead of a silent false "Remote configured".
  if (result.mode !== 'local' && !configuredRemoteUrl) {
    prompts.log.warning(
      `Provider set to ${describeProviderConfig(result.config)}, but no remote was configured — ` +
        'run `tuck config remote` again or add one manually'
    );
  } else {
    prompts.log.success(`Remote configured: ${describeProviderConfig(result.config)}`);
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
      .option('--json', 'Emit JSON envelope to stdout')
      .action(async (key: string, options: ConfigGetOptions) => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigGet(key, options);
      })
  )
  .addCommand(
    new Command('set')
      .description('Set a config value')
      .argument('<key>', 'Config key')
      .argument('<value>', 'Value to set (JSON or string)')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(async (key: string, value: string, options: ConfigSetOptions) => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigSet(key, value, options);
      })
  )
  .addCommand(
    new Command('list')
      .description('List all config')
      .option('--json', 'Emit JSON envelope to stdout')
      .action(async (options: ConfigListOptions) => {
        const tuckDir = getTuckDir();
        try {
          await loadManifest(tuckDir);
        } catch {
          throw new NotInitializedError();
        }
        await runConfigList(options);
      })
  )
  .addCommand(
    new Command('edit').description('Open config in editor').action(async () => {
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
    new Command('reset').description('Reset to defaults').action(async () => {
      const tuckDir = getTuckDir();
      try {
        await loadManifest(tuckDir);
      } catch {
        throw new NotInitializedError();
      }
      await runConfigReset();
    })
  )
  .addCommand(
    new Command('remote').description('Configure remote provider').action(async () => {
      const tuckDir = getTuckDir();
      try {
        await loadManifest(tuckDir);
      } catch {
        throw new NotInitializedError();
      }
      await runConfigRemote();
    })
  );
