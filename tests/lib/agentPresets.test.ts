/**
 * Agent preset registry unit tests (IDEAS 1.2 / 1.8).
 *
 * Cover the two invariants that make presets safe:
 *   - allow and exclude sets are disjoint (no sensitive file is ever in an
 *     allowlist), and
 *   - resolveAgentPreset only surfaces files that exist, filed under the right
 *     category, while separately reporting the sensitive files it skipped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_HOME } from '../setup.js';
import {
  listAgentPresets,
  getAgentPreset,
  agentPresetIds,
  isPathExcluded,
  resolveAgentPreset,
  listInstructionTargets,
  getInstructionTarget,
  DEFAULT_TRANSLATION_AGENTS,
} from '../../src/lib/agentPresets.js';

describe('agent preset registry', () => {
  it('ships the five documented agent presets', () => {
    expect(agentPresetIds().sort()).toEqual(
      ['claude-code', 'codex', 'copilot', 'cursor', 'gemini'].sort()
    );
  });

  it('every preset validates against the schema (non-empty fields)', () => {
    for (const p of listAgentPresets()) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.allow.length).toBeGreaterThan(0);
      expect(p.configDirs.length).toBeGreaterThan(0);
    }
  });

  it('allow and exclude sets are disjoint for every preset', () => {
    // The core safety invariant: a sensitive file must never appear in an
    // allowlist, and no allowlisted entry may live inside an excluded dir.
    for (const p of listAgentPresets()) {
      for (const entry of p.allow) {
        expect(isPathExcluded(entry.path, p.exclude)).toBe(false);
      }
    }
  });

  it('claude-code excludes credentials, history, sessions, and projects', () => {
    const p = getAgentPreset('claude-code');
    expect(p).toBeDefined();
    const excl = p!.exclude;
    expect(excl).toContain('~/.claude/settings.local.json');
    expect(excl).toContain('~/.claude/.credentials.json');
    expect(excl).toContain('~/.claude/sessions/');
    expect(excl).toContain('~/.claude/projects/');
    // And the allowlist carries the safe, documented surface.
    const allowPaths = p!.allow.map((a) => a.path);
    expect(allowPaths).toContain('~/.claude/CLAUDE.md');
    expect(allowPaths).toContain('~/.claude/commands/');
    expect(allowPaths).toContain('~/.claude/skills/');
  });
});

describe('isPathExcluded', () => {
  it('matches exact paths', () => {
    expect(isPathExcluded('~/.claude/settings.local.json', ['~/.claude/settings.local.json'])).toBe(
      true
    );
  });

  it('matches files inside an excluded directory', () => {
    expect(isPathExcluded('~/.claude/sessions/abc.json', ['~/.claude/sessions/'])).toBe(true);
  });

  it('matches a bare (slash-free) exclude by basename', () => {
    expect(isPathExcluded('~/nested/credentials', ['credentials'])).toBe(true);
  });

  it('does not match unrelated siblings', () => {
    expect(isPathExcluded('~/.claude/settings.json', ['~/.claude/settings.local.json'])).toBe(
      false
    );
  });
});

describe('resolveAgentPreset', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_HOME, { recursive: true });
  });

  it('throws a helpful error for an unknown preset', async () => {
    await expect(resolveAgentPreset('nope')).rejects.toMatchObject({
      code: 'UNKNOWN_AGENT_PRESET',
    });
  });

  it('tracks only the allowlisted files that exist on disk', async () => {
    // Stage a safe file, a safe dir, and a sensitive credential file.
    vol.mkdirSync(join(TEST_HOME, '.claude', 'commands'), { recursive: true });
    vol.writeFileSync(join(TEST_HOME, '.claude', 'CLAUDE.md'), '# rules');
    vol.writeFileSync(join(TEST_HOME, '.claude', 'commands', 'x.md'), 'cmd');
    vol.writeFileSync(join(TEST_HOME, '.claude', '.credentials.json'), '{"token":"x"}');
    vol.writeFileSync(join(TEST_HOME, '.claude', 'settings.local.json'), '{}');

    const res = await resolveAgentPreset('claude-code');

    const tracked = res.tracked.map((t) => t.collapsed).sort();
    expect(tracked).toEqual(['~/.claude/CLAUDE.md', '~/.claude/commands'].sort());

    // The directory entry is flagged as such.
    const commands = res.tracked.find((t) => t.collapsed === '~/.claude/commands');
    expect(commands?.isDir).toBe(true);
    expect(commands?.category).toBe('agents');

    // Sensitive files that exist are reported as skipped, never tracked.
    expect(res.skippedSensitive).toContain('~/.claude/.credentials.json');
    expect(res.skippedSensitive).toContain('~/.claude/settings.local.json');
    expect(tracked).not.toContain('~/.claude/.credentials.json');

    // settings.json was never created → reported missing, not tracked.
    expect(res.missing).toContain('~/.claude/settings.json');
  });

  it('returns nothing to track when no agent config exists', async () => {
    const res = await resolveAgentPreset('codex');
    expect(res.tracked).toEqual([]);
    expect(res.skippedSensitive).toEqual([]);
  });
});

describe('instruction targets (translation)', () => {
  it('defaults to claude-code and codex', () => {
    expect(DEFAULT_TRANSLATION_AGENTS).toEqual(['claude-code', 'codex']);
  });

  it('maps agents to their canonical instruction files', () => {
    expect(getInstructionTarget('claude-code')?.path).toBe('~/.claude/CLAUDE.md');
    expect(getInstructionTarget('codex')?.path).toBe('~/.codex/AGENTS.md');
    expect(getInstructionTarget('gemini')?.path).toBe('~/.gemini/GEMINI.md');
  });

  it('lists all known targets', () => {
    const agents = listInstructionTargets().map((t) => t.agent);
    expect(agents).toContain('claude-code');
    expect(agents).toContain('codex');
  });
});
