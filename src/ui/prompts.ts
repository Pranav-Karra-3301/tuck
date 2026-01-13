/**
 * Prompts wrapper for tuck CLI
 * Uses @clack/prompts for consistent, beautiful interactive prompts
 */

import * as p from '@clack/prompts';
import { colors as c } from './theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Prompts Object
// ─────────────────────────────────────────────────────────────────────────────

export const prompts = {
  /**
   * Display command intro header
   */
  intro: (title: string): void => {
    p.intro(c.brandBg(` ${title} `));
  },

  /**
   * Display command outro/success message
   */
  outro: (message: string): void => {
    p.outro(c.success(message));
  },

  /**
   * Confirm dialog (yes/no)
   */
  confirm: async (message: string, initial = false): Promise<boolean> => {
    const result = await p.confirm({ message, initialValue: initial });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as boolean;
  },

  /**
   * Single select from options
   */
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

  /**
   * Multi-select from options
   */
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
      hint: opt.hint ?? '',
    }));

    const result = await p.multiselect({
      message,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: mappedOptions as any,
      required: config?.required ?? false,
      initialValues: config?.initialValues,
    });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as T[];
  },

  /**
   * Text input
   */
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

  /**
   * Password input (hidden)
   */
  password: async (message: string): Promise<string> => {
    const result = await p.password({ message });
    if (p.isCancel(result)) {
      prompts.cancel();
    }
    return result as string;
  },

  /**
   * Create a spinner for async operations
   */
  spinner: () => p.spinner(),

  /**
   * Display a note/info box
   */
  note: (message: string, title?: string): void => {
    p.note(message, title);
  },

  /**
   * Cancel operation and exit
   */
  cancel: (message = 'Operation cancelled'): never => {
    p.cancel(message);
    process.exit(0);
  },

  /**
   * Logging helpers
   */
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

  /**
   * Group multiple prompts
   */
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

// ─────────────────────────────────────────────────────────────────────────────
// Utility Exports
// ─────────────────────────────────────────────────────────────────────────────

export const isCancel = p.isCancel;
