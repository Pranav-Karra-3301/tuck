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
import { vol } from 'memfs';
import { redactContent, restoreContent, restoreFiles } from '../../src/lib/secrets/redactor.js';
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
  start: 0,
  end: value.length,
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

describe('restoreContent with $-bearing secret values', () => {
  it('inserts the secret literally when it contains $ replacement patterns', () => {
    // A plain string-form replaceAll would interpret $&, $$, $`, $<n> in the
    // value as replacement patterns, splicing surrounding content into the
    // credential. The replacer-function form must insert the value verbatim.
    const secrets: Record<string, string> = {
      TOKEN: "pa$&ss$`word$$1",
    };
    const { restoredContent, restored } = restoreContent('export X={{TOKEN}}', secrets);

    expect(restored).toBe(1);
    expect(restoredContent).toBe("export X=pa$&ss$`word$$1");
  });

  it('round-trips a redact -> restore for a password full of $ sequences', () => {
    const SECRET = 'A$$b$&c$`d';
    const original = `PASSWORD=${SECRET}`;

    const { redactedContent } = redactContent(
      original,
      [makeMatch(SECRET, 'DB_PASSWORD')],
      new Map([[SECRET, 'DB_PASSWORD']])
    );
    expect(redactedContent).toBe('PASSWORD={{DB_PASSWORD}}');

    const { restoredContent } = restoreContent(redactedContent, { DB_PASSWORD: SECRET });
    expect(restoredContent).toBe(original);
  });
});

describe('restoreFiles with a tracked directory path', () => {
  it('skips a directory entry without throwing EISDIR', async () => {
    // restore (and apply) pass restored target paths to restoreFiles to swap
    // placeholders back. A tracked DIRECTORY path would readFile→EISDIR; it must
    // be skipped. Caught by live sandbox testing of `tuck restore --all`.
    vol.reset();
    vol.mkdirSync('/test-home/.config/app', { recursive: true });
    vol.writeFileSync('/test-home/.config/app/settings.conf', 'theme=dark\n');
    vol.mkdirSync('/test-home/.tuck', { recursive: true }); // tuckDir, no secrets store

    const res = await restoreFiles(['~/.config/app'], '/test-home/.tuck');

    expect(res.filesModified).toBe(0);
    // The directory's contents are untouched (no spurious rewrite).
    expect(vol.readFileSync('/test-home/.config/app/settings.conf', 'utf-8')).toBe('theme=dark\n');
  });
});
