import { readFile } from 'fs/promises';
import { basename } from 'path';
import { expandPath, pathExists } from './paths.js';

/**
 * Markers that indicate content should be preserved during merge
 * Includes both Unix shell (#) and PowerShell (<# #>) comment styles
 */
const PRESERVE_MARKERS = [
  // Unix shell style comments
  '# local',
  '# LOCAL',
  '# machine-specific',
  '# MACHINE-SPECIFIC',
  '# machine specific',
  '# do not sync',
  '# DO NOT SYNC',
  '# keep',
  '# KEEP',
  '# private',
  '# PRIVATE',
  '# tuck:preserve',
  '# tuck:keep',
  '# tuck:local',
  // PowerShell block comment style
  '<# local #>',
  '<# LOCAL #>',
  '<# tuck:preserve #>',
  '<# tuck:keep #>',
  '<# tuck:local #>',
];

/**
 * Shell file patterns that are known to be shell configuration
 * Includes both Unix shells and Windows PowerShell
 */
const SHELL_FILE_PATTERNS = [
  // Unix shells
  '.zshrc',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zprofile',
  '.zshenv',
  '.bash_aliases',
  '.aliases',
  '.functions',
  'config.fish',  // Fish shell
  // Windows PowerShell
  'Microsoft.PowerShell_profile.ps1',
  'profile.ps1',
];

/**
 * PowerShell file extensions for special handling
 */
const POWERSHELL_EXTENSIONS = ['.ps1', '.psm1', '.psd1'];

export interface MergeBlock {
  type: 'preserved' | 'incoming' | 'local';
  content: string;
  marker?: string;
  lineStart: number;
  lineEnd: number;
}

export interface MergeResult {
  content: string;
  preservedBlocks: number;
  incomingBlocks: number;
  conflicts: MergeConflict[];
}

export interface MergeConflict {
  type: 'duplicate_export' | 'duplicate_alias' | 'duplicate_function';
  name: string;
  localLine: number;
  incomingLine: number;
}

export interface ParsedExport {
  name: string;
  value: string;
  line: number;
  fullLine: string;
}

export interface ParsedAlias {
  name: string;
  value: string;
  line: number;
  fullLine: string;
}

export interface ParsedFunction {
  name: string;
  content: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * Check if a file is a shell configuration file
 */
export const isShellFile = (filePath: string): boolean => {
  const fileName = basename(filePath);
  return SHELL_FILE_PATTERNS.some(
    (pattern) => fileName === pattern || fileName.endsWith(pattern)
  );
};

/**
 * Check if a file is a PowerShell script
 */
export const isPowerShellFile = (filePath: string): boolean => {
  const fileName = basename(filePath).toLowerCase();
  return POWERSHELL_EXTENSIONS.some((ext) => fileName.endsWith(ext));
};

/**
 * Parse export statements from shell content
 * Handles: export FOO=bar, export FOO="bar", FOO=bar
 */
export const parseExports = (content: string): ParsedExport[] => {
  const exports: ParsedExport[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (line.startsWith('#') || !line) continue;

    // Match export statements
    const exportMatch = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (exportMatch) {
      exports.push({
        name: exportMatch[1],
        value: exportMatch[2],
        line: i + 1,
        fullLine: lines[i],
      });
    }
  }

  return exports;
};

/**
 * Parse alias definitions from shell content
 * Handles: alias foo='bar', alias foo="bar"
 */
export const parseAliases = (content: string): ParsedAlias[] => {
  const aliases: ParsedAlias[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (line.startsWith('#') || !line) continue;

    // Match alias statements
    const aliasMatch = line.match(/^alias\s+([a-zA-Z_][a-zA-Z0-9_-]*)=(['"]?)(.+?)\2\s*$/);
    if (aliasMatch) {
      aliases.push({
        name: aliasMatch[1],
        value: aliasMatch[3],
        line: i + 1,
        fullLine: lines[i],
      });
    }
  }

  return aliases;
};

/**
 * Find blocks that should be preserved during merge
 * A preserved block starts with a preserve marker and ends at:
 * - The next non-indented non-comment line
 * - The end of file
 * - Another preserve marker
 */
export const findPreservedBlocks = (content: string): MergeBlock[] => {
  const blocks: MergeBlock[] = [];
  const lines = content.split('\n');
  let currentBlock: MergeBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Check if this line has a preserve marker
    const marker = PRESERVE_MARKERS.find((m) => trimmedLine.includes(m));

    if (marker) {
      // Save previous block if exists
      if (currentBlock) {
        currentBlock.lineEnd = i;
        currentBlock.content = lines.slice(currentBlock.lineStart - 1, i).join('\n');
        blocks.push(currentBlock);
      }

      // Start new preserved block
      currentBlock = {
        type: 'preserved',
        content: '',
        marker,
        lineStart: i + 1,
        lineEnd: i + 1,
      };
    } else if (currentBlock) {
      // Check if we should end the current block
      // End if: empty line followed by non-indented content, or end of file
      const isEndOfBlock =
        (trimmedLine === '' && i + 1 < lines.length && !lines[i + 1].startsWith(' ') && !lines[i + 1].startsWith('\t') && lines[i + 1].trim() !== '' && !lines[i + 1].trim().startsWith('#')) ||
        i === lines.length - 1;

      if (isEndOfBlock) {
        currentBlock.lineEnd = i + 1;
        currentBlock.content = lines.slice(currentBlock.lineStart - 1, i + 1).join('\n');
        blocks.push(currentBlock);
        currentBlock = null;
      }
    }
  }

  // Handle block that extends to end of file
  if (currentBlock) {
    currentBlock.lineEnd = lines.length;
    currentBlock.content = lines.slice(currentBlock.lineStart - 1).join('\n');
    blocks.push(currentBlock);
  }

  return blocks;
};

/**
 * Extract PATH modifications from content
 */
export const extractPathModifications = (content: string): string[] => {
  const paths: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    // Match PATH exports
    if (trimmed.includes('PATH') && (trimmed.includes('export') || trimmed.includes('='))) {
      paths.push(line);
    }
  }

  return paths;
};

/**
 * Smart merge of shell configuration files
 * Preserves local customizations while applying incoming changes
 */
export const smartMerge = async (
  localPath: string,
  incomingContent: string
): Promise<MergeResult> => {
  const expandedPath = expandPath(localPath);

  // If local file doesn't exist, just return incoming content
  if (!(await pathExists(expandedPath))) {
    return {
      content: incomingContent,
      preservedBlocks: 0,
      incomingBlocks: 1,
      conflicts: [],
    };
  }

  const localContent = await readFile(expandedPath, 'utf-8');

  // Find blocks to preserve from local content
  const preservedBlocks = findPreservedBlocks(localContent);

  // Parse exports and aliases from both files
  const localExports = parseExports(localContent);
  const incomingExports = parseExports(incomingContent);
  const localAliases = parseAliases(localContent);
  const incomingAliases = parseAliases(incomingContent);

  // Find conflicts
  const conflicts: MergeConflict[] = [];

  // Check for duplicate exports
  for (const local of localExports) {
    const duplicate = incomingExports.find((e) => e.name === local.name);
    if (duplicate && local.value !== duplicate.value) {
      conflicts.push({
        type: 'duplicate_export',
        name: local.name,
        localLine: local.line,
        incomingLine: duplicate.line,
      });
    }
  }

  // Check for duplicate aliases
  for (const local of localAliases) {
    const duplicate = incomingAliases.find((a) => a.name === local.name);
    if (duplicate && local.value !== duplicate.value) {
      conflicts.push({
        type: 'duplicate_alias',
        name: local.name,
        localLine: local.line,
        incomingLine: duplicate.line,
      });
    }
  }

  // Build merged content
  let mergedContent = incomingContent;

  // Append preserved blocks at the end
  if (preservedBlocks.length > 0) {
    mergedContent += '\n\n';
    mergedContent += '# ============================================\n';
    mergedContent += '# LOCAL CUSTOMIZATIONS (preserved by tuck)\n';
    mergedContent += '# ============================================\n\n';

    for (const block of preservedBlocks) {
      mergedContent += block.content + '\n\n';
    }
  }

  return {
    content: mergedContent.trim() + '\n',
    preservedBlocks: preservedBlocks.length,
    incomingBlocks: 1,
    conflicts,
  };
};

/**
 * Generate a diff-like preview of what will change
 */
export const generateMergePreview = async (
  localPath: string,
  incomingContent: string
): Promise<string> => {
  const expandedPath = expandPath(localPath);

  if (!(await pathExists(expandedPath))) {
    return `New file will be created:\n${incomingContent.slice(0, 500)}${incomingContent.length > 500 ? '...' : ''}`;
  }

  const localContent = await readFile(expandedPath, 'utf-8');
  const preservedBlocks = findPreservedBlocks(localContent);
  const localExports = parseExports(localContent);
  const incomingExports = parseExports(incomingContent);

  const lines: string[] = [];

  lines.push('=== Merge Preview ===');
  lines.push('');

  // Show preserved blocks
  if (preservedBlocks.length > 0) {
    lines.push(`📌 ${preservedBlocks.length} block(s) will be preserved:`);
    for (const block of preservedBlocks) {
      lines.push(`   - Lines ${block.lineStart}-${block.lineEnd} (${block.marker})`);
    }
    lines.push('');
  }

  // Show export changes
  const newExports = incomingExports.filter(
    (e) => !localExports.find((l) => l.name === e.name)
  );
  const changedExports = incomingExports.filter((e) => {
    const local = localExports.find((l) => l.name === e.name);
    return local && local.value !== e.value;
  });

  if (newExports.length > 0) {
    lines.push(`➕ ${newExports.length} new export(s):`);
    for (const exp of newExports.slice(0, 5)) {
      lines.push(`   + ${exp.name}=${exp.value.slice(0, 50)}`);
    }
    if (newExports.length > 5) {
      lines.push(`   ... and ${newExports.length - 5} more`);
    }
    lines.push('');
  }

  if (changedExports.length > 0) {
    lines.push(`🔄 ${changedExports.length} export(s) will be updated:`);
    for (const exp of changedExports.slice(0, 5)) {
      const local = localExports.find((l) => l.name === exp.name);
      lines.push(`   ~ ${exp.name}: "${local?.value.slice(0, 20)}..." → "${exp.value.slice(0, 20)}..."`);
    }
    if (changedExports.length > 5) {
      lines.push(`   ... and ${changedExports.length - 5} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
};

/**
 * Check if content has any preserve markers
 */
export const hasPreserveMarkers = (content: string): boolean => {
  return PRESERVE_MARKERS.some((marker) => content.includes(marker));
};

/**
 * Add a preserve marker to content
 */
export const addPreserveMarker = (content: string, marker = '# tuck:preserve'): string => {
  return `${marker}\n${content}`;
};
