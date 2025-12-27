import chalk from 'chalk';

export interface Logger {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warning: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
  step: (current: number, total: number, msg: string) => void;
  file: (action: 'add' | 'modify' | 'delete' | 'sync' | 'merge', path: string) => void;
  tree: (items: TreeItem[]) => void;
  blank: () => void;
  dim: (msg: string) => void;
  heading: (msg: string) => void;
}

export interface TreeItem {
  name: string;
  isLast: boolean;
  indent?: number;
}

export const logger: Logger = {
  info: (msg: string) => {
    console.log(chalk.blue('ℹ'), msg);
  },

  success: (msg: string) => {
    console.log(chalk.green('✓'), msg);
  },

  warning: (msg: string) => {
    console.log(chalk.yellow('⚠'), msg);
  },

  error: (msg: string) => {
    console.log(chalk.red('✗'), msg);
  },

  debug: (msg: string) => {
    if (process.env.DEBUG) {
      console.log(chalk.gray('⚙'), chalk.gray(msg));
    }
  },

  step: (current: number, total: number, msg: string) => {
    console.log(chalk.dim(`[${current}/${total}]`), msg);
  },

  file: (action: 'add' | 'modify' | 'delete' | 'sync' | 'merge', path: string) => {
    const icons = {
      add: chalk.green('+'),
      modify: chalk.yellow('~'),
      delete: chalk.red('-'),
      sync: chalk.blue('↔'),
      merge: chalk.magenta('⊕'),
    };
    console.log(`  ${icons[action]} ${path}`);
  },

  tree: (items: TreeItem[]) => {
    items.forEach(({ name, isLast, indent = 0 }) => {
      const indentation = '  '.repeat(indent);
      const prefix = isLast ? '└── ' : '├── ';
      console.log(chalk.dim(indentation + prefix) + name);
    });
  },

  blank: () => {
    console.log();
  },

  dim: (msg: string) => {
    console.log(chalk.dim(msg));
  },

  heading: (msg: string) => {
    console.log(chalk.bold.cyan(msg));
  },
};

export const formatPath = (path: string): string => {
  return chalk.cyan(path);
};

export const formatCategory = (category: string, icon?: string): string => {
  return icon ? `${icon} ${chalk.bold(category)}` : chalk.bold(category);
};

export const formatCount = (count: number, singular: string, plural?: string): string => {
  const word = count === 1 ? singular : (plural || `${singular}s`);
  return `${chalk.bold(count.toString())} ${word}`;
};

export const formatStatus = (status: string): string => {
  switch (status) {
    case 'modified':
      return chalk.yellow('modified');
    case 'added':
      return chalk.green('added');
    case 'deleted':
      return chalk.red('deleted');
    case 'untracked':
      return chalk.gray('untracked');
    default:
      return status;
  }
};
