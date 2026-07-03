/**
 * External (gitleaks) scanner redaction unit test.
 *
 * The gitleaks code path set SecretMatch.context = finding.Match, i.e. the raw
 * matched line containing the live secret. context is printed by
 * displayScanResults, so this leaked actual secret values to stdout / logs /
 * scrollback for gitleaks users. context must be redacted.
 */
import { describe, it, expect } from 'vitest';
import { gitleaksResultToMatch } from '../../src/lib/secrets/external.js';

const finding = {
  Description: 'AWS Access Key',
  StartLine: 3,
  EndLine: 3,
  StartColumn: 5,
  EndColumn: 40,
  Match: 'aws_secret_access_key = AKIAIOSFODNN7EXAMPLE',
  Secret: 'AKIAIOSFODNN7EXAMPLE',
  File: 'config',
  SymlinkFile: '',
  Commit: '',
  Entropy: 0,
  Author: '',
  Email: '',
  Date: '',
  Message: '',
  Tags: [] as string[],
  RuleID: 'aws-access-token',
  Fingerprint: '',
};

describe('gitleaksResultToMatch', () => {
  it('never puts the raw secret into context', () => {
    const match = gitleaksResultToMatch(finding);
    expect(match.context).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(match.context).not.toContain('aws_secret_access_key = AKIA');
  });

  it('still carries the secret value (needed for placeholder mapping) but a redacted display value', () => {
    const match = gitleaksResultToMatch(finding);
    expect(match.value).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(match.redactedValue).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
