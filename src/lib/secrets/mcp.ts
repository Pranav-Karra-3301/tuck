/**
 * MCP (Model Context Protocol) secrets extraction for tuck.
 *
 * MCP clients (Claude Desktop, Claude Code, Cursor, VS Code, …) store server
 * definitions in JSON config files. A large share of MCP servers recommend
 * pasting API keys and tokens directly into the `env` (or `headers`) block of
 * these files as plaintext — which then get committed to dotfiles repos and
 * synced to the cloud with no rotation story.
 *
 * This module finds those inline credentials and rewrites them into tuck
 * placeholders (`{{NAME}}`) — or client-native `${env:NAME}` references — while
 * capturing the real values so they can be stored in the configured secret
 * backend and re-injected on `tuck apply`.
 *
 * The rewrite is done by targeted, length-descending replacement of the exact
 * JSON-encoded value token so surrounding formatting (and any data tuck does
 * not touch) is preserved byte-for-byte. Parsing is strict JSON: MCP config
 * files are machine-managed and must not contain comments.
 */

import { homedir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { expandPath, collapsePath, pathExists } from '../paths.js';
import { IS_WINDOWS, IS_MACOS } from '../platform.js';
import { McpConfigError } from '../../errors.js';
import { normalizeSecretName } from './store.js';
import { scanContent } from './scanner.js';

// ============================================================================
// Target paths
// ============================================================================

export type McpScope = 'global' | 'project';

export interface McpTargetPath {
  /** Collapsed (`~`-relative when possible) path for display. */
  path: string;
  /** Absolute, expanded path used for filesystem access. */
  expandedPath: string;
  /** Human-readable label for the client this file belongs to. */
  label: string;
  scope: McpScope;
}

/**
 * Location of the Claude Desktop config, which is OS-specific.
 */
const claudeDesktopConfigPath = (): string => {
  if (IS_MACOS) {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  // Linux / other
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
};

/**
 * Build the full list of known MCP config target paths.
 *
 * Global (per-user) locations are absolute; project-scoped locations are
 * resolved relative to `cwd` (defaults to `process.cwd()`).
 */
export const getMcpTargetPaths = (cwd: string = process.cwd()): McpTargetPath[] => {
  const candidates: Array<{ raw: string; label: string; scope: McpScope }> = [
    // Global / per-user
    { raw: claudeDesktopConfigPath(), label: 'Claude Desktop', scope: 'global' },
    { raw: join(homedir(), '.claude.json'), label: 'Claude Code', scope: 'global' },
    { raw: join(homedir(), '.cursor', 'mcp.json'), label: 'Cursor (global)', scope: 'global' },
    { raw: join(homedir(), '.mcp.json'), label: 'MCP (home)', scope: 'global' },
    { raw: join(homedir(), '.config', 'mcp', 'mcp.json'), label: 'MCP (XDG)', scope: 'global' },
    // Project-scoped (relative to cwd)
    { raw: join(cwd, '.mcp.json'), label: 'MCP (project)', scope: 'project' },
    { raw: join(cwd, 'mcp.json'), label: 'MCP (project)', scope: 'project' },
    { raw: join(cwd, '.cursor', 'mcp.json'), label: 'Cursor (project)', scope: 'project' },
    { raw: join(cwd, '.vscode', 'mcp.json'), label: 'VS Code (project)', scope: 'project' },
  ];

  // De-duplicate by expanded path (e.g. home === cwd) while preserving order.
  const seen = new Set<string>();
  const out: McpTargetPath[] = [];
  for (const candidate of candidates) {
    const expandedPath = expandPath(candidate.raw);
    if (seen.has(expandedPath)) continue;
    seen.add(expandedPath);
    out.push({
      path: collapsePath(expandedPath),
      expandedPath,
      label: candidate.label,
      scope: candidate.scope,
    });
  }
  return out;
};

/**
 * Return only the MCP target paths that currently exist on disk.
 */
export const discoverMcpConfigFiles = async (
  cwd: string = process.cwd()
): Promise<McpTargetPath[]> => {
  const targets = getMcpTargetPaths(cwd);
  const existing: McpTargetPath[] = [];
  for (const target of targets) {
    if (await pathExists(target.expandedPath)) {
      existing.push(target);
    }
  }
  return existing;
};

// ============================================================================
// Credential heuristics
// ============================================================================

/**
 * Env var / header keys that strongly signal a credential value.
 */
const CREDENTIAL_KEY_REGEX =
  /(?:^|_|-)(?:token|secret|password|passwd|pwd|credential|apikey|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth|bearer|pat)(?:$|_|-)|_key$|^key$|^authorization$|^cookie$|^x-api-key$/i;

/**
 * Minimum length for a key-signalled value to be treated as a real secret.
 * Avoids extracting flags like `"true"` or `"1"` that happen to sit under a
 * credential-ish key.
 */
const MIN_KEY_SIGNAL_VALUE_LENGTH = 8;

/**
 * Non-credential literal values that must never be extracted even when the key
 * looks credential-like.
 */
const NON_SECRET_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'none', '0', '1']);

/**
 * Whether a config key looks like it holds a credential.
 */
export const isCredentialKey = (key: string): boolean => CREDENTIAL_KEY_REGEX.test(key);

/**
 * Whether a value is already an externalized reference (env var, tuck
 * placeholder, 1Password secret reference, shell substitution, or an
 * angle-bracket `<PLACEHOLDER>`) — such values are left untouched.
 */
export const isReferenceValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (NON_SECRET_LITERALS.has(trimmed.toLowerCase())) return true;
  return (
    trimmed.startsWith('${') ||
    trimmed.startsWith('{{') ||
    trimmed.startsWith('op://') ||
    trimmed.startsWith('$(') ||
    /^<[^>]+>$/.test(trimmed) ||
    // Bare $ENV_VAR reference
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)
  );
};

/**
 * Decide whether a given key/value pair should be extracted as a secret.
 *
 * A value is extracted when it is not already a reference AND either:
 *   - the key looks credential-like and the value is long enough, or
 *   - the value itself matches one of the built-in secret scanner patterns.
 */
export const shouldExtractValue = (key: string, value: string): boolean => {
  if (typeof value !== 'string') return false;
  if (isReferenceValue(value)) return false;

  if (isCredentialKey(key) && value.trim().length >= MIN_KEY_SIGNAL_VALUE_LENGTH) {
    return true;
  }

  // Fall back to content-based detection (catches secrets under generic keys).
  return scanContent(`${key} = ${value}`).length > 0;
};

// ============================================================================
// Reference formatting
// ============================================================================

export type McpReferenceFormat = 'placeholder' | 'env';

/**
 * Build the reference string that replaces an inline value.
 *
 * - `placeholder` → `{{NAME}}` (tuck-native; resolved by `tuck apply`).
 * - `env`         → `${env:NAME}` (client-native env reference; the value must
 *                   be present in the environment when the client launches).
 */
export const buildReference = (name: string, format: McpReferenceFormat): string => {
  return format === 'env' ? `\${env:${name}}` : `{{${name}}}`;
};

// ============================================================================
// Extraction
// ============================================================================

export interface McpExtraction {
  /** MCP server name the credential belongs to. */
  server: string;
  /** Where the server map lives: `mcpServers`, `servers`, or a project path. */
  scope: string;
  /** Which block the value came from. */
  field: 'env' | 'headers';
  /** Original key inside the block. */
  key: string;
  /** Generated tuck placeholder / secret name. */
  placeholder: string;
  /** The real credential value (never logged/serialized to JSON output). */
  value: string;
  /** The reference string written back into the file. */
  reference: string;
}

export interface McpExtractionResult {
  original: string;
  /**
   * Content with every *successfully located* credential replaced by its
   * reference. Values that could not be found verbatim in the source are left
   * untouched (see `skipped`).
   */
  rewritten: string;
  /**
   * Credentials that were located in the source and rewritten. These are the
   * only extractions safe to store/map — the plaintext is genuinely gone from
   * `rewritten`.
   */
  extractions: McpExtraction[];
  /**
   * Credentials that parsed out of the config but whose JSON-encoded value
   * could NOT be found verbatim in the source (e.g. the source used escape
   * variants like `\/` or `\uXXXX` that re-encode differently). These were NOT
   * rewritten and MUST NOT be stored/mapped or reported as extracted — doing so
   * would leave the plaintext secret in the file while claiming success.
   */
  skipped: McpExtraction[];
  /** Number of MCP server definitions inspected. */
  serverCount: number;
  changed: boolean;
}

/** A record of string keys → string values (env / headers block). */
const stringRecordSchema = z.record(z.string(), z.string());

/** A single MCP server definition (only the fields we care about). */
const serverSchema = z
  .object({
    env: stringRecordSchema.optional(),
    headers: stringRecordSchema.optional(),
  })
  .passthrough();

const serverMapSchema = z.record(z.string(), z.unknown());

export interface ExtractMcpOptions {
  format?: McpReferenceFormat;
  /** Placeholder names already in use (kept unique across files). */
  existingPlaceholders?: Set<string>;
}

interface PendingExtraction {
  server: string;
  scope: string;
  field: 'env' | 'headers';
  key: string;
  value: string;
}

/**
 * Recursively collect every MCP server map (`mcpServers` / `servers`) in the
 * parsed config, including project-nested maps in `~/.claude.json`.
 */
const collectServerMaps = (
  node: unknown,
  scopePath: string,
  out: Array<{ scope: string; servers: Record<string, unknown> }>
): void => {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;

  const obj = node as Record<string, unknown>;
  for (const mapKey of ['mcpServers', 'servers'] as const) {
    const parsed = serverMapSchema.safeParse(obj[mapKey]);
    if (parsed.success) {
      const scope = scopePath ? `${scopePath}.${mapKey}` : mapKey;
      out.push({ scope, servers: parsed.data });
    }
  }

  // Recurse into nested objects (e.g. `projects.<path>`), but do not recurse
  // into the server maps themselves — their children are server definitions,
  // not more maps.
  for (const [key, child] of Object.entries(obj)) {
    if (key === 'mcpServers' || key === 'servers') continue;
    collectServerMaps(child, scopePath ? `${scopePath}.${key}` : key, out);
  }
};

/**
 * Parse an MCP config and identify the inline credentials to extract.
 *
 * @throws {McpConfigError} when the content is not valid JSON.
 */
export const analyzeMcpConfig = (
  content: string,
  file = '<mcp config>'
): { pending: PendingExtraction[]; serverCount: number } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new McpConfigError(file, error instanceof Error ? error.message : String(error));
  }

  const maps: Array<{ scope: string; servers: Record<string, unknown> }> = [];
  collectServerMaps(parsed, '', maps);

  const pending: PendingExtraction[] = [];
  let serverCount = 0;

  for (const { scope, servers } of maps) {
    for (const [serverName, rawServer] of Object.entries(servers)) {
      const server = serverSchema.safeParse(rawServer);
      if (!server.success) continue;
      serverCount++;

      for (const field of ['env', 'headers'] as const) {
        const block = server.data[field];
        if (!block) continue;
        for (const [key, value] of Object.entries(block)) {
          if (shouldExtractValue(key, value)) {
            pending.push({ server: serverName, scope, field, key, value });
          }
        }
      }
    }
  }

  return { pending, serverCount };
};

/**
 * Extract inline MCP credentials from `content`, returning the rewritten
 * content plus the list of extractions (value → placeholder).
 *
 * Same value → same placeholder (deduplicated). Rewriting replaces the exact
 * JSON-encoded value token, longest-first, so partial/nested values cannot
 * corrupt one another and untouched data is preserved verbatim.
 *
 * @throws {McpConfigError} when the content is not valid JSON.
 */
export const extractMcpSecrets = (
  content: string,
  options: ExtractMcpOptions = {},
  file = '<mcp config>'
): McpExtractionResult => {
  const format: McpReferenceFormat = options.format ?? 'placeholder';
  const { pending, serverCount } = analyzeMcpConfig(content, file);

  const usedPlaceholders = new Set(options.existingPlaceholders ?? []);
  const valueToPlaceholder = new Map<string, string>();
  const candidates: McpExtraction[] = [];

  for (const item of pending) {
    let placeholder = valueToPlaceholder.get(item.value);
    if (!placeholder) {
      const base = normalizeSecretName(item.key);
      placeholder = base;
      let counter = 1;
      while (usedPlaceholders.has(placeholder)) {
        placeholder = `${base}_${counter}`;
        counter++;
      }
      usedPlaceholders.add(placeholder);
      valueToPlaceholder.set(item.value, placeholder);
    }

    candidates.push({
      server: item.server,
      scope: item.scope,
      field: item.field,
      key: item.key,
      placeholder,
      value: item.value,
      reference: buildReference(placeholder, format),
    });
  }

  // Rewrite: replace each unique JSON-encoded value token with its reference.
  // Longest value first (temp markers) so a value that is a substring of
  // another does not get partially rewritten.
  //
  // CRITICAL: a value parsed out of the JSON does not necessarily appear
  // byte-for-byte in the source — JSON permits multiple valid encodings of the
  // same string (`\/` vs `/`, `é` vs `é`, etc.). `JSON.stringify(value)`
  // re-encodes canonically, so the search token can differ from the source and
  // the replacement silently no-ops. If we then stored/mapped/reported such a
  // value, the plaintext secret would remain in the file while we claim to have
  // removed it. So we only treat a value as extracted when its token is actually
  // located; unlocated values are reported as `skipped`.
  let rewritten = content;
  const locatedValues = new Set<string>();
  const uniqueValues = [...valueToPlaceholder.keys()].sort((a, b) => b.length - a.length);
  for (const value of uniqueValues) {
    const placeholder = valueToPlaceholder.get(value)!;
    const valueToken = JSON.stringify(value); // e.g. "\"ghp_xxx\""
    if (!rewritten.includes(valueToken)) {
      // Token not present verbatim — leave the source untouched for this value.
      continue;
    }
    locatedValues.add(value);
    const referenceToken = JSON.stringify(buildReference(placeholder, format));
    const marker = `__TUCK_MCP_${randomBytes(16).toString('hex')}__`;
    // valueToken is a literal JSON-encoded string (JSON.stringify above), never
    // a regex — so a literal global replace is correct and needs no escaping.
    rewritten = rewritten.replaceAll(valueToken, marker);
    rewritten = rewritten.split(marker).join(referenceToken);
  }

  const extractions = candidates.filter((ex) => locatedValues.has(ex.value));
  const skipped = candidates.filter((ex) => !locatedValues.has(ex.value));

  return {
    original: content,
    rewritten,
    extractions,
    skipped,
    serverCount,
    changed: rewritten !== content,
  };
};
