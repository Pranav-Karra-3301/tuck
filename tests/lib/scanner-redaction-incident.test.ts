/**
 * Regression tests for issue #100 — secret redaction corrupting dotfiles.
 *
 * Covers three scanner/pattern defects that combined to rewrite a live ~/.zshrc
 * into invalid shell and leave half a credential committed in cleartext:
 *   1. scanContent used `match[1] || match[0]`: patterns whose secret lands in
 *      capture group 2 (the UNQUOTED alternative of the generic assignment
 *      patterns) fell back to the whole match — so redaction swallowed the
 *      `API_KEY=` context and broke the variable name.
 *   2. The unquoted value class excluded '.', so dotted keys were matched only
 *      up to the dot: the tail stayed in cleartext AND got committed.
 *   3. `password-url`'s character classes matched newlines, so URLs on
 *      consecutive comment lines (stock ~/.p10k.zsh) were reported as one
 *      multi-line "critical" password and redaction spliced the lines together.
 */

import { describe, it, expect } from 'vitest';
import { scanContent } from '../../src/lib/secrets/scanner.js';
import { redactContent } from '../../src/lib/secrets/redactor.js';

const HEX32 = '0123456789abcdef0123456789abcdef';

describe('scanner value extraction (issue #100)', () => {
  it('extracts only the secret for an unquoted api key assignment (capture group 2)', () => {
    const secret = `secret_${HEX32}`;
    const content = `export LAMBDA_API_KEY=${secret}`;
    const matches = scanContent(content);

    const match = matches.find((m) => m.patternId === 'api-key-assignment');
    expect(match).toBeDefined();
    expect(match!.value).toBe(secret);
  });

  it('extracts only the secret for an unquoted token assignment (capture group 2)', () => {
    const secret = `tok_${HEX32}${HEX32}`;
    const content = `export MY_ACCESS_TOKEN=${secret}`;
    const matches = scanContent(content);

    const match = matches.find((m) => m.patternId === 'token-assignment');
    expect(match).toBeDefined();
    expect(match!.value).toBe(secret);
  });

  it('captures a dotted unquoted api key fully instead of stopping at the dot', () => {
    const secret = `secret_${HEX32}.SecondHalf${HEX32}`;
    const content = `export LAMBDA_API_KEY=${secret}`;
    const matches = scanContent(content);

    const match = matches.find((m) => m.patternId === 'api-key-assignment');
    expect(match).toBeDefined();
    expect(match!.value).toBe(secret);
  });

  it('redacts an unquoted dotted assignment without corrupting the variable name or leaking a tail', () => {
    const secret = `secret_${HEX32}.SecondHalf${HEX32}`;
    const content = `export LAMBDA_API_KEY=${secret}\n`;
    const matches = scanContent(content);
    expect(matches.length).toBeGreaterThan(0);

    const placeholderMap = new Map(matches.map((m) => [m.value, 'API_KEY']));
    const result = redactContent(content, matches, placeholderMap);

    expect(result.redactedContent).toBe('export LAMBDA_API_KEY={{API_KEY}}\n');
  });
});

describe('password-url multiline false positive (issue #100)', () => {
  it('does not flag URLs spread across consecutive comment lines as a password in a URL', () => {
    // Verbatim shape of stock ~/.p10k.zsh comments: several URLs, then a later
    // line containing '@'. The buggy pattern matched from one URL across four
    // lines to the '@' in 'name@version'.
    const p10kComments = [
      '    # dotnet_version        # .NET version (https://dotnet.microsoft.com)',
      '    # php_version           # php version (https://www.php.net/)',
      '    # laravel_version       # laravel php framework version (https://laravel.com/)',
      '    # java_version          # java version (https://www.java.com/)',
      '    # package               # name@version from package.json (https://docs.npmjs.com/files/package.json)',
    ].join('\n');

    const matches = scanContent(p10kComments);
    expect(matches.filter((m) => m.patternId === 'password-url')).toHaveLength(0);
  });

  it('still detects a real password embedded in a single-line URL', () => {
    const content = 'backup_target=https://admin:hunter2secret@db.example.com/prod';
    const matches = scanContent(content);

    const match = matches.find((m) => m.patternId === 'password-url');
    expect(match).toBeDefined();
    expect(match!.value).toBe('hunter2secret');
  });

  it('does not let database connection string patterns span lines', () => {
    const content = [
      '# see postgres://wiki for details',
      'unrelated: value@host',
    ].join('\n');
    const matches = scanContent(content);
    expect(matches.filter((m) => m.patternId === 'postgres-connection')).toHaveLength(0);
  });
});
