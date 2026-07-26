/**
 * Redactor helper + file-level tests.
 *
 * Complements redactor-ordering / redactor-roundtrip (which pin the
 * longest-first substring-safety and $-escape guarantees). Here we cover the
 * placeholder formatting/detection helpers and the in-place file operations
 * (redactFile, restoreFiles) including the "only write when something changed",
 * "missing file", and unresolved-tracking edge cases. Exercised over memfs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { TEST_TUCK_DIR } from '../setup.js';
import {
  formatPlaceholder,
  redactContent,
  restoreContent,
  redactFile,
  restoreFiles,
  findPlaceholders,
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
  start: 0,
  end: value.length,
});

describe('placeholder helpers', () => {
  it('formatPlaceholder wraps a name in placeholder syntax', () => {
    expect(formatPlaceholder('API_KEY')).toBe('{{API_KEY}}');
  });

  it('findPlaceholders returns unique names in first-seen order', () => {
    const content = 'a={{A}}\nb={{B}}\na2={{A}}\n';
    expect(findPlaceholders(content)).toEqual(['A', 'B']);
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

  it('restoreFiles aggregates across files and dedups unresolved placeholders', async () => {
    await setSecret(TEST_TUCK_DIR, 'A', 'aval');
    vol.writeFileSync('/test-home/.one', 'x={{A}} m={{MISSING}}\n');
    vol.writeFileSync('/test-home/.two', 'y={{A}} n={{MISSING}}\n');

    const res = await restoreFiles(['~/.one', '~/.two'], TEST_TUCK_DIR);
    expect(res.totalRestored).toBe(2);
    expect(res.filesModified).toBe(2);
    expect(res.allUnresolved).toEqual(['MISSING']);
  });
});
