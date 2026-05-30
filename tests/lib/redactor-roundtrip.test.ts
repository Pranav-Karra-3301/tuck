/**
 * Redactor round-trip regression test.
 *
 * When a SHORT detected secret ("abc123") is a literal substring of a LONGER
 * one ("abc123DEF456"), redacting shortest-first would rewrite the longer
 * secret's prefix and leave its tail in cleartext (and orphan the longer
 * placeholder). `redactContent` already sorts length-descending to avoid this.
 * This test locks in a byte-for-byte redact -> restore round-trip so that
 * ordering guarantee cannot silently regress.
 */
import { describe, it, expect } from 'vitest';
import { redactContent, restoreContent } from '../../src/lib/secrets/redactor.js';
import type { SecretMatch } from '../../src/lib/secrets/scanner.js';

const makeMatch = (value: string, placeholder: string): SecretMatch => ({
  patternId: 'test',
  patternName: 'test',
  severity: 'high',
  value,
  redactedValue: '***',
  line: 1,
  column: 0,
  context: '',
  placeholder,
});

describe('redactor round-trip with overlapping (short ⊂ long) secrets', () => {
  it('reconstructs the original string byte-for-byte', () => {
    const SHORT = 'abc123';
    const LONG = 'abc123DEF456';
    const original = `KEY=${LONG}`;

    // Both values are detected; SHORT is a literal prefix of LONG.
    const matches: SecretMatch[] = [
      makeMatch(SHORT, 'SHORT_SECRET'),
      makeMatch(LONG, 'LONG_SECRET'),
    ];

    const placeholderMap = new Map<string, string>([
      [SHORT, 'SHORT_SECRET'],
      [LONG, 'LONG_SECRET'],
    ]);

    const { redactedContent } = redactContent(original, matches, placeholderMap);

    // Longest-first means the whole LONG value is replaced as one unit; the
    // cleartext tail "DEF456" must NOT survive in the redacted output.
    expect(redactedContent).toBe('KEY={{LONG_SECRET}}');
    expect(redactedContent).not.toContain('DEF456');
    expect(redactedContent).not.toContain(SHORT);

    // Restore from the secrets store (placeholder name -> value).
    const secrets: Record<string, string> = {
      SHORT_SECRET: SHORT,
      LONG_SECRET: LONG,
    };
    const { restoredContent, restored } = restoreContent(redactedContent, secrets);

    expect(restored).toBe(1);
    expect(restoredContent).toBe(original);
  });
});
