/**
 * Regression tests for evalCondition literal syntax (batch r2-merge-template).
 *
 * evalCondition only understood `VAR == "quoted"`, so the unquoted forms the
 * project's own docs use (`os=darwin`, `os == darwin`) fell through to a bare
 * lookup, evaluated false, and SILENTLY dropped the guarded block. These tests
 * pin the unquoted/single-`=` comparison forms and that a genuinely malformed
 * condition surfaces a warning instead of vanishing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderTemplate } from '../../src/lib/template.js';

describe('template conditions — unquoted comparison literals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should keep the block when using the documented `os=darwin` single-equals form', () => {
    const text = ['# tuck:if os=darwin', 'alias ls="ls -G"', '# tuck:endif', 'always'].join('\n');
    const out = renderTemplate(text, { os: 'darwin' });
    expect(out).toContain('alias ls="ls -G"');
    expect(out).toContain('always');
  });

  it('should drop the block when the unquoted single-equals literal does not match', () => {
    const text = ['# tuck:if os=darwin', 'alias ls="ls -G"', '# tuck:endif', 'always'].join('\n');
    const out = renderTemplate(text, { os: 'linux' });
    expect(out).not.toContain('alias ls="ls -G"');
    expect(out).toContain('always');
  });

  it('should support unquoted `==` and `!=` comparison forms', () => {
    const kept = renderTemplate('{{#if os == darwin}}MAC{{else}}OTHER{{/if}}', { os: 'darwin' });
    expect(kept).toBe('MAC');

    const neq = renderTemplate('{{#if arch != arm64}}NOTARM{{/if}}', { arch: 'x64' });
    expect(neq).toBe('NOTARM');

    const neqFalse = renderTemplate('{{#if arch != arm64}}NOTARM{{/if}}', { arch: 'arm64' });
    expect(neqFalse).toBe('');
  });

  it('should still support the original quoted comparison form', () => {
    const out = renderTemplate('{{#if os == "darwin"}}MAC{{/if}}', { os: 'darwin' });
    expect(out).toBe('MAC');
  });

  it('should warn on stderr (not silently drop) on a genuinely malformed condition', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // "os is darwin" is neither a comparison nor a valid variable name.
    const out = renderTemplate('{{#if os is darwin}}X{{/if}}Y', { os: 'darwin' });
    expect(out).toBe('Y');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('os is darwin');
  });
});
