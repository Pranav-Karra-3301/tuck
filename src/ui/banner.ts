import chalk from 'chalk';
import boxen from 'boxen';

export const banner = (): void => {
  const art = `
 ████████╗██╗   ██╗ ██████╗██╗  ██╗
 ╚══██╔══╝██║   ██║██╔════╝██║ ██╔╝
    ██║   ██║   ██║██║     █████╔╝
    ██║   ██║   ██║██║     ██╔═██╗
    ██║   ╚██████╔╝╚██████╗██║  ██╗
    ╚═╝    ╚═════╝  ╚═════╝╚═╝  ╚═╝`;

  console.log(chalk.cyan(art));
  console.log(chalk.dim('    Modern Dotfiles Manager\n'));
};

export const miniBanner = (): void => {
  console.log(
    boxen(chalk.cyan.bold('tuck') + chalk.dim(' · Modern Dotfiles Manager'), {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderStyle: 'round',
      borderColor: 'cyan',
    })
  );
  console.log();
};

export const customHelp = (version: string): string => {
  const title = boxen(chalk.cyan.bold('tuck') + chalk.dim(` v${version}`), {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: 'cyan',
  });

  const quickStart = `
${chalk.bold.cyan('Quick Start:')}
  ${chalk.cyan('tuck init')}          Set up tuck (auto-creates GitHub repo)
  ${chalk.cyan('tuck add <file>')}    Start tracking a dotfile
  ${chalk.cyan('tuck sync')}          Commit your changes
  ${chalk.cyan('tuck push')}          Push to GitHub

${chalk.bold.cyan('On a New Machine:')}
  ${chalk.cyan('tuck apply <user>')}  Apply dotfiles from GitHub
`;

  const commands = `
${chalk.bold.cyan('Commands:')}
  ${chalk.cyan('Getting Started')}
    init              Initialize tuck repository
    apply <source>    Apply dotfiles from a repository

  ${chalk.cyan('Managing Files')}
    add <paths...>    Track dotfile(s)
    remove <paths...> Stop tracking dotfile(s)
    list              List all tracked files
    status            Show repository status

  ${chalk.cyan('Syncing')}
    sync              Sync changes to repository
    push              Push to remote
    pull              Pull from remote
    diff              Show pending changes

  ${chalk.cyan('Restoring')}
    restore           Restore dotfiles to system
    undo              Undo last apply (Time Machine backup)

  ${chalk.cyan('Configuration')}
    config            Manage tuck configuration
`;

  const footer = `
${chalk.dim('Run')} ${chalk.cyan('tuck <command> --help')} ${chalk.dim('for detailed command info')}
${chalk.dim('Documentation:')} ${chalk.cyan('https://github.com/Pranav-Karra-3301/tuck')}
`;

  return `${title}\n${quickStart}${commands}${footer}`;
};

export const welcomeBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
      title,
      titleAlignment: 'center',
    })
  );
};

export const successBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'green',
      title: title || 'Success',
      titleAlignment: 'center',
    })
  );
};

export const errorBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'red',
      title: title || 'Error',
      titleAlignment: 'center',
    })
  );
};

export const infoBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'blue',
      title,
      titleAlignment: 'center',
    })
  );
};

export const nextSteps = (steps: string[]): void => {
  const content = steps.map((step, i) => `${chalk.cyan(`${i + 1}.`)} ${step}`).join('\n');

  console.log(
    boxen(content, {
      padding: 1,
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'cyan',
      title: 'Next Steps',
      titleAlignment: 'left',
    })
  );
};
