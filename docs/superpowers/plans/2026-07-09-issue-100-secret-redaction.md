# Issue #100 Secret Redaction Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five root causes in tuck's secret redaction (issue #100): wrong match extraction, mid-identifier keyword matches, half-redacted dotted secrets, newline-crossing `password-url` matches, and live-file rewriting — plus placeholder-aware drift detection so repo-only redaction doesn't cause perpetual "modified" status.

**Architecture:** Redaction becomes repo-copy-only: the scan/prompt flow builds *redaction plans* (matches + placeholder maps) that are applied to the repo destination file right after copy and before the manifest checksum is computed; live files are never written. Sync/status/diff gain a shared redact-in-memory comparison so "modified" means "a sync would change the repo copy". Generic patterns move to named capture groups matching full identifiers, with post-match non-secret guards and cross-pattern overlap resolution.

**Tech Stack:** TypeScript 5 strict ESM, Vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-issue-100-secret-redaction-design.md`

## Global Constraints

- Never use `any`; strict TS must pass (`pnpm typecheck`).
- All regexes keep bounded quantifiers (ReDoS discipline; see `regexSafety.ts`, scanner timeouts).
- Live files in `$HOME` must never be written by any redaction path.
- Conventional commits; run `pnpm lint && pnpm typecheck && pnpm test` before each commit.
- Baseline: 146 test files / 1512 tests passing on `fix/issue-100-secret-redaction`.

---

### Task 1: Scanner extraction, placeholder naming, non-secret guards

**Files:**
- Modify: `src/lib/secrets/scanner.ts` (extraction at `:264-270`, plus helpers)
- Test: `tests/lib/secrets/scanner-extraction.test.ts` (new)

**Interfaces:**
- Produces: scanner honors named groups `qvalue`/`value`/`name` on any `SecretPattern`; exports nothing new. `SecretMatch` gains internal-use fields `start: number` and `end: number` (value's index range in content) — used by Task 3.

**Extraction rule** (replaces `const value = match[1] || match[0];` at scanner.ts:265):

```ts
// Extract the secret value. Named-group convention (new patterns): `qvalue`
// (quoted) / `value` (unquoted). Numbered-group convention (legacy + custom
// patterns): first DEFINED group. `??`-chains so an empty-string capture never
// falls through to match[0] (which would include the identifier context and
// make redaction eat surrounding text — issue #100 root cause 1).
const groups = match.groups;
const value =
  groups?.['qvalue'] ??
  groups?.['value'] ??
  match.slice(1).find((g): g is string => g !== undefined) ??
  match[0];
```

Note: when a pattern has a `name` group but no value groups, the numbered fallback would grab the name — the named-group convention therefore REQUIRES `qvalue`/`value` alongside `name` (all Task 2 patterns comply).

**Placeholder naming** (new helper + use where `placeholder: pattern.placeholder` is set at :290):

```ts
/**
 * Placeholder for a match: the full captured identifier when the pattern
 * exposes one (e.g. LAMBDA_API_KEY -> {{LAMBDA_API_KEY}}), else the pattern
 * default. Sanitized to match PLACEHOLDER_REGEX ([A-Z][A-Z0-9_]*).
 */
const derivePlaceholder = (name: string | undefined, fallback: string): string => {
  if (!name) return fallback;
  let p = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!/^[A-Z]/.test(p)) p = `SECRET_${p}`;
  return p;
};
// in the loop:  placeholder: derivePlaceholder(groups?.['name'], pattern.placeholder),
```

**Non-secret guard** (new, applied right after the `value.length < 4` skip):

```ts
// Values that are clearly not literal secrets: env-var references, home/abs/rel
// paths, and already-redacted placeholders. Broad unquoted classes (Task 2)
// would otherwise flag `KEY_FILE=/path/to/key.pem` or `KEY=$OTHER_VAR`.
const NON_SECRET_PREFIXES = ['$', '~', '/', './', '{{'] as const;
const isLikelyNonSecret = (value: string): boolean =>
  NON_SECRET_PREFIXES.some((p) => value.startsWith(p));
// in the loop:  if (isLikelyNonSecret(value)) continue;
```

**Value range for Task 3** (compute alongside `position`):

```ts
const valueOffset = match[0].indexOf(value); // value is always a substring of match[0]
const start = match.index + (valueOffset >= 0 ? valueOffset : 0);
matches.push({ ..., start, end: start + value.length });
```
Add `start: number; end: number;` to `SecretMatch` (scanner.ts:33-43) with a doc comment saying they are content offsets of the value.

- [ ] **Step 1: Write failing tests** — `tests/lib/secrets/scanner-extraction.test.ts`:

```ts
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

  it('records value offsets (start/end) into the scanned content', () => {
    const content = 'export MY_API_KEY=abcdefghijklmnop1234';
    const [m] = scanContent(content);
    expect(content.slice(m.start, m.end)).toBe(m.value);
  });
});
```

- [ ] **Step 2: Run tests, verify failure** — `pnpm vitest run tests/lib/secrets/scanner-extraction.test.ts`. Expected: FAIL (extraction returns `API_KEY=…` context; guard/offsets missing). NOTE: the first two tests also depend on Task 2's patterns; they may fail on pattern grounds until Task 2 lands — Tasks 1+2 share one commit-gate: both done, then all tests pass.
- [ ] **Step 3: Implement** the four snippets above in `scanner.ts`.
- [ ] **Step 4+5:** proceed to Task 2 (same commit).

---

### Task 2: Pattern rewrite (full-identifier generics, whitespace-safe password-url)

**Files:**
- Modify: `src/lib/secrets/patterns.ts:514-580` (GENERIC_PATTERNS), export addition at bottom
- Test: `tests/lib/secrets/patterns-issue100.test.ts` (new)

**Interfaces:**
- Produces: `export const GENERIC_PATTERN_IDS: ReadonlySet<string>` (consumed by Task 3 overlap resolution). Named groups `name`, `qvalue`, `value` on the five rewritten patterns.

**The rewritten patterns** (exact regexes; keep ids/severities/descriptions):

```ts
// password-assignment (was quoted-only with optional close quote)
pattern:
  /(?<![A-Za-z0-9_-])(?<name>[A-Za-z0-9_-]{0,64}?(?:password|passwd|pwd|pass))\s*[=:]\s*(?:['"](?<qvalue>[^'"\r\n]{8,200})['"]|(?<value>[^\s'"]{8,200}))/gi,

// password-url — RFC 3986 userinfo cannot contain whitespace; excluding \s (and
// / in the user part) makes cross-line matches impossible (issue #100 RC4)
pattern: /:\/\/(?<user>[^:@/\s]{1,100}):(?<value>[^@\s]{8,200})@/g,

// api-key-assignment
pattern:
  /(?<![A-Za-z0-9_-])(?<name>[A-Za-z0-9_-]{0,64}?(?:api[_-]?key|apikey))\s*[=:]\s*(?:['"](?<qvalue>[A-Za-z0-9_-]{16,256})['"]|(?<value>[^\s'"]{16,256}))/gi,

// token-assignment (the [_-]?token suffix subsumes auth/access/bearer variants)
pattern:
  /(?<![A-Za-z0-9_-])(?<name>[A-Za-z0-9_-]{0,64}?token)\s*[=:]\s*(?:['"](?<qvalue>[A-Za-z0-9_.-]{20,256})['"]|(?<value>[^\s'"]{20,256}))/gi,

// secret-assignment
pattern:
  /(?<![A-Za-z0-9_-])(?<name>[A-Za-z0-9_-]{0,64}?(?:secret|secret[_-]?key))\s*[=:]\s*(?:['"](?<qvalue>[A-Za-z0-9_-]{16,256})['"]|(?<value>[^\s'"]{16,256}))/gi,
```

Rationale to preserve in comments: the lookbehind anchors the identifier start; the bounded lazy prefix `[A-Za-z0-9_-]{0,64}?` lets the keyword sit at the END of a longer identifier (`LAMBDA_API_KEY` matches whole — a bare lookbehind alone would stop detecting it entirely, RC2 done wrong); the required `\s*[=:]` is the right boundary so `API_KEY_FILE=` / `TOKENIZER=` never match; unquoted classes are non-whitespace-non-quote so dotted keys are captured whole (RC3).

**New export** (after ALL_SECRET_PATTERNS or near GENERIC_PATTERNS):

```ts
/** Ids of the low-specificity generic patterns — lose overlap ties to vendor patterns. */
export const GENERIC_PATTERN_IDS: ReadonlySet<string> = new Set(
  GENERIC_PATTERNS.map((p) => p.id)
);
```

- [ ] **Step 1: Write failing tests** — `tests/lib/secrets/patterns-issue100.test.ts`:

```ts
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
    const [m] = scanContent('db_url=postgres://admin:sup3rS3cretPW@db.example.com:5432/app');
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
```

- [ ] **Step 2: Run** `pnpm vitest run tests/lib/secrets/patterns-issue100.test.ts` — expect FAIL on current patterns.
- [ ] **Step 3: Implement** pattern replacements + `GENERIC_PATTERN_IDS` export.
- [ ] **Step 4: Run** both new test files + the existing secrets tests: `pnpm vitest run tests/lib/secrets/` — all pass. Fix any legacy-test fallout consciously (behavior changes to assert: full-identifier placeholders, guards). Do not weaken unrelated assertions.
- [ ] **Step 5: Commit** — `fix(secrets): extract correct capture group and match full identifiers (issue #100 RC1-RC4)`

---

### Task 3: Cross-pattern overlap resolution

**Files:**
- Modify: `src/lib/secrets/scanner.ts` (post-processing in `scanContent`, before the final sort at `:300`)
- Test: append to `tests/lib/secrets/scanner-extraction.test.ts`

**Interfaces:**
- Consumes: `SecretMatch.start/end` (Task 1), `GENERIC_PATTERN_IDS` (Task 2).

Implementation (insert before the line/column sort):

```ts
// Cross-pattern overlap resolution: one secret must yield ONE match. Vendor
// (specific) patterns beat GENERIC_PATTERNS; then the longer captured value
// wins (a truncated generic capture must not shadow a fuller one); then the
// earlier match. Without this, a GitHub PAT is ALSO reported by the generic
// token pattern and can end up stored under a generic placeholder (issue #100).
const isGeneric = (m: SecretMatch): number => (GENERIC_PATTERN_IDS.has(m.patternId) ? 1 : 0);
const byPriority = [...matches].sort(
  (a, b) => isGeneric(a) - isGeneric(b) || (b.end - b.start) - (a.end - a.start) || a.start - b.start
);
const kept: SecretMatch[] = [];
for (const m of byPriority) {
  if (kept.some((k) => m.start < k.end && k.start < m.end)) continue;
  kept.push(m);
}
matches.length = 0;
matches.push(...kept);
```

- [ ] **Step 1: Write failing test:**

```ts
it('vendor pattern beats generic on the same value (PAT not stored as TOKEN)', () => {
  const pat = 'github_pat_11ABCDEFG0123456789_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV';
  const hits = scanContent(`export GITHUB_FINE_GRAINED_TOKEN=${pat}`);
  expect(hits).toHaveLength(1);
  expect(hits[0].patternId).toBe('github-fine-grained-pat'); // check exact id in patterns.ts
});
```
(Verify the actual GitHub fine-grained pattern id/format in `patterns.ts` and adjust the fixture to match it.)

- [ ] **Step 2: Run** — expect FAIL (two matches today).
- [ ] **Step 3: Implement**, **Step 4: run `pnpm vitest run tests/lib/secrets/`**, **Step 5: Commit** — `fix(secrets): resolve overlapping matches, specific patterns beat generic`

---

### Task 4: Redaction plans + store-seeded placeholder reuse

**Files:**
- Modify: `src/lib/secrets/index.ts:154-215` (`processSecretsForRedaction`)
- Test: `tests/lib/secrets/redaction-plans.test.ts` (new)

**Interfaces:**
- Produces: `processSecretsForRedaction` keeps its signature `(results, tuckDir) => Promise<Map<string, Map<string, string>>>` but gains **store-seeded reuse**: before generating a new placeholder, consult the inverted existing store (`getAllSecrets`) so re-scanning the same value on a later run reuses its placeholder instead of minting `API_KEY_1`. This makes repeated scans idempotent — required once live files keep their secrets forever.

Implementation sketch (inside the function, before the loop):

```ts
// Seed reuse from the persisted store: same value -> same placeholder across
// runs. With repo-only redaction the live file keeps its secrets, so the same
// values are re-detected on every future scan; without seeding, each run would
// mint API_KEY_1, API_KEY_2, ... and orphan the earlier names.
const existing = await getAllSecrets(tuckDir);
const valueToExisting = new Map<string, string>();
for (const [name, value] of Object.entries(existing)) valueToExisting.set(value, name);
for (const name of Object.keys(existing)) usedPlaceholders.add(name);
```
and in the per-match reuse check, consult `valueToExisting.get(match.value)` first (before the cross-file map scan).

- [ ] **Step 1: failing test** (memfs/temp-dir per existing secrets tests' style — mirror `tests/lib/secrets/` setup):

```ts
it('re-processing the same value reuses the stored placeholder (idempotent)', async () => {
  const first = await processSecretsForRedaction(results, tuckDir);   // stores LAMBDA_API_KEY
  const second = await processSecretsForRedaction(results, tuckDir);  // must NOT mint LAMBDA_API_KEY_1
  expect([...second.get(livePath)!.values()]).toEqual([...first.get(livePath)!.values()]);
});
```

- [ ] **Step 2-4:** fail → implement → pass. **Step 5: Commit** — `fix(secrets): reuse stored placeholders across scans`

---

### Task 5: Repo-only redaction in the track pipeline

**Files:**
- Modify: `src/lib/trackPipeline.ts:73-…` (PreparedTrackFile), `:293-327` (redact branch, prompt hint)
- Modify: `src/commands/add.ts:47-70` (carry field across the PreparedTrackFile→FileToTrack mapping)
- Modify: `src/lib/fileTracking.ts:26-46` (FileToTrack), `:245-301` (apply plans after copy, symlink downgrade)
- Test: `tests/lib/trackPipeline-redaction.test.ts` or extend existing pipeline tests (match existing test layout under `tests/`)

**Interfaces:**
- Produces on both `PreparedTrackFile` and `FileToTrack`:

```ts
/** Redaction plans for secret-bearing files: applied to the REPO copy after
 *  the copy step; the live file is never modified (issue #100 RC5). For a
 *  tracked DIRECTORY, livePath points at the inner file that holds the secret. */
redactions?: Array<{
  livePath: string;
  matches: SecretMatch[];
  placeholderMap: Map<string, string>;
}>;
```

**trackPipeline.ts redact branch** (`:309-327`) — replace the `redactFile(result.path, …)` loop with plan attachment via the existing `ownerByScanPath` map (already built at `:258`):

```ts
const redactionMaps = await processSecretsForRedaction(summary.results, tuckDir);
let planned = 0;
for (const result of summary.results) {
  const placeholderMap = redactionMaps.get(result.path);
  if (!placeholderMap || placeholderMap.size === 0) continue;
  const owner = ownerByScanPath.get(result.path);
  if (!owner) continue;
  (owner.redactions ??= []).push({ livePath: result.path, matches: result.matches, placeholderMap });
  planned += result.matches.length;
}
console.log();
logger.success(`Will replace ${planned} secret(s) with placeholders in the repository copy`);
logger.dim('Your live files are left untouched');
logger.dim(`Secrets stored in: ${collapsePath(getSecretsPath(tuckDir))} (never committed)`);
```
Update the prompt hint at `:298` to: `'Repo copy gets placeholders; live file untouched. Originals in secrets.local.json (never committed)'`.

**add.ts**: in the PreparedTrackFile→FileToTrack mapping, add `if (f.redactions) trackedFile.redactions = f.redactions;`.

**fileTracking.ts**: right after the copy branches and BEFORE `const checksum = await getFileChecksum(destination);` (`:301`):

```ts
// Apply redaction plans to the REPO copy only (issue #100 RC5). Runs before
// the checksum so the manifest records the redacted content. Symlink strategy
// is downgraded per-file above; encrypted repo copies are ciphertext (already
// at-rest-protected) so plans are skipped for them.
if (file.redactions?.length && !encrypt) {
  for (const plan of file.redactions) {
    const liveAbs = expandPath(plan.livePath);
    const repoTarget =
      liveAbs === expandedPath
        ? destination
        : join(destination, relative(expandedPath, liveAbs));
    validatePathWithinRoot(repoTarget, tuckDir, 'redaction target');
    await redactFile(repoTarget, plan.matches, plan.placeholderMap);
  }
}
```
(Import `redactFile` from `../lib/secrets/index.js` — adjust relative path; reuse existing `validatePathWithinRoot` import if present, else import from its module — check `src/lib/paths.ts`.)

**Symlink downgrade** — before the strategy branch (`:247`):

```ts
// A symlinked live file IS the repo copy (same inode): redacting the repo copy
// would rewrite the user's live config — exactly what issue #100 forbids.
// Downgrade this file to copy strategy and say so.
let effectiveStrategy = strategy;
if (strategy === 'symlink' && file.redactions?.length) {
  effectiveStrategy = 'copy';
  logger.warning(
    `${collapsePath(file.path)}: tracked as a copy (not symlink) — placeholder redaction cannot apply to a symlinked file`
  );
}
```
Use `effectiveStrategy` in the branch at `:247` and in the manifest entry at `:314` (`strategy: isRepo ? 'copy' : effectiveStrategy`).

- [ ] **Step 1: failing integration test** (temp dir, real fs, non-interactive `secretHandling: 'redact'` if the pipeline supports it — check `PreparePathsForTrackingOptions.secretHandling` values in trackPipeline.ts; otherwise mock `prompts.select` to return `'redact'` as existing pipeline tests do):

```ts
it('leaves the live file untouched and redacts only the repo copy', async () => {
  const live = join(home, '.zshrc');
  const secretLine = 'export LAMBDA_API_KEY=secret_example_e3878cb6494b410eabc3e16d15a99b08.SecondHalfOfKey12345';
  await writeFile(live, `# comment\n${secretLine}\nalias ll="ls -la"\n`);
  const before = await readFile(live, 'utf-8');

  await trackWithRedaction(live, tuckDir); // helper wrapping prepare+track with redact choice

  expect(await readFile(live, 'utf-8')).toBe(before); // BYTE-IDENTICAL
  const repoCopy = await readFile(join(tuckDir, 'shell/.zshrc'), 'utf-8'); // verify actual dest path
  expect(repoCopy).toContain('export LAMBDA_API_KEY={{LAMBDA_API_KEY}}');
  expect(repoCopy).not.toContain('secret_example');
  expect(repoCopy).not.toContain('SecondHalfOfKey12345'); // no cleartext tail (RC3)
  // manifest checksum matches the REDACTED repo copy
  const manifest = await loadManifest(tuckDir);
  const entry = Object.values(manifest.files).find((f) => f.source === '~/.zshrc');
  expect(entry!.checksum).toBe(await getFileChecksum(join(tuckDir, 'shell/.zshrc')));
});
```

- [ ] **Step 2-4:** fail → implement → `pnpm vitest run` (full suite; the old live-rewriting tests will need updating to assert the NEW contract). **Step 5: Commit** — `fix(track): redact repository copy only, never the live file (issue #100 RC5)`

---

### Task 6: Repo-only redaction in sync

**Files:**
- Modify: `src/commands/sync.ts:649-680` (redact branch), `:500-530` (copy loop), `scanAndHandleSecrets` signature/callsite, prompt label at `:640`
- Test: extend sync tests (find existing under `tests/commands/sync*`)

**Interfaces:**
- `scanAndHandleSecrets` returns `Promise<{ proceed: boolean; redactionPlans: RedactionPlan[] }>` where

```ts
interface RedactionPlan {
  livePath: string; // scan-result live path
  matches: SecretMatch[];
  placeholderMap: Map<string, string>;
}
```
All existing `return true/false` sites become `{ proceed: true, redactionPlans: [] }` etc. The redact branch builds plans (via `processSecretsForRedaction`, no `redactFile` on live paths) instead of rewriting files, and its success copy says the live files are untouched.

- In the caller, thread `redactionPlans` to the copy loop.
- In the copy loop (after `copyFileOrDir` at `:518`, before `getFileChecksum(destPath)` at `:522`): apply every plan whose `livePath` equals `sourcePath` or lies under it (directory), same repo-target mapping as Task 5.
- Same-inode guard: the loop already computes `pathsResolveToSameLocation(sourcePath, destPath)` — when TRUE and plans exist for this file, do NOT redact (it would rewrite the live file); instead `logger.warning` that a symlink-tracked file cannot be redacted and its secrets are already in the repo working tree (they share the inode), suggesting `tuck add --no-symlink`-style re-tracking (check actual flag name; if none, phrase as "re-track with copy strategy").
- Prompt label at `:640` → `'Redact secrets (placeholders in repo copy; live file untouched)'`.

- [ ] **Step 1: failing test** — sync a tracked file after appending a secret line; assert live file unchanged, repo copy redacted, manifest checksum == repo checksum.
- [ ] **Step 2-4:** fail → implement → full suite. **Step 5: Commit** — `fix(sync): redact repository copy only during sync (issue #100 RC5)`

---

### Task 7: Placeholder-aware drift detection

**Files:**
- Modify: `src/lib/secrets/redactor.ts` (new helpers), `src/lib/secrets/index.ts` (re-export)
- Modify: `src/commands/sync.ts:148-172` (detectChanges), `src/lib/stateModel.ts:169-171`, `src/commands/diff.ts:209-217` (+ dir branch `:136-139`)
- Test: `tests/lib/secrets/redacted-checksum.test.ts` (new) + one assertion each in sync/status/diff tests

**Interfaces (produces):** in `redactor.ts`:

```ts
/** Invert the secrets store: secret value -> placeholder name. Empty map when
 *  no secrets are stored (callers use that as the "skip entirely" fast path). */
export const getStoredValueMap = async (tuckDir: string): Promise<Map<string, string>>;

/**
 * Checksum a live path AS IF its known secrets were redacted — i.e. the
 * checksum its repo copy would have after a sync. Mirrors files.ts
 * getFileChecksum exactly (same dir algorithm: sorted `relPath\0contentHash`
 * lines) but replaces known secret values with their placeholders first.
 * Files whose bytes contain none of the values hash their RAW buffer, so the
 * result is byte-identical to getFileChecksum for non-secret files (binary
 * files are untouched by the utf-8 path).
 */
export const getRedactedChecksum = async (
  livePath: string,
  valueMap: Map<string, string>
): Promise<string>;
```

Implementation notes:
- Per file: read Buffer; `const text = buf.toString('utf8')`; if no map key is included in `text`, hash the raw buffer; else replace values longest-first via the same split/join used by `redactContent` (`formatPlaceholder(name)`), hash the utf-8 string. Longest-first matters for the substring-secret case (see redactor.ts:120-124 comment).
- Directory algorithm must byte-match `files.ts:98-120` — reuse `getDirectoryFiles` (check it is exported from files.ts; export it if not).

**Wiring (all three sites share the pattern: raw mismatch → redacted compare → equal means clean):**

1. `sync.ts detectChanges` — load `const valueMap = await getStoredValueMap(tuckDir)` once before the loop; inside the mismatch branch at `:151`:

```ts
if (sourceChecksum !== file.checksum) {
  if (valueMap.size > 0 && (await getRedactedChecksum(sourcePath, valueMap)) === file.checksum) {
    continue; // live differs from repo ONLY by placeholder substitution — clean
  }
  changes.push({ ... });
}
```

2. `stateModel.ts computeFileState` final classification (`:169-170`): when `classifyFileState` returns `'drift-local'` for a plain (non-template/encrypted) entry and the store is non-empty, recompute with `getRedactedChecksum(sourceAbs, valueMap)`; if it equals `repoChecksum`, classify `'ok'` (or `'drift-repo'` when `repoChecksum !== file.checksum`). Build the valueMap once in `computeStateModel` (`:174-182`) and thread it through like `ctx`.

3. `diff.ts getFileDiff` (`:209-217` and the directory compare at `:136-139`): replace `getFileChecksum(systemPath)` with the redacted variant when the store is non-empty, and for the text-content branch diff the REDACTED live content (`redact values in systemContent before display`) — this both removes false diffs and stops printing cleartext secrets in `tuck diff` output.

- [ ] **Step 1: failing tests:**

```ts
it('redacted checksum of live == checksum of redacted repo copy', async () => {
  // write live with secret; write repo copy via redactContent; valueMap from store
  expect(await getRedactedChecksum(livePath, valueMap)).toBe(await getFileChecksum(repoPath));
});
it('returns raw checksum when no stored value occurs in the file', async () => {
  expect(await getRedactedChecksum(cleanPath, valueMap)).toBe(await getFileChecksum(cleanPath));
});
it('sync detectChanges reports clean after redacting sync (no perpetual drift)', ...);
it('a non-secret edit is still reported modified', ...);
```

- [ ] **Step 2-4:** fail → implement → full suite. **Step 5: Commit** — `fix(secrets): placeholder-aware change detection for sync/status/diff`

---

### Task 8: Final verification sweep

- [ ] `pnpm lint && pnpm typecheck && pnpm test` — all green.
- [ ] `pnpm build && node dist/index.js --help` — CLI boots.
- [ ] Manual end-to-end in a sandbox HOME (scripted, not interactive): init tuck, write a `.zshrc` with the issue's two fixture lines + the p10k block, track with redact, assert: live byte-identical; repo redacted with `{{LAMBDA_API_KEY}}`/`{{CONTEXT7_API_KEY}}`; zero matches in p10k block; `tuck status` clean; append `alias x=y` to live `.zshrc`; `tuck status` shows modified.
- [ ] Grep the diff for leftovers: `git diff origin/development --stat`, no stray debug output, no `any`.

## Out of scope (do NOT implement)

`tuck secrets restore` CLI surface; cross-machine placeholder materialization gaps; history rewriting. These are follow-up issues.
