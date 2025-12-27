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
} from './commands/index.js';
import { handleError } from './errors.js';
import { VERSION, DESCRIPTION } from './constants.js';

const program = new Command();

program
  .name('tuck')
  .description(DESCRIPTION)
  .version(VERSION, '-v, --version', 'Display version number')
  .configureOutput({
    outputError: (str, write) => write(chalk.red(str)),
  });

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

// Global error handling
process.on('uncaughtException', handleError);
process.on('unhandledRejection', (reason) => {
  handleError(reason instanceof Error ? reason : new Error(String(reason)));
});

// Parse and execute
program.parseAsync(process.argv).catch(handleError);
