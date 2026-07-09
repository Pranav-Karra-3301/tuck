# Design: Fix secret redaction (issue #100)

**Date:** 2026-07-09
**Issue:** https://github.com/Pranav-Karra-3301/tuck/issues/100
**Branch:** `fix/issue-100-secret-redaction` → PR into `development`

## Problem

Choosing "Replace with placeholders" during `tuck add`/`tuck scan`/`tuck sync`:

1. Rewrites the **live** dotfile in `$HOME` with `{{PLACEHOLDER}}` strings, breaking
   executable config (zsh aborts sourcing `.zshrc` at `export LAMBDA_{{API_KEY}}...`).
2. Extracts the wrong match text (`match[1] || match[0]` ignores capture group 2),
   so redaction eats identifier/`=` context instead of the secret value.
3. Stops matching unquoted values at `.`, leaving the tail of dotted secrets in
   cleartext — which then gets **committed**.
4. Lets `password-url` match across newlines, corrupting unrelated lines
   (stock `~/.p10k.zsh` comments flagged as critical secrets).
5. Matches bare keywords mid-identifier (`API_KEY` inside `LAMBDA_API_KEY`),
   mangling names and confusing placeholder naming.

## Decisions (from design interview)

| Decision | Choice |
|---|---|
| Where redaction happens | **Repo copy only.** Live files are never written by redaction. |
| PR scope | All 5 root causes, one PR. `tuck secrets restore` CLI surface deferred. |
| Unquoted value class | Non-whitespace-non-quote, bounded, with post-match non-secret guards. |
| Drift detection | Redact live content **in memory** with known mappings, compare checksums. |
| Placeholder naming | Full captured identifier (`{{LAMBDA_API_KEY}}`), fallback to pattern default. |

## Design

### 1. Value extraction (`src/lib/secrets/scanner.ts`)

Generic patterns adopt **named capture groups**: `(?<name>…)` for the identifier,
`(?<qvalue>…)`/`(?<value>…)` for quoted/unquoted values. Extraction order:
`groups.qvalue ?? groups.value` → first *defined* numbered group → `match[0]`.
Use `??` (not `||`) so empty-string captures don't fall through. Old-style and
user-supplied custom patterns keep working via the numbered-group fallback.

### 2. Pattern rewrite (`src/lib/secrets/patterns.ts`)

- `api-key-assignment`, `token-assignment`, `secret-assignment`,
  `password-assignment`: match the **full identifier ending in the keyword**
  (`LAMBDA_API_KEY` matches whole; `TOKENIZER_CONFIG` does not match — the
  required `\s*[=:]` is the right boundary, a left guard plus optional
  identifier-prefix capture is the left one).
- Placeholder derived from `groups.name` (uppercased, sanitized to
  `[A-Z0-9_]`); pattern-default placeholder when no name (e.g. `Bearer`).
- Unquoted value classes become bounded `[^\s'"]{N,256}` (existing minimum
  lengths and ReDoS upper bounds preserved).
- Post-match `isLikelyNonSecret(value)` guard in the scanner drops values
  starting with `$`, `~`, `/`, `./`, or `{{` (env refs, paths, placeholders).
- `password-url`: `[^:/\s]` / `[^@\s]` classes so the match can never span
  lines or whitespace (RFC 3986 userinfo cannot contain whitespace).

### 3. Cross-pattern overlap resolution (scanner)

After collecting matches from all patterns, resolve overlapping ranges:
**specific pattern beats generic** (generic = membership in `GENERIC_PATTERNS`),
then **longer value wins**. Fixes a GitHub PAT being stored as generic `TOKEN`
and prevents one value getting two placeholders.

### 4. Repo-only redaction (`src/lib/trackPipeline.ts`, `src/commands/sync.ts`)

`applySecretPolicy` / sync's secret handler stop calling `redactFile()` on the
live path. They return a **redaction plan** (per-file matches + placeholder map);
the pipeline applies it to the **repo destination file right after the copy and
before the manifest checksum is computed**. `redactFile()` stays path-based and
unchanged — it is pointed at the repo copy. The live file is never written.
The "Replace with placeholders" prompt hint says so.

### 5. Placeholder-aware drift detection (`sync.ts`, `stateModel.ts`, `diff.ts`)

Shared helper: when raw checksums differ, redact the live content in memory
using **all** stored value→placeholder mappings from `secrets.local.json` and
compare that checksum instead. Raw-equal remains the fast path (equal ⇒ clean,
no secret work). "Modified" therefore means "a sync would actually change the
repo copy". New secrets still surface as modified and enter the scan prompt.

## Testing

Fixtures taken verbatim from the issue:

- `export LAMBDA_API_KEY=secret_…e16d15a99b08.SecondHalfOfKey12345` — full value
  captured, placeholder `{{LAMBDA_API_KEY}}`, no cleartext tail.
- Five-line p10k comment block — `password-url` produces **no** match.

Key assertions:

- Live file is byte-identical after track/sync with redaction chosen.
- Repo copy fully redacted; manifest checksum equals repo copy checksum.
- `TOKENIZER`/mid-identifier keywords do not match; prefixed identifiers do.
- Guards skip `$VAR`, `~/path`, `/path`, `./rel`, `{{PLACEHOLDER}}` values.
- Empty-string capture does not fall back to `match[0]` (`??` semantics).
- Specific vendor pattern wins over generic on the same value.
- Second sync after redaction reports clean; a non-secret live edit reports modified.
- New pattern regexes pass existing ReDoS/timeout guards on pathological input.

## Out of scope (follow-ups)

- Surfacing `tuck secrets restore` (repair for v1.9.0 victims).
- Cross-machine gap: `apply` writes literal placeholders when no secret backend
  is mapped; machine-B perpetual drift without local mappings.
- PR description must note: half-committed secrets require **key rotation**;
  release also ships the already-merged `validateDescription` fix to npm.
