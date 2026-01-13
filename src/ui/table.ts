/**
 * Table utilities for tuck CLI
 * Provides formatted table output
 */

import { colors as c } from './theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

const padString = (
  str: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left'
): string => {
  // Strip ANSI codes for length calculation
  // eslint-disable-next-line no-control-regex
  const visibleLength = str.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, width - visibleLength);

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + str;
    case 'center': {
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
    }
    default:
      return str + ' '.repeat(padding);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Table Creation
// ─────────────────────────────────────────────────────────────────────────────

export const createTable = (data: Record<string, unknown>[], options: TableOptions): string => {
  const { columns, border = false, padding = 2 } = options;

  // Calculate column widths
  const widths = columns.map((col) => {
    const headerWidth = col.header.length;
    const maxDataWidth = data.reduce((max, row) => {
      const value = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '');
      // eslint-disable-next-line no-control-regex
      const visibleLength = value.replace(/\x1b\[[0-9;]*m/g, '').length;
      return Math.max(max, visibleLength);
    }, 0);
    return col.width || Math.max(headerWidth, maxDataWidth);
  });

  const lines: string[] = [];
  const pad = ' '.repeat(padding);

  // Header row
  const headerRow = columns
    .map((col, i) => c.bold(padString(col.header, widths[i], col.align)))
    .join(pad);

  // Border line
  const borderLine = c.muted(widths.map((w) => '─'.repeat(w)).join(pad));

  if (border) {
    lines.push(borderLine);
    lines.push(headerRow);
    lines.push(borderLine);
  } else {
    lines.push(headerRow);
    lines.push(borderLine);
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
    lines.push(borderLine);
  }

  return lines.join('\n');
};

export const printTable = (data: Record<string, unknown>[], options: TableOptions): void => {
  console.log(createTable(data, options));
};
