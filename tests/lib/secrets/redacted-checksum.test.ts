/**
 * Redacted-content checksum helpers (issue #100).
 *
 * tuck redacts secrets only in the REPO copy: live ~/.zshrc keeps the real
 * value, the repo copy holds {{PLACEHOLDER}}, and the manifest checksum is of
 * the redacted repo content. Drift detection must therefore checksum the LIVE
 * file "as if its known secrets were redacted" and compare to the stored
 * checksum. These tests pin that the redacted checksum is byte-compatible with
 * files.ts getFileChecksum for the equivalently-redacted content/tree, and
 * falls back to hashing the RAW buffer when no secret value is present (so
 * binary and non-secret files are untouched).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vol } from 'memfs';
import { join } from 'path';
import { getFileChecksum } from '../../../src/lib/files.js';
import { redactContent, formatPlaceholder } from '../../../src/lib/secrets/redactor.js';
import {
  getStoredValueMap,
  getRedactedChecksum,
  redactValuesInContent,
} from '../../../src/lib/secrets/redactor.js';
import { setSecret } from '../../../src/lib/secrets/store.js';
import type { SecretMatch } from '../../../src/lib/secrets/scanner.js';
import { TEST_TUCK_DIR } from '../../setup.js';

const HOME = '/test-home';
const LIVE = `${HOME}/live`;
const REPO = `${HOME}/repo`;

/** Build a minimal SecretMatch for a value/placeholder pair. */
const match = (value: string, placeholder: string): SecretMatch => ({
  patternId: 'test',
  patternName: 'Test',
  severity: 'high',
  value,
  redactedValue: value,
  line: 1,
  column: 1,
  context: '',
  placeholder,
});

describe('getStoredValueMap', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(TEST_TUCK_DIR, { recursive: true });
  });
  afterEach(() => vol.reset());

  it('is empty when no secrets stored', async () => {
    const map = await getStoredValueMap(TEST_TUCK_DIR);
    expect(map.size).toBe(0);
  });

  it('inverts store to value -> placeholder name', async () => {
    await setSecret(TEST_TUCK_DIR, 'KEY', 'realvalue');
    const map = await getStoredValueMap(TEST_TUCK_DIR);
    expect(map.get('realvalue')).toBe('KEY');
  });

  it('keeps the FIRST stored name when two names share a value', async () => {
    await setSecret(TEST_TUCK_DIR, 'KEY', 'dup');
    await setSecret(TEST_TUCK_DIR, 'KEY_1', 'dup');
    const map = await getStoredValueMap(TEST_TUCK_DIR);
    expect(map.get('dup')).toBe('KEY');
    expect(map.size).toBe(1);
  });

  it('skips empty-string secret values (an empty value would match every file)', async () => {
    await setSecret(TEST_TUCK_DIR, 'EMPTY', '');
    await setSecret(TEST_TUCK_DIR, 'REAL', 'realvalue');
    const map = await getStoredValueMap(TEST_TUCK_DIR);
    // The empty value must NOT enter the map — otherwise every file would
    // "contain" it and every redacted checksum would be corrupted.
    expect(map.has('')).toBe(false);
    expect(map.get('realvalue')).toBe('REAL');
    expect(map.size).toBe(1);
  });
});

describe('getRedactedChecksum (single file)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(HOME, { recursive: true });
  });
  afterEach(() => vol.reset());

  it('equals the checksum of the redactContent-written repo copy', async () => {
    const value = 'super-secret-token-123';
    const content = `export API_KEY=${value}\nother=line\nAPI_KEY again ${value}\n`;
    vol.writeFileSync(LIVE, content);

    const valueMap = new Map<string, string>([[value, 'API_KEY']]);
    const { redactedContent } = redactContent(content, [match(value, 'API_KEY')], valueMap);
    vol.writeFileSync(REPO, redactedContent);

    const live = await getRedactedChecksum(LIVE, valueMap);
    const repo = await getFileChecksum(REPO);
    expect(live).toBe(repo);
    // sanity: placeholder actually appears in the repo copy
    expect(redactedContent).toContain(formatPlaceholder('API_KEY'));
  });

  it('equals getFileChecksum exactly when file has no secret values', async () => {
    vol.writeFileSync(LIVE, 'nothing secret here\n');
    const valueMap = new Map<string, string>([['absent-value', 'NOPE']]);
    const redacted = await getRedactedChecksum(LIVE, valueMap);
    const raw = await getFileChecksum(LIVE);
    expect(redacted).toBe(raw);
  });

  it('hashes the RAW buffer for binary content with invalid utf-8 bytes', async () => {
    // 0xff/0xfe are invalid utf-8 lead bytes; utf8 decode would replace them.
    const bin = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80, 0x42]);
    vol.writeFileSync(LIVE, bin);
    const valueMap = new Map<string, string>([['secret', 'S']]);
    const redacted = await getRedactedChecksum(LIVE, valueMap);
    const raw = await getFileChecksum(LIVE);
    expect(redacted).toBe(raw);
  });

  it('hashes a binary file RAW even when a stored secret appears in its utf-8 decode', async () => {
    // The secret scanner SKIPS binary files, so their repo copies are never
    // redacted. If getRedactedChecksum redacted the secret's bytes out of a
    // binary's lossy utf-8 decode, the live checksum would never match the
    // (un-redacted) repo copy → phantom, unresolvable drift. A binary must hash
    // raw regardless of what its decode happens to contain.
    const secret = 'EMBEDDED-SECRET-123';
    const bin = Buffer.concat([
      Buffer.from('prefix'),
      Buffer.from([0x00, 0x01, 0x02]), // NUL byte ⇒ binary
      Buffer.from(secret, 'utf8'), // secret bytes literally present in the decode
      Buffer.from([0xff, 0x00]),
    ]);
    vol.writeFileSync(LIVE, bin);
    const valueMap = new Map<string, string>([[secret, 'EMBEDDED']]);
    const redacted = await getRedactedChecksum(LIVE, valueMap);
    const raw = await getFileChecksum(LIVE);
    expect(redacted).toBe(raw);
  });

  it('equals getFileChecksum when valueMap is empty', async () => {
    const content = 'export API_KEY=super-secret-token-123\n';
    vol.writeFileSync(LIVE, content);
    const redacted = await getRedactedChecksum(LIVE, new Map());
    const raw = await getFileChecksum(LIVE);
    expect(redacted).toBe(raw);
  });

  it('matches redactContent for a substring-secret pair (shorter inside longer)', async () => {
    const long = 'AKIAEXAMPLE1234567890';
    const short = 'AKIAEXAMPLE'; // literal substring of `long`
    const content = `id=${short}\nfull=${long}\nrepeat ${short} and ${long}\n`;
    vol.writeFileSync(LIVE, content);

    // value -> placeholder; both stored
    const valueMap = new Map<string, string>([
      [short, 'SHORT'],
      [long, 'LONG'],
    ]);
    const { redactedContent } = redactContent(
      content,
      [match(short, 'SHORT'), match(long, 'LONG')],
      valueMap
    );
    vol.writeFileSync(REPO, redactedContent);

    const live = await getRedactedChecksum(LIVE, valueMap);
    const repo = await getFileChecksum(REPO);
    expect(live).toBe(repo);
    // The longer secret must not be corrupted by the shorter replacement.
    expect(redactedContent).toContain(formatPlaceholder('LONG'));
    expect(redactedContent).toContain(formatPlaceholder('SHORT'));
  });
});

describe('redactValuesInContent', () => {
  it('replaces stored values with their {{placeholder}} longest-first', () => {
    const long = 'AKIAEXAMPLE1234567890';
    const short = 'AKIAEXAMPLE';
    const content = `id=${short}\nfull=${long}\n`;
    const valueMap = new Map<string, string>([
      [short, 'SHORT'],
      [long, 'LONG'],
    ]);
    const out = redactValuesInContent(content, valueMap);
    expect(out).toBe(`id=${formatPlaceholder('SHORT')}\nfull=${formatPlaceholder('LONG')}\n`);
  });

  it('returns content unchanged when no stored value is present', () => {
    const content = 'nothing secret here\n';
    const valueMap = new Map<string, string>([['absent', 'NOPE']]);
    expect(redactValuesInContent(content, valueMap)).toBe(content);
  });

  it('ignores empty-string values (never rewrites the whole file)', () => {
    const content = 'abc\n';
    const valueMap = new Map<string, string>([['', 'EMPTY']]);
    expect(redactValuesInContent(content, valueMap)).toBe(content);
  });
});

describe('getRedactedChecksum (directory)', () => {
  const DIR = `${HOME}/cfgdir`;
  const REPODIR = `${HOME}/cfgdir-repo`;

  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(DIR, { recursive: true });
    vol.mkdirSync(REPODIR, { recursive: true });
  });
  afterEach(() => vol.reset());

  it('equals getFileChecksum for the same tree when no secrets present', async () => {
    vol.writeFileSync(`${DIR}/a.txt`, 'plain A\n');
    vol.mkdirSync(`${DIR}/sub`, { recursive: true });
    vol.writeFileSync(`${DIR}/sub/b.txt`, 'plain B\n');
    const redacted = await getRedactedChecksum(DIR, new Map([['x', 'X']]));
    const raw = await getFileChecksum(DIR);
    expect(redacted).toBe(raw);
  });

  it('equals the redacted-repo-tree checksum when inner files contain secrets', async () => {
    const value = 'inner-secret-9999';
    const valueMap = new Map<string, string>([[value, 'INNER']]);

    // Live tree: a secret file, a non-secret file, and a binary file.
    const secretFile = `has key=${value}\n`;
    const plainFile = 'just text\n';
    const binary = Buffer.from([0x00, 0xff, 0x01, 0xfe]);

    vol.writeFileSync(`${DIR}/secret.txt`, secretFile);
    vol.writeFileSync(`${DIR}/plain.txt`, plainFile);
    vol.writeFileSync(`${DIR}/blob.bin`, binary);

    // Equivalent repo tree: secret file redacted via redactContent, others copied raw.
    const { redactedContent } = redactContent(secretFile, [match(value, 'INNER')], valueMap);
    vol.writeFileSync(join(REPODIR, 'secret.txt'), redactedContent);
    vol.writeFileSync(join(REPODIR, 'plain.txt'), plainFile);
    vol.writeFileSync(join(REPODIR, 'blob.bin'), binary);

    const live = await getRedactedChecksum(DIR, valueMap);
    const repo = await getFileChecksum(REPODIR);
    expect(live).toBe(repo);
  });
});
