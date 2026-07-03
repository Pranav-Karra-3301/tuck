/**
 * Redactor helper + file-level tests.
 *
 * Complements redactor-ordering / redactor-roundtrip (which pin the
 * longest-first substring-safety and $-escape guarantees). Here we cover the
 * placeholder parsing/detection helpers and the in-place file operations
 * (redactFile, restoreFile, restoreFiles, previewRestoration) including the
 * "only write when something changed", "missing file", and unresolved-tracking
 * edge cases. Exercised over memfs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { TEST_TUCK_DIR } from '../setup.js';
import {
  formatPlaceholder,
  parsePlaceholder,
  redactContent,
  restoreContent,
  redactFile,
  restoreFile,
  restoreFiles,
  previewRestoration,
  findPlaceholders,
  findUnresolvedPlaceholders,
  hasPlaceholders,
  countPlaceholders,
} from '../../src/lib/secrets/redactor.js';
import { setSecret } from '../../src/lib/secrets/store.js';
import type { SecretMatch } from '../../src/lib/secrets/scanner.js';

const mkMatch = (value: string, placeholder: string, line = 1): SecretMatch => ({
  patternId: 'test',
  patternName: 'test',
  severity: 'high',
  value,
  redactedValue: '***',
  line,
  column: 0,
  context: '',
  placeholder,
});

describe('placeholder helpers', () => {
  it('formatPlaceholder / parsePlaceholder round-trip', () => {
    expect(formatPlaceholder('API_KEY')).toBe('{{API_KEY}}');
    expect(parsePlaceholder('{{API_KEY}}')).toBe('API_KEY');
  });

  it('parsePlaceholder returns null for malformed or lowercase placeholders', () => {
    expect(parsePlaceholder('{{lower}}')).toBeNull();
    expect(parsePlaceholder('API_KEY')).toBeNull();
    expect(parsePlaceholder('{{ SPACED }}')).toBeNull();
  });

  it('findPlaceholders returns unique names in first-seen order', () => {
    const content = 'a={{A}}\nb={{B}}\na2={{A}}\n';
    expect(findPlaceholders(content)).toEqual(['A', 'B']);
  });

  it('findUnresolvedPlaceholders returns only names missing from available secrets', () => {
    const content = 'x={{A}} y={{B}} z={{C}}';
    expect(findUnresolvedPlaceholders(content, { A: '1', C: '3' })).toEqual(['B']);
  });

  it('hasPlaceholders and countPlaceholders reflect the content', () => {
    expect(hasPlaceholders('no placeholders here')).toBe(false);
    expect(hasPlaceholders('has {{ONE}}')).toBe(true);
    expect(countPlaceholders('{{A}} {{B}} {{A}}')).toBe(3);
    expect(countPlaceholders('none')).toBe(0);
  });

  it('hasPlaceholders is stable across repeated calls (no shared lastIndex leak)', () => {
    const content = 'x={{TOKEN}}';
    expect(hasPlaceholders(content)).toBe(true);
    expect(hasPlaceholders(content)).toBe(true);
  });
});

describe('redactContent / restoreContent edge cases', () => {
  it('redacts every occurrence of a repeated secret value', () => {
    const content = 'a=sekret\nb=sekret\n';
    const { redactedContent } = redactContent(
      content,
      [mkMatch('sekret', 'TOK', 1)],
      new Map([['sekret', 'TOK']])
    );
    expect(redactedContent).toBe('a={{TOK}}\nb={{TOK}}\n');
    expect(redactedContent).not.toContain('sekret');
  });

  it('restoreContent reports unresolved placeholders once each and restores the rest', () => {
    const content = 'x={{A}} y={{MISSING}} z={{MISSING}}';
    const result = restoreContent(content, { A: 'aval' });
    expect(result.restored).toBe(1);
    expect(result.restoredContent).toBe('x=aval y={{MISSING}} z={{MISSING}}');
    // MISSING is only listed once despite two occurrences.
    expect(result.unresolved).toEqual(['MISSING']);
  });

  it('restoreContent with an empty secret store leaves content untouched', () => {
    const content = 'x={{A}}';
    const result = restoreContent(content, {});
    expect(result.restored).toBe(0);
    expect(result.restoredContent).toBe(content);
    expect(result.unresolved).toEqual(['A']);
  });
});

describe('file-level redact/restore over memfs', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });
  afterEach(() => {
    vol.reset();
  });

  it('redactFile rewrites the file in place and returns the replacement report', async () => {
    vol.writeFileSync('/test-home/.myrc', 'token=sekret\n');
    const result = await redactFile(
      '~/.myrc',
      [mkMatch('sekret', 'TOKEN', 1)],
      new Map([['sekret', 'TOKEN']])
    );
    expect(result.redactedContent).toBe('token={{TOKEN}}\n');
    expect(vol.readFileSync('/test-home/.myrc', 'utf-8')).toBe('token={{TOKEN}}\n');
  });

  it('restoreFile fills placeholders from the store and reports the count', async () => {
    await setSecret(TEST_TUCK_DIR, 'TOKEN', 'sekret');
    vol.writeFileSync('/test-home/.myrc', 'token={{TOKEN}}\n');

    const res = await restoreFile('~/.myrc', TEST_TUCK_DIR);
    expect(res.restored).toBe(1);
    expect(vol.readFileSync('/test-home/.myrc', 'utf-8')).toBe('token=sekret\n');
  });

  it('restoreFile does not rewrite when there is nothing to restore', async () => {
    vol.writeFileSync('/test-home/.myrc', 'token={{UNKNOWN}}\n');
    const res = await restoreFile('~/.myrc', TEST_TUCK_DIR);
    expect(res.restored).toBe(0);
    expect(res.unresolved).toEqual(['UNKNOWN']);
    // Left verbatim.
    expect(vol.readFileSync('/test-home/.myrc', 'utf-8')).toBe('token={{UNKNOWN}}\n');
  });

  it('restoreFile returns zeros for a missing file', async () => {
    const res = await restoreFile('~/.does-not-exist', TEST_TUCK_DIR);
    expect(res).toEqual({ restored: 0, unresolved: [] });
  });

  it('restoreFiles aggregates across files and dedups unresolved placeholders', async () => {
    await setSecret(TEST_TUCK_DIR, 'A', 'aval');
    vol.writeFileSync('/test-home/.one', 'x={{A}} m={{MISSING}}\n');
    vol.writeFileSync('/test-home/.two', 'y={{A}} n={{MISSING}}\n');

    const res = await restoreFiles(['~/.one', '~/.two'], TEST_TUCK_DIR);
    expect(res.totalRestored).toBe(2);
    expect(res.filesModified).toBe(2);
    expect(res.allUnresolved).toEqual(['MISSING']);
  });

  it('previewRestoration reports what would restore without writing', async () => {
    await setSecret(TEST_TUCK_DIR, 'A', 'aval');
    vol.writeFileSync('/test-home/.rc', 'x={{A}} y={{B}}\n');

    const preview = await previewRestoration('~/.rc', TEST_TUCK_DIR);
    expect(preview.wouldRestore).toBe(1);
    expect(preview.unresolved).toEqual(['B']);
    expect(preview.placeholders.sort()).toEqual(['A', 'B']);
    // File is untouched (still has the placeholder).
    expect(vol.readFileSync('/test-home/.rc', 'utf-8')).toContain('{{A}}');
  });

  it('previewRestoration returns zeros for a missing file', async () => {
    const preview = await previewRestoration('~/.gone', TEST_TUCK_DIR);
    expect(preview).toEqual({ wouldRestore: 0, unresolved: [], placeholders: [] });
  });
});
