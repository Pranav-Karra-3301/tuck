/**
 * Redactor ordering unit test.
 *
 * When one detected secret value is a literal substring of another (e.g. a
 * short key that prefixes a longer one), the shorter value must NOT be replaced
 * first — doing so rewrites the longer secret's prefix and leaves its remaining
 * characters in cleartext in the committed file (and orphans the longer
 * placeholder). Replacing longest-first prevents the leak.
 */
import { describe, it, expect } from 'vitest';
import { redactContent } from '../../src/lib/secrets/redactor.js';
import type { SecretMatch } from '../../src/lib/secrets/scanner.js';

const mkMatch = (value: string, placeholder: string, line: number): SecretMatch => ({
  patternId: 'test',
  patternName: 'test',
  severity: 'high',
  value,
  redactedValue: '***',
  line,
  column: 2,
  context: '',
  placeholder,
});

describe('redactContent ordering', () => {
  it('does not leak the remainder of a longer secret that contains a shorter one', () => {
    const content = 'A=abc123\nB=abc123DEF456\n';
    // Shorter value listed FIRST (line order) — the bug trigger.
    const matches = [mkMatch('abc123', 'SHORT', 1), mkMatch('abc123DEF456', 'LONG', 2)];
    const map = new Map([
      ['abc123', 'SHORT'],
      ['abc123DEF456', 'LONG'],
    ]);

    const result = redactContent(content, matches, map);

    expect(result.redactedContent).not.toContain('DEF456'); // remainder must not leak
    expect(result.redactedContent).toContain('{{SHORT}}');
    expect(result.redactedContent).toContain('{{LONG}}'); // longer placeholder applied
  });
});
