import * as p from '@clack/prompts';
import chalk from 'chalk';

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export const prompts = {
  intro: (title: string): void => {
    p.intro(chalk.bgCyan(chalk.black(` ${title} `)));
  },

  outro: (message: string): void => {
    p.outro(chalk.green(message));
  },

  confirm: async (message: string, initial = false): Promise<boolean> => {
    const result = await p.confirm({ message, initialValue: initial });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as boolean;
  },

  select: async <T>(message: string, options: SelectOption<T>[]): Promise<T> => {
    const result = await p.select({
      message,
      options: options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
    });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as T;
  },

  multiselect: async <T>(
    message: string,
    options: SelectOption<T>[],
    config?: {
      required?: boolean;
      initialValues?: T[];
    }
  ): Promise<T[]> => {
    const mappedOptions = options.map((opt) => ({
      value: opt.value,
      label: opt.label,
      ...(opt.hint && { hint: opt.hint }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await p.multiselect({
      message,
      options: mappedOptions as any,
      required: config?.required ?? false,
      initialValues: config?.initialValues,
    });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as T[];
  },

  text: async (
    message: string,
    options?: {
      placeholder?: string;
      defaultValue?: string;
      validate?: (value: string) => string | undefined;
    }
  ): Promise<string> => {
    const result = await p.text({
      message,
      placeholder: options?.placeholder,
      defaultValue: options?.defaultValue,
      validate: options?.validate,
    });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as string;
  },

  password: async (message: string): Promise<string> => {
    const result = await p.password({ message });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as string;
  },

  spinner: () => p.spinner(),

  note: (message: string, title?: string): void => {
    p.note(message, title);
  },

  cancel: (message = 'Operation cancelled'): never => {
    p.cancel(message);
    process.exit(0);
  },

  log: {
    info: (message: string): void => {
      p.log.info(message);
    },
    success: (message: string): void => {
      p.log.success(message);
    },
    warning: (message: string): void => {
      p.log.warning(message);
    },
    error: (message: string): void => {
      p.log.error(message);
    },
    step: (message: string): void => {
      p.log.step(message);
    },
    message: (message: string): void => {
      p.log.message(message);
    },
  },

  group: async <T>(
    steps: Record<string, () => Promise<T | symbol>>,
    options?: { onCancel?: () => void }
  ): Promise<Record<string, T>> => {
    const results = await p.group(steps, {
      onCancel: () => {
        if (options?.onCancel) {
          options.onCancel();
        } else {
          prompts.cancel();
        }
      },
    });
    return results as Record<string, T>;
  },
};

export const isCancel = p.isCancel;
