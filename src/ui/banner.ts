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
