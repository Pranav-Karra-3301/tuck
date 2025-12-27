import chalk from 'chalk';

export interface TableColumn {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  format?: (value: unknown) => string;
}

export interface TableOptions {
  columns: TableColumn[];
  border?: boolean;
  padding?: number;
}

const padString = (str: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string => {
  const visibleLength = str.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, width - visibleLength);

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + str;
    case 'center':
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
    default:
      return str + ' '.repeat(padding);
  }
};

export const createTable = (
  data: Record<string, unknown>[],
  options: TableOptions
): string => {
  const { columns, border = false, padding = 2 } = options;

  // Calculate column widths
  const widths = columns.map((col) => {
    const headerWidth = col.header.length;
    const maxDataWidth = data.reduce((max, row) => {
      const value = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '');
      const visibleLength = value.replace(/\x1b\[[0-9;]*m/g, '').length;
      return Math.max(max, visibleLength);
    }, 0);
    return col.width || Math.max(headerWidth, maxDataWidth);
  });

  const lines: string[] = [];
  const pad = ' '.repeat(padding);

  // Header
  const headerRow = columns
    .map((col, i) => chalk.bold(padString(col.header, widths[i], col.align)))
    .join(pad);

  if (border) {
    const borderLine = widths.map((w) => '─'.repeat(w)).join(pad);
    lines.push(chalk.dim(borderLine));
    lines.push(headerRow);
    lines.push(chalk.dim(borderLine));
  } else {
    lines.push(headerRow);
    lines.push(chalk.dim(widths.map((w) => '─'.repeat(w)).join(pad)));
  }

  // Data rows
  data.forEach((row) => {
    const dataRow = columns
      .map((col, i) => {
        const value = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '');
        return padString(value, widths[i], col.align);
      })
      .join(pad);
    lines.push(dataRow);
  });

  if (border) {
    lines.push(chalk.dim(widths.map((w) => '─'.repeat(w)).join(pad)));
  }

  return lines.join('\n');
};

export const printTable = (data: Record<string, unknown>[], options: TableOptions): void => {
  console.log(createTable(data, options));
};
