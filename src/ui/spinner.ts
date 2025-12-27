import ora, { Ora } from 'ora';
import chalk from 'chalk';

export interface SpinnerInstance {
  start: (text?: string) => void;
  stop: () => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  warn: (text?: string) => void;
  info: (text?: string) => void;
  text: (text: string) => void;
}

export const createSpinner = (initialText?: string): SpinnerInstance => {
  const spinner: Ora = ora({
    text: initialText,
    color: 'cyan',
    spinner: 'dots',
  });

  return {
    start: (text?: string) => {
      if (text) spinner.text = text;
      spinner.start();
    },
    stop: () => {
      spinner.stop();
    },
    succeed: (text?: string) => {
      spinner.succeed(text ? chalk.green(text) : undefined);
    },
    fail: (text?: string) => {
      spinner.fail(text ? chalk.red(text) : undefined);
    },
    warn: (text?: string) => {
      spinner.warn(text ? chalk.yellow(text) : undefined);
    },
    info: (text?: string) => {
      spinner.info(text ? chalk.blue(text) : undefined);
    },
    text: (text: string) => {
      spinner.text = text;
    },
  };
};

export const withSpinner = async <T>(
  text: string,
  fn: () => Promise<T>,
  options?: {
    successText?: string;
    failText?: string;
  }
): Promise<T> => {
  const spinner = createSpinner(text);
  spinner.start();

  try {
    const result = await fn();
    spinner.succeed(options?.successText || text);
    return result;
  } catch (error) {
    spinner.fail(options?.failText || text);
    throw error;
  }
};
