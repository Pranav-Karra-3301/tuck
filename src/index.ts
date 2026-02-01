import { Command } from 'commander';
import chalk from 'chalk';
import {
  initCommand,
  addCommand,
  removeCommand,
  syncCommand,
  pushCommand,
  pullCommand,
  restoreCommand,
  statusCommand,
  listCommand,
  diffCommand,
  configCommand,
  applyCommand,
  undoCommand,
  scanCommand,
  secretsCommand,
  encryptionCommand,
} from './commands/index.js';
import { handleError } from './errors.js';
import { VERSION, DESCRIPTION } from './constants.js';
import { checkForUpdates } from './lib/updater.js';
import { customHelp, miniBanner } from './ui/banner.js';
import { getTuckDir, pathExists } from './lib/paths.js';
import { loadManifest } from './lib/manifest.js';
import { getStatus } from './lib/git.js';

const program = new Command();

program
  .name('tuck')
  .description(DESCRIPTION)
  .version(VERSION, '-v, --version', 'Display version number')
  .configureOutput({
    outputError: (str, write) => write(chalk.red(str)),
  })
  .addHelpText('before', customHelp(VERSION))
  .helpOption('-h, --help', 'Display this help message')
  .showHelpAfterError(false);

// Register commands
program.addCommand(initCommand);
program.addCommand(addCommand);
program.addCommand(removeCommand);
program.addCommand(syncCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);
program.addCommand(restoreCommand);
program.addCommand(statusCommand);
program.addCommand(listCommand);
program.addCommand(diffCommand);
program.addCommand(configCommand);
program.addCommand(applyCommand);
program.addCommand(undoCommand);
program.addCommand(scanCommand);
program.addCommand(secretsCommand);
program.addCommand(encryptionCommand);

// Default action when no command is provided
const runDefaultAction = async (): Promise<void> => {
  const tuckDir = getTuckDir();

  // Check if tuck is initialized
  if (!(await pathExists(tuckDir))) {
    miniBanner();
    console.log(chalk.bold('Get started with tuck:\n'));
    console.log(chalk.cyan('  tuck init') + chalk.dim('   - Set up tuck and create a GitHub repo'));
    console.log(chalk.cyan('  tuck scan') + chalk.dim('   - Find dotfiles to track'));
    console.log();
    console.log(chalk.dim('On a new machine:'));
    console.log(chalk.cyan('  tuck apply <username>') + chalk.dim(' - Apply your dotfiles'));
    console.log();
    return;
  }

  // Load manifest to check status
  try {
    const manifest = await loadManifest(tuckDir);
    const trackedCount = Object.keys(manifest.files).length;
    const gitStatus = await getStatus(tuckDir);

    miniBanner();
    console.log(chalk.bold('Status:\n'));

    // Show tracked files count
    console.log(`  Tracked files: ${chalk.cyan(trackedCount.toString())}`);

    // Show git status
    const pendingChanges = gitStatus.modified.length + gitStatus.staged.length;
    if (pendingChanges > 0) {
      console.log(`  Pending changes: ${chalk.yellow(pendingChanges.toString())}`);
    } else {
      console.log(`  Pending changes: ${chalk.dim('none')}`);
    }

    // Show remote status
    if (gitStatus.ahead > 0) {
      console.log(`  Commits to push: ${chalk.yellow(gitStatus.ahead.toString())}`);
    }

    console.log();

    // Show what to do next
    console.log(chalk.bold('Next steps:\n'));

    if (trackedCount === 0) {
      console.log(chalk.cyan('  tuck scan') + chalk.dim('  - Find dotfiles to track'));
      console.log(chalk.cyan('  tuck add <file>') + chalk.dim(' - Track a specific file'));
    } else if (pendingChanges > 0) {
      console.log(chalk.cyan('  tuck sync') + chalk.dim('  - Commit and push your changes'));
      console.log(chalk.cyan('  tuck diff') + chalk.dim('  - Preview what changed'));
    } else if (gitStatus.ahead > 0) {
      console.log(chalk.cyan('  tuck push') + chalk.dim('  - Push commits to GitHub'));
    } else {
      console.log(chalk.dim('  All synced! Your dotfiles are up to date.'));
      console.log();
      console.log(chalk.cyan('  tuck scan') + chalk.dim('  - Find more dotfiles to track'));
      console.log(chalk.cyan('  tuck list') + chalk.dim('  - See tracked files'));
    }

    console.log();
  } catch {
    // Manifest load failed, treat as not initialized
    miniBanner();
    console.log(chalk.yellow('Tuck directory exists but may be corrupted.'));
    console.log(chalk.dim('Run `tuck init` to reinitialize.'));
    console.log();
  }
};

// Check if no command provided
const hasCommand = process.argv
  .slice(2)
  .some((arg) => !arg.startsWith('-') && arg !== '--help' && arg !== '-h');

// Global error handling
process.on('uncaughtException', handleError);
process.on('unhandledRejection', (reason) => {
  handleError(reason instanceof Error ? reason : new Error(String(reason)));
});

// Check if this is a help or version request (skip update check for these)
const isHelpOrVersion =
  process.argv.includes('--help') ||
  process.argv.includes('-h') ||
  process.argv.includes('--version') ||
  process.argv.includes('-v');

// Main execution
const main = async (): Promise<void> => {
  // Check for updates (skipped for help/version)
  if (!isHelpOrVersion) {
    await checkForUpdates();
  }

  // Parse and execute
  if (!hasCommand && !isHelpOrVersion) {
    await runDefaultAction();
  } else {
    await program.parseAsync(process.argv);
  }
};

main().catch(handleError);
