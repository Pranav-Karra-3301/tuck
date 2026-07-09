/**
 * Agent config presets — the curated allowlists that power
 * `tuck add --preset <agent>` (IDEAS 1.2) and the canonical instruction-file
 * targets that power `tuck preset translate` (IDEAS 1.8).
 *
 * Each preset encodes two things the community keeps hand-rolling:
 *   1. `allow` — the exact files/dirs under an agent's home config that are
 *      SAFE to version-control (instructions, settings, commands, skills…).
 *   2. `exclude` — the local/credential/history/session files that must NEVER
 *      be tracked (settings.local.json, credentials, sessions/, projects/…).
 *
 * The two sets are disjoint by construction (asserted in tests). `exclude`
 * additionally serves as a runtime guard and as user-facing reassurance: after
 * a preset add we report which sensitive files were found and deliberately
 * skipped. tuck's secret scanner remains the final backstop on every tracked
 * file, so even an over-broad allowlist entry can never smuggle a credential
 * into the repo silently.
 */
import { basename } from 'path';
import { z } from 'zod';
import { IS_MACOS, IS_WINDOWS } from './platform.js';
import { expandPath, collapsePath, pathExists, isDirectory } from './paths.js';

/** A single safe-to-track entry. Directory entries end with a trailing `/`. */
export interface AgentPresetEntry {
  /** Home-relative path (always `~/…`, forward slashes). Dirs end with `/`. */
  path: string;
  /** Manifest category the tracked entry is filed under. */
  category: string;
}

/** A curated allowlist/excludelist for one AI agent's home configuration. */
export interface AgentPreset {
  /** Stable id used on the CLI, e.g. `claude-code`. */
  id: string;
  /** Human-facing label, e.g. `Claude Code`. */
  label: string;
  /** One-line description for `--help` / listings. */
  description: string;
  /** Config roots this agent uses (for messaging). */
  configDirs: string[];
  /** Safe-to-track allowlist. */
  allow: AgentPresetEntry[];
  /**
   * Hard-exclude paths (home-relative). These are never tracked and are
   * surfaced to the user as "found but intentionally skipped".
   */
  exclude: string[];
}

const entrySchema = z.object({
  path: z.string().min(1),
  category: z.string().min(1),
});

const presetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  configDirs: z.array(z.string().min(1)).min(1),
  allow: z.array(entrySchema).min(1),
  exclude: z.array(z.string().min(1)),
});

/** Agent config category — one logical grouping for all agent files. */
const AGENTS = 'agents';

/**
 * Cursor stores its user settings under a platform-specific Application Support
 * path. Always emit `~/`-prefixed, forward-slash paths so {@link expandPath}
 * resolves them identically on every platform.
 */
const cursorUserDir = (): string => {
  if (IS_MACOS) return '~/Library/Application Support/Cursor/User';
  if (IS_WINDOWS) return '~/AppData/Roaming/Cursor/User';
  return '~/.config/Cursor/User';
};

/** GitHub Copilot CLI config root (per platform). */
const copilotDir = (): string => {
  if (IS_WINDOWS) return '~/AppData/Local/github-copilot';
  return '~/.config/github-copilot';
};

const buildPresets = (): AgentPreset[] => {
  const cursor = cursorUserDir();
  const copilot = copilotDir();

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      description: 'CLAUDE.md, settings.json, commands/, skills/, agents/, hooks/, rules/',
      configDirs: ['~/.claude'],
      allow: [
        { path: '~/.claude/CLAUDE.md', category: AGENTS },
        { path: '~/.claude/settings.json', category: AGENTS },
        { path: '~/.claude/commands/', category: AGENTS },
        { path: '~/.claude/skills/', category: AGENTS },
        { path: '~/.claude/agents/', category: AGENTS },
        { path: '~/.claude/hooks/', category: AGENTS },
        { path: '~/.claude/rules/', category: AGENTS },
        { path: '~/.claude/output-styles/', category: AGENTS },
      ],
      exclude: [
        '~/.claude/settings.local.json',
        '~/.claude/CLAUDE.local.md',
        '~/.claude/.credentials.json',
        '~/.claude/credentials',
        '~/.claude/history.jsonl',
        '~/.claude/history',
        '~/.claude/sessions/',
        '~/.claude/projects/',
        '~/.claude/todos/',
        '~/.claude/statsig/',
        '~/.claude/shell-snapshots/',
        '~/.claude/ide/',
        '~/.claude.json',
      ],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      description: 'User settings, keybindings, snippets/, and ~/.cursor rules',
      configDirs: [cursor, '~/.cursor'],
      allow: [
        { path: `${cursor}/settings.json`, category: AGENTS },
        { path: `${cursor}/keybindings.json`, category: AGENTS },
        { path: `${cursor}/snippets/`, category: AGENTS },
        { path: '~/.cursor/rules/', category: AGENTS },
      ],
      exclude: [
        `${cursor}/globalStorage/`,
        `${cursor}/workspaceStorage/`,
        `${cursor}/History/`,
        '~/.cursor/mcp.json',
        '~/.cursor/logs/',
        '~/.cursor/sessions/',
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      description: 'AGENTS.md, config.toml, prompts/',
      configDirs: ['~/.codex'],
      allow: [
        { path: '~/.codex/AGENTS.md', category: AGENTS },
        { path: '~/.codex/config.toml', category: AGENTS },
        { path: '~/.codex/prompts/', category: AGENTS },
      ],
      exclude: [
        '~/.codex/auth.json',
        '~/.codex/.credentials.json',
        '~/.codex/sessions/',
        '~/.codex/history.jsonl',
        '~/.codex/log/',
      ],
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      description: 'GEMINI.md, settings.json, commands/',
      configDirs: ['~/.gemini'],
      allow: [
        { path: '~/.gemini/GEMINI.md', category: AGENTS },
        { path: '~/.gemini/settings.json', category: AGENTS },
        { path: '~/.gemini/commands/', category: AGENTS },
      ],
      exclude: [
        '~/.gemini/oauth_creds.json',
        '~/.gemini/google_accounts.json',
        '~/.gemini/access_tokens.json',
        '~/.gemini/tmp/',
        '~/.gemini/sessions/',
      ],
    },
    {
      id: 'copilot',
      label: 'GitHub Copilot',
      description: 'GitHub Copilot CLI config (non-credential)',
      configDirs: [copilot],
      allow: [{ path: `${copilot}/config.json`, category: AGENTS }],
      exclude: [`${copilot}/hosts.json`, `${copilot}/apps.json`, `${copilot}/versions.json`],
    },
  ];
};

// Validate the registry at module load so a typo (bad category, empty path)
// fails fast in tests/CI rather than at a user's terminal.
const REGISTRY: AgentPreset[] = buildPresets().map((p) => presetSchema.parse(p));

/** All agent presets, in stable display order. */
export const listAgentPresets = (): AgentPreset[] => REGISTRY;

/** Valid preset ids (for help text and error suggestions). */
export const agentPresetIds = (): string[] => REGISTRY.map((p) => p.id);

/** Look up a preset by id, or `undefined` if unknown. */
export const getAgentPreset = (id: string): AgentPreset | undefined =>
  REGISTRY.find((p) => p.id === id);

const stripTrailingSlash = (p: string): string => p.replace(/\/+$/, '');

/**
 * Whether a home-relative `path` is covered by any `exclude` entry. Covered
 * means: exact match, the path lives inside an excluded directory, or a bare
 * (slash-free) exclude name matches the path's basename. Pure function — used
 * both as a defense-in-depth runtime filter and as the disjointness invariant
 * asserted in tests.
 */
export const isPathExcluded = (path: string, excludes: string[]): boolean => {
  const p = stripTrailingSlash(path);
  return excludes.some((raw) => {
    const e = stripTrailingSlash(raw);
    if (p === e) return true;
    if (p.startsWith(`${e}/`)) return true;
    if (!e.includes('/') && basename(p) === e) return true;
    return false;
  });
};

/** The outcome of resolving a preset against the current filesystem. */
export interface AgentPresetResolution {
  preset: AgentPreset;
  /** Allowlisted entries that exist on disk and are safe to track. */
  tracked: Array<{
    /** Absolute, expanded path. */
    path: string;
    /** `~/…` collapsed path for display and as a track candidate. */
    collapsed: string;
    category: string;
    isDir: boolean;
  }>;
  /** Allowlisted entries not present on disk (informational). */
  missing: string[];
  /** Excluded paths that DO exist on disk (found → intentionally skipped). */
  skippedSensitive: string[];
}

/**
 * Resolve a preset id against the real filesystem: enumerate the allowlist,
 * keep the entries that exist and are not excluded, and separately report the
 * sensitive files that were found and skipped. Throws when `id` is unknown.
 */
export const resolveAgentPreset = async (id: string): Promise<AgentPresetResolution> => {
  const preset = getAgentPreset(id);
  if (!preset) {
    const { TuckError } = await import('../errors.js');
    throw new TuckError(`Unknown agent preset: ${id}`, 'UNKNOWN_AGENT_PRESET', [
      `Valid presets: ${agentPresetIds().join(', ')}`,
    ]);
  }

  const tracked: AgentPresetResolution['tracked'] = [];
  const missing: string[] = [];

  for (const entry of preset.allow) {
    // Defense in depth: never track an allow entry that overlaps an exclude,
    // even if a future registry edit introduces such an overlap.
    if (isPathExcluded(entry.path, preset.exclude)) continue;
    const abs = expandPath(stripTrailingSlash(entry.path));
    if (await pathExists(abs)) {
      tracked.push({
        path: abs,
        collapsed: collapsePath(abs),
        category: entry.category,
        isDir: await isDirectory(abs),
      });
    } else {
      missing.push(collapsePath(abs));
    }
  }

  const skippedSensitive: string[] = [];
  for (const ex of preset.exclude) {
    const abs = expandPath(stripTrailingSlash(ex));
    if (await pathExists(abs)) skippedSensitive.push(collapsePath(abs));
  }

  return { preset, tracked, missing, skippedSensitive };
};

/**
 * Canonical instruction-file targets for cross-agent translation (IDEAS 1.8):
 * one canonical instructions file materialized to each agent's global
 * instruction path.
 */
export interface InstructionTarget {
  agent: string;
  label: string;
  /** Home-relative (`~/…`) instruction-file path. */
  path: string;
}

const INSTRUCTION_TARGETS: InstructionTarget[] = [
  { agent: 'claude-code', label: 'Claude Code', path: '~/.claude/CLAUDE.md' },
  { agent: 'codex', label: 'Codex', path: '~/.codex/AGENTS.md' },
  { agent: 'gemini', label: 'Gemini CLI', path: '~/.gemini/GEMINI.md' },
];

/** Agents translated by default (spec v1: Claude Code + Codex). */
export const DEFAULT_TRANSLATION_AGENTS = ['claude-code', 'codex'];

/** All known instruction targets, in stable order. */
export const listInstructionTargets = (): InstructionTarget[] => INSTRUCTION_TARGETS;

/** Look up an instruction target by agent id, or `undefined` if unknown. */
export const getInstructionTarget = (agent: string): InstructionTarget | undefined =>
  INSTRUCTION_TARGETS.find((t) => t.agent === agent);
