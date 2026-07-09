import { describe, it, expect } from 'vitest';
import { scanContent } from '../../../src/lib/secrets/scanner.js';

describe('scanContent value extraction', () => {
  it('extracts the unquoted value (group 2), not the keyword context (issue #100 RC1)', () => {
    const line =
      'export LAMBDA_API_KEY=secret_example_e3878cb6494b410eabc3e16d15a99b08.SecondHalfOfKey12345';
    const matches = scanContent(line);
    const m = matches.find((x) => x.value.includes('secret_example'));
    expect(m).toBeDefined();
    expect(m!.value).toBe(
      'secret_example_e3878cb6494b410eabc3e16d15a99b08.SecondHalfOfKey12345'
    ); // full value incl. dot — no cleartext tail (RC3)
    expect(m!.value).not.toContain('API_KEY='); // no identifier context (RC1)
  });

  it('names the placeholder after the full identifier', () => {
    const matches = scanContent('export LAMBDA_API_KEY=abcdefghijklmnop1234');
    expect(matches[0]?.placeholder).toBe('LAMBDA_API_KEY');
  });

  it('skips env-var references, paths, and placeholders (non-secret guard)', () => {
    const content = [
      'export API_KEY=$OTHER_VAR_THAT_IS_LONG',
      'export API_KEY_2=~/secrets/keyfile-long-name',
      'export TOKEN_FILE_PATH=/usr/local/etc/token-file-x',
      'export API_KEY_3={{ALREADY_A_PLACEHOLDER}}',
    ].join('\n');
    expect(scanContent(content)).toHaveLength(0);
  });

  it('still detects a vendor-pattern secret that legitimately starts with "/" (guard scope)', () => {
    // The AWS secret key class [A-Za-z0-9/+=]{40} can legitimately begin with
    // "/". The non-secret guard must NOT apply to vendor patterns (which capture
    // via a numbered group, not the named `value` group), or we silently commit
    // a real key in cleartext.
    const content =
      'aws_secret_access_key = "/abcdefghijklmnopqrstuvwxyz0123456789+=/"';
    const matches = scanContent(content);
    const m = matches.find((x) => x.patternId === 'aws-secret-key');
    expect(m).toBeDefined();
    expect(m!.value).toBe('/abcdefghijklmnopqrstuvwxyz0123456789+=/'); // 40 chars, quotes excluded
  });

  it('still detects a QUOTED generic value that starts with "$" (guard scope)', () => {
    // The "env-var reference" rationale for the guard cannot apply inside quotes,
    // so a quoted password beginning with "$" must still be flagged.
    const content = 'export MY_PASSWORD="$uper$ecretValue1"';
    const matches = scanContent(content);
    const m = matches.find((x) => x.value === '$uper$ecretValue1');
    expect(m).toBeDefined();
    expect(m!.patternId).toBe('password-assignment');
  });

  it('records value offsets (start/end) into the scanned content', () => {
    const content = 'export MY_API_KEY=abcdefghijklmnop1234';
    const [m] = scanContent(content);
    expect(content.slice(m.start, m.end)).toBe(m.value);
  });

  it('vendor pattern beats generic on the same value (PAT not stored as TOKEN)', () => {
    // A GitHub fine-grained PAT also matches the generic token-assignment pattern
    // (identifier ends in TOKEN). One secret must yield ONE match: the vendor
    // pattern (github-fine-grained) wins over GENERIC_PATTERN_IDS (issue #100).
    const pat =
      'github_pat_11ABCDEFG0123456789_' +
      'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV';
    const hits = scanContent(`export GITHUB_FINE_GRAINED_TOKEN=${pat}`);
    expect(hits).toHaveLength(1);
    expect(hits[0].patternId).toBe('github-fine-grained');
    expect(hits[0].value).toBe(pat);
  });

  it('collapses two overlapping generic matches to the longer captured value', () => {
    // A Postgres connection string matches both `postgres-connection` (whole
    // match, no capture group) and `password-url` (just the password segment).
    // Both are generic, so the longer captured value wins — the full
    // connection string, not the bare password (binding adjustment #3).
    const content = 'DATABASE_URL=postgres://user:password123@host:5432/db';
    const hits = scanContent(content);
    expect(hits).toHaveLength(1);
    expect(hits[0].patternId).toBe('postgres-connection');
  });
});
