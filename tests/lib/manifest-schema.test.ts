/**
 * Manifest schema — repo-scope fields.
 *
 * Repo-scoped tracking adds optional scope/repoKey/repoRelative. They must be
 * truly optional (legacy entries parse byte-identical — no injected keys) and
 * shape-consistent (a repo entry requires repoKey + a safe repoRelative; a
 * home entry must not carry repo fields).
 */
import { describe, it, expect } from 'vitest';
import { trackedFileSchema } from '../../src/schemas/manifest.schema.js';

const homeEntry = {
  source: '~/.zshrc',
  destination: 'files/shell/zshrc',
  category: 'shell',
  strategy: 'copy' as const,
  added: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z',
  checksum: 'abc',
};

describe('trackedFileSchema repo scope', () => {
  it('parses a legacy (home) entry without injecting any scope keys', () => {
    const parsed = trackedFileSchema.parse(homeEntry);
    expect('scope' in parsed).toBe(false);
    expect('repoKey' in parsed).toBe(false);
    expect('repoRelative' in parsed).toBe(false);
    // Round-trips byte-identical (no scope noise) modulo defaulted bundle.
    expect(JSON.stringify(parsed)).not.toContain('"scope"');
  });

  it('parses a valid repo-scoped entry', () => {
    const parsed = trackedFileSchema.parse({
      ...homeEntry,
      source: 'abc123:.vscode/settings.json',
      destination: 'files/repos/abc123/.vscode/settings.json',
      scope: 'repo',
      repoKey: 'abc123',
      repoRelative: '.vscode/settings.json',
    });
    expect(parsed.scope).toBe('repo');
    expect(parsed.repoKey).toBe('abc123');
  });

  it('rejects a repo entry missing repoKey', () => {
    expect(
      trackedFileSchema.safeParse({ ...homeEntry, scope: 'repo', repoRelative: 'a/b' }).success
    ).toBe(false);
  });

  it('rejects a repo entry missing repoRelative', () => {
    expect(
      trackedFileSchema.safeParse({ ...homeEntry, scope: 'repo', repoKey: 'k' }).success
    ).toBe(false);
  });

  it('rejects a repo entry whose repoRelative traverses out', () => {
    expect(
      trackedFileSchema.safeParse({
        ...homeEntry,
        scope: 'repo',
        repoKey: 'k',
        repoRelative: '../../etc/passwd',
      }).success
    ).toBe(false);
  });

  it('rejects an absolute repoRelative', () => {
    expect(
      trackedFileSchema.safeParse({
        ...homeEntry,
        scope: 'repo',
        repoKey: 'k',
        repoRelative: '/etc/passwd',
      }).success
    ).toBe(false);
  });

  it('rejects a home entry carrying stray repo fields', () => {
    expect(trackedFileSchema.safeParse({ ...homeEntry, repoKey: 'k' }).success).toBe(false);
  });
});

describe('trackedFileSchema jsonKey', () => {
  it('does not inject a jsonKey key into a legacy entry', () => {
    const parsed = trackedFileSchema.parse(homeEntry);
    expect('jsonKey' in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('"jsonKey"');
  });

  it('parses a valid JSON-key entry', () => {
    const parsed = trackedFileSchema.parse({ ...homeEntry, jsonKey: 'mcpServers' });
    expect(parsed.jsonKey).toBe('mcpServers');
  });

  it('rejects an empty jsonKey', () => {
    expect(trackedFileSchema.safeParse({ ...homeEntry, jsonKey: '   ' }).success).toBe(false);
  });

  it('rejects jsonKey combined with template or encrypted', () => {
    expect(
      trackedFileSchema.safeParse({ ...homeEntry, jsonKey: 'a', template: true }).success
    ).toBe(false);
    expect(
      trackedFileSchema.safeParse({ ...homeEntry, jsonKey: 'a', encrypted: true }).success
    ).toBe(false);
  });
});
