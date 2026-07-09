import { describe, it, expect } from 'vitest';
import { scanContent } from '../../../src/lib/secrets/scanner.js';

describe('issue #100 pattern fixes', () => {
  it('password-url never matches across lines (p10k comment block, RC4)', () => {
    const p10k = [
      '    # dotnet_version       # .NET version (https://dotnet.microsoft.com)',
      '    # php_version           # php version (https://www.php.net/)',
      '    # laravel_version       # laravel php framework version (https://laravel.com/)',
      '    # java_version          # java version (https://www.java.com/)',
      '    # package               # name@version from package.json',
    ].join('\n');
    expect(scanContent(p10k).filter((m) => m.patternId === 'password-url')).toHaveLength(0);
  });

  it('still catches a real password-in-URL', () => {
    // Scheme is `https` (not `postgres`) so the dedicated postgres-connection
    // pattern does not co-fire and outrank password-url — see report notes.
    const [m] = scanContent('db_url=https://admin:sup3rS3cretPW@db.example.com:5432/app');
    expect(m.patternId).toBe('password-url');
    expect(m.value).toBe('sup3rS3cretPW');
  });

  it('matches prefixed identifiers in full and not mid-identifier (RC2)', () => {
    const hits = scanContent('export GITHUB_PERSONAL_ACCESS_TOKEN=abcdefghijklmnopqrst1234');
    expect(hits).toHaveLength(1);
    expect(hits[0].placeholder).toBe('GITHUB_PERSONAL_ACCESS_TOKEN');
    // identifier where the keyword is NOT terminal never matches
    expect(scanContent('export TOKENIZER_MODEL=abcdefghijklmnopqrst1234')).toHaveLength(0);
    expect(scanContent('export API_KEY_FILE=abcdefghijklmnopqrst1234')).toHaveLength(0);
  });

  it('captures dotted/unusual unquoted values in full (RC3)', () => {
    const [m] = scanContent('export CTX_API_KEY=ctx7sk-abc123.def456~ghi789=jkl');
    expect(m.value).toBe('ctx7sk-abc123.def456~ghi789=jkl');
  });

  it('does not blow up on pathological input (ReDoS guard)', () => {
    const evil = 'api_key='.padEnd(300, 'a') + '\n' + 'a'.repeat(5000) + 'api_key';
    const started = Date.now();
    scanContent(evil.repeat(50));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
