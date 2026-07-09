/**
 * Unit tests for MCP secrets extraction (src/lib/secrets/mcp.ts).
 *
 * Pure logic: parsing, credential heuristics, placeholder generation, and the
 * targeted-token rewrite. No filesystem access (except the memfs-mocked
 * homedir used by getMcpTargetPaths).
 */
import { describe, it, expect } from 'vitest';
import {
  isCredentialKey,
  isReferenceValue,
  shouldExtractValue,
  buildReference,
  analyzeMcpConfig,
  extractMcpSecrets,
  getMcpTargetPaths,
} from '../../../src/lib/secrets/mcp.js';
import { McpConfigError } from '../../../src/errors.js';

describe('isCredentialKey', () => {
  it('flags common credential key names', () => {
    for (const key of [
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'API_KEY',
      'apiKey',
      'OPENAI_API_KEY',
      'CLIENT_SECRET',
      'DB_PASSWORD',
      'Authorization',
      'x-api-key',
      'MY_ACCESS_KEY',
    ]) {
      expect(isCredentialKey(key)).toBe(true);
    }
  });

  it('does not flag ordinary config keys', () => {
    for (const key of ['NODE_ENV', 'PORT', 'DEBUG', 'LOG_LEVEL', 'HOST', 'REGION']) {
      expect(isCredentialKey(key)).toBe(false);
    }
  });
});

describe('isReferenceValue', () => {
  it('treats already-externalized values as references', () => {
    for (const value of [
      '',
      '   ',
      '${env:GITHUB_TOKEN}',
      '{{GITHUB_TOKEN}}',
      'op://vault/item/field',
      '$(cat secret)',
      '$GITHUB_TOKEN',
      '<YOUR_TOKEN_HERE>',
      'true',
      'false',
    ]) {
      expect(isReferenceValue(value)).toBe(true);
    }
  });

  it('treats real inline values as non-references', () => {
    expect(isReferenceValue('ghp_1234567890abcdef')).toBe(false);
    expect(isReferenceValue('sk-proj-abcdef')).toBe(false);
  });
});

describe('shouldExtractValue', () => {
  it('extracts credential-keyed non-reference values of sufficient length', () => {
    expect(shouldExtractValue('GITHUB_TOKEN', 'ghp_realtokenvalue1234')).toBe(true);
  });

  it('skips short credential-keyed values (flags, ports)', () => {
    expect(shouldExtractValue('TOKEN', 'abc')).toBe(false);
    expect(shouldExtractValue('API_KEY', 'true')).toBe(false);
  });

  it('skips existing references even under credential keys', () => {
    expect(shouldExtractValue('API_KEY', '${env:API_KEY}')).toBe(false);
    expect(shouldExtractValue('API_KEY', '{{API_KEY}}')).toBe(false);
  });

  it('extracts secret-shaped values even under generic keys (content detection)', () => {
    // ghp_ token is detected by the scanner regardless of the key name.
    expect(shouldExtractValue('SOME_VALUE', 'ghp_' + 'a'.repeat(36))).toBe(true);
  });

  it('leaves ordinary config values alone', () => {
    expect(shouldExtractValue('NODE_ENV', 'production')).toBe(false);
    expect(shouldExtractValue('PORT', '3000')).toBe(false);
  });
});

describe('buildReference', () => {
  it('builds tuck placeholders by default', () => {
    expect(buildReference('GITHUB_TOKEN', 'placeholder')).toBe('{{GITHUB_TOKEN}}');
  });

  it('builds ${env:NAME} references for env format', () => {
    expect(buildReference('GITHUB_TOKEN', 'env')).toBe('${env:GITHUB_TOKEN}');
  });
});

describe('analyzeMcpConfig', () => {
  it('throws McpConfigError on invalid JSON', () => {
    expect(() => analyzeMcpConfig('{ not json', 'bad.json')).toThrow(McpConfigError);
  });

  it('finds env credentials under mcpServers', () => {
    const config = JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_' + 'x'.repeat(36), NODE_ENV: 'production' },
        },
      },
    });
    const { pending, serverCount } = analyzeMcpConfig(config);
    expect(serverCount).toBe(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].key).toBe('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(pending[0].field).toBe('env');
  });

  it('finds credentials in the VS Code `servers` shape and in `headers`', () => {
    const config = JSON.stringify({
      servers: {
        remote: {
          url: 'https://example.com',
          headers: { Authorization: 'Bearer sk-realsecretvalue123456' },
        },
      },
    });
    const { pending } = analyzeMcpConfig(config);
    expect(pending).toHaveLength(1);
    expect(pending[0].field).toBe('headers');
    expect(pending[0].key).toBe('Authorization');
  });

  it('finds project-nested mcpServers (e.g. ~/.claude.json)', () => {
    const config = JSON.stringify({
      projects: {
        '/home/user/proj': {
          mcpServers: {
            db: { env: { DATABASE_PASSWORD: 'supersecretpw123' } },
          },
        },
      },
    });
    const { pending, serverCount } = analyzeMcpConfig(config);
    expect(serverCount).toBe(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].scope).toContain('projects');
    expect(pending[0].key).toBe('DATABASE_PASSWORD');
  });
});

describe('extractMcpSecrets', () => {
  it('rewrites inline values into tuck placeholders and reports extractions', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const config = JSON.stringify(
      {
        mcpServers: {
          github: { command: 'npx', env: { GITHUB_TOKEN: token, NODE_ENV: 'production' } },
        },
      },
      null,
      2
    );

    const result = extractMcpSecrets(config);
    expect(result.changed).toBe(true);
    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0].placeholder).toBe('GITHUB_TOKEN');
    expect(result.extractions[0].value).toBe(token);

    // The real token is gone; the placeholder is present.
    expect(result.rewritten).not.toContain(token);
    expect(result.rewritten).toContain('{{GITHUB_TOKEN}}');
    // Non-secret config is untouched.
    expect(result.rewritten).toContain('"NODE_ENV": "production"');
    // Still valid JSON.
    const reparsed = JSON.parse(result.rewritten);
    expect(reparsed.mcpServers.github.env.GITHUB_TOKEN).toBe('{{GITHUB_TOKEN}}');
  });

  it('supports the env reference format', () => {
    const config = JSON.stringify({
      mcpServers: { s: { env: { API_KEY: 'realapikeyvalue123456' } } },
    });
    const result = extractMcpSecrets(config, { format: 'env' });
    expect(result.rewritten).toContain('${env:API_KEY}');
  });

  it('deduplicates the same value to one placeholder across servers', () => {
    const secret = 'sharedsecretvalue123456';
    const config = JSON.stringify({
      mcpServers: {
        a: { env: { API_KEY: secret } },
        b: { env: { API_KEY: secret } },
      },
    });
    const result = extractMcpSecrets(config);
    const placeholders = new Set(result.extractions.map((e) => e.placeholder));
    expect(placeholders.size).toBe(1);
    expect(result.rewritten).not.toContain(secret);
  });

  it('gives distinct placeholders to different values sharing a key', () => {
    const config = JSON.stringify({
      mcpServers: {
        a: { env: { API_KEY: 'firstsecretvalue123456' } },
        b: { env: { API_KEY: 'secondsecretvalue123456' } },
      },
    });
    const result = extractMcpSecrets(config);
    const placeholders = result.extractions.map((e) => e.placeholder).sort();
    expect(placeholders).toEqual(['API_KEY', 'API_KEY_1']);
  });

  it('respects existing placeholders passed in from other files', () => {
    const config = JSON.stringify({
      mcpServers: { s: { env: { API_KEY: 'anothersecretvalue123456' } } },
    });
    const existing = new Set(['API_KEY']);
    const result = extractMcpSecrets(config, { existingPlaceholders: existing });
    expect(result.extractions[0].placeholder).toBe('API_KEY_1');
  });

  it('is a no-op when there are no inline credentials', () => {
    const config = JSON.stringify({
      mcpServers: { s: { command: 'npx', env: { NODE_ENV: 'production' } } },
    });
    const result = extractMcpSecrets(config);
    expect(result.changed).toBe(false);
    expect(result.extractions).toHaveLength(0);
    expect(result.rewritten).toBe(config);
  });

  it('does not double-extract already-referenced values', () => {
    const config = JSON.stringify({
      mcpServers: { s: { env: { API_KEY: '{{API_KEY}}' } } },
    });
    const result = extractMcpSecrets(config);
    expect(result.changed).toBe(false);
    expect(result.extractions).toHaveLength(0);
  });

  it('skips (does NOT extract) values encoded with escape variants it cannot match', () => {
    // Hand-written JSON where the secret uses `\/` — valid JSON that parses to
    // `secret/value/abcdef123456`, but JSON.stringify re-encodes without the
    // escaped slash, so a byte-for-byte search of the source finds nothing.
    const config = '{"mcpServers":{"s":{"env":{"API_KEY":"secret\\/value\\/abcdef123456"}}}}';
    // Sanity: this is valid JSON and the raw value round-trips with a slash.
    expect(JSON.parse(config).mcpServers.s.env.API_KEY).toBe('secret/value/abcdef123456');

    const result = extractMcpSecrets(config);
    // The value cannot be located verbatim → nothing is rewritten or extracted.
    expect(result.changed).toBe(false);
    expect(result.rewritten).toBe(config);
    expect(result.extractions).toHaveLength(0);
    // …but it is surfaced as skipped so callers can warn instead of no-oping.
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].key).toBe('API_KEY');
    // The plaintext secret is (deliberately) still present in the source.
    expect(result.rewritten).toContain('secret\\/value\\/abcdef123456');
  });

  it('skips unicode-escaped values while still rewriting matchable ones in the same file', () => {
    const matchable = 'ghp_' + 'a'.repeat(36);
    // `cafésecret...` parses to `café…` which stringifies as literal `é`.
    const config =
      '{"mcpServers":{' +
      `"ok":{"env":{"GITHUB_TOKEN":"${matchable}"}},` +
      '"bad":{"env":{"API_KEY":"caf\\u00e9secretvalue123456"}}' +
      '}}';

    const result = extractMcpSecrets(config);
    // The matchable token is rewritten and reported.
    expect(result.changed).toBe(true);
    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0].placeholder).toBe('GITHUB_TOKEN');
    expect(result.rewritten).not.toContain(matchable);
    expect(result.rewritten).toContain('{{GITHUB_TOKEN}}');
    // The escape-variant value is skipped and left in place.
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].key).toBe('API_KEY');
    expect(result.rewritten).toContain('caf\\u00e9secretvalue123456');
  });

  it('reports an empty skipped list when every value is rewritten', () => {
    const config = JSON.stringify({
      mcpServers: { s: { env: { API_KEY: 'realapikeyvalue123456' } } },
    });
    const result = extractMcpSecrets(config);
    expect(result.extractions).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('getMcpTargetPaths', () => {
  it('includes the well-known MCP config locations', () => {
    const paths = getMcpTargetPaths('/project');
    const labels = paths.map((p) => p.label);
    expect(labels).toContain('Claude Desktop');
    expect(labels).toContain('Claude Code');
    expect(labels.some((l) => l.startsWith('Cursor'))).toBe(true);
    // Home + project scopes both represented.
    expect(paths.some((p) => p.scope === 'global')).toBe(true);
    expect(paths.some((p) => p.scope === 'project')).toBe(true);
  });

  it('deduplicates by expanded path', () => {
    const paths = getMcpTargetPaths('/project');
    const expanded = paths.map((p) => p.expandedPath);
    expect(new Set(expanded).size).toBe(expanded.length);
  });
});
