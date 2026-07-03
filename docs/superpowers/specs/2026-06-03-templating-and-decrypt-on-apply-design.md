# Templating + Decrypt-on-Apply — Design Spec (2026-06-03)

> Status: **approved** (brainstorming, 2026-06-03). Implements P0-1 and P0-2 from
> `docs/CHEZMOI-PARITY-AUDIT-2026-06.md`. Scope guidance from the user: **smallest
> change that is still safe** — "apply-only" plus the minimal guards required so we
> never silently lose data or leak secrets (tuck's Critical Rules).

## 1. Problem

tuck already ships a complete, tested template engine (`src/lib/template.ts`) and a
complete file-encryption subsystem (`src/lib/crypto/fileEncryption.ts`, TCKE1 /
AES-256-GCM, plus a per-OS keystore). **Neither is wired into the lifecycle:**

- `renderTemplate` is referenced only by `template.ts` and `preset.ts` — **never by
  `apply.ts` or `restore.ts`**. The manifest `template` flag is hardcoded `false`
  (`fileTracking.ts:282`) and never read at apply time.
- `apply.ts` contains no decrypt path, so an encrypted repo file (TCKE1 ciphertext)
  would be written to the live system **as raw ciphertext**.

So tuck's flagship "one repo, many machines" capability and its whole-file encryption
do not actually work for tracked dotfiles.

### The bidirectional hazard (why this needs a guard, not just a wire-up)

tuck keeps **live ↔ repo** in sync bidirectionally. For a *materialized* file the
repo holds the **source** (template text / ciphertext) and the live file holds the
**materialized output** (rendered text / plaintext) — they intentionally differ.
`sync.detectChanges` compares `checksum(live)` vs `checksum(repo)`
(`sync.ts:136`); for these files that always differs, so `syncFiles` would copy the
live file back over the repo source (`sync.ts:484`):

- **template** → the rendered output (with this machine's `os`, `hostname`, …) overwrites
  the `{{ }}` source. Source destroyed → violates *"never lose data / never silently overwrite."*
- **encrypted** → **plaintext** is written into the repo. Secret leak → violates
  *"never store secrets."*

Therefore wiring rendering/decryption into `apply` **requires** a matching guard on the
capture (live→repo) side. That guard is the only deviation from a literal "apply-only" change.

## 2. Goals / Non-goals

**Goals (P0)**
- `tuck apply` and `tuck restore` render `template:true` files and decrypt `encrypted:true`
  files before writing to the live system.
- `tuck add --template` / `tuck add --encrypt` set the manifest flags (and `--encrypt`
  stores TCKE1 ciphertext in the repo).
- `tuck sync` never captures `template`/`encrypted` files live→repo (one-directional;
  warns). This is the safety guard.
- `tuck status` / `tuck verify` compare these files as `live vs materialize(repo)` so they
  do not show as permanent false drift, and a stale template surfaces as "needs apply."

**Non-goals (explicit fast-follows, NOT this spec)**
- `tuck edit` (decrypt→edit→re-encrypt loop) — separate P1 item.
- Re-encrypt-on-sync / auto-reverse-templating (bidirectional capture for materialized files).
- A dedicated `.tuckdata.{yaml,toml,json}` machine-data file — separate P1.
- age/GPG interop, autotemplate (auto-substitution on add), binary-file encryption.

## 3. Model (the decision)

**Materialized files are repo-authoritative and one-directional.** The repo copy is the
source of truth; the live file is a derived artifact recomputed by `apply`/`restore`.
You change such a file by editing the **repo source** (directly today; via `tuck edit`
later) and running `apply`. `sync` will not capture live edits to them (it warns and
points you at the source). This matches `template.ts`'s own header comment ("the file
tracked in the repo is always the templated source") and chezmoi's source→target model.

## 4. Architecture

One shared transform converts a repo file into its live form. Both `apply` and `restore`
single-file writes route through it; `stateModel` uses it to compute the expected live
content for comparison.

### 4.1 New module: `src/lib/materialize.ts`

```ts
import type { TrackedFileOutput } from '../schemas/manifest.schema.js';
import type { TemplateContext } from './template.js';

export interface MaterializeDeps {
  /** Returns the file-encryption passphrase, or null if none is configured/available. */
  getPassphrase: () => Promise<string | null>;
}

/**
 * Convert a repo file's raw bytes into the content that should land on the live
 * system. Order: decrypt → render template. Secret-placeholder resolution stays
 * in apply (it already runs there) and happens after this step.
 *
 * Throws MaterializeError on a required-but-failed decryption (wrong/absent
 * passphrase, bad ciphertext) — the caller must NOT write partial/ciphertext output.
 */
export const materializeForLive = async (
  repoBytes: Buffer,
  file: Pick<TrackedFileOutput, 'template' | 'encrypted' | 'source'>,
  ctx: TemplateContext,
  deps: MaterializeDeps
): Promise<string> => {
  let bytes = repoBytes;
  if (file.encrypted || isEncryptedFile(repoBytes)) {
    const pass = await deps.getPassphrase();
    if (!pass) throw new MaterializeError(file.source, 'no encryption password configured');
    bytes = await decryptFileContent(bytes, pass); // throws DecryptionError on failure
  }
  let text = bytes.toString('utf8');
  if (file.template) text = renderTemplate(text, ctx);
  return text;
};
```

Notes:
- Single-file, text-oriented (dotfiles are text; matches apply's existing `readFile(..,'utf-8')`
  assumption). Directories and binary files are not materialized (copied verbatim, as today).
- `isEncryptedFile` is also checked defensively so a mislabeled file still decrypts rather
  than shipping ciphertext.
- A tiny `MaterializeError` is added to `errors.ts` (extends `TuckError`) so callers can
  fail one file loudly with the path and a remedy, without aborting the whole apply.

### 4.2 Passphrase source

`getPassphrase` = `(await getKeystore()).retrieve(TUCK_SERVICE, TUCK_ACCOUNT)`
(`crypto/keystore`). This is the single "encryption password" tuck already stores per-OS.
`null` means none is set → encrypted files fail with "run `tuck encryption setup`". (The dead
scrypt backup scheme in `crypto/manager.ts` is untouched and out of scope.)

### 4.3 Template context

`defaultTemplateContext(config.templates.variables)` — the existing built-ins
(`os, arch, hostname, user, home, ci`) merged with the user's `config.templates.variables`
(`config.schema.ts:71`, a `Record<string,string>`, currently inert). Built once per
command and threaded in.

## 5. Component changes

| File | Change |
|---|---|
| `src/lib/materialize.ts` (new) | `materializeForLive` + `MaterializeError`. |
| `src/commands/apply.ts` | In `applyWithMerge`/`applyWithReplace`, replace `readFile(repoPath,'utf-8')` with `materializeForLive(readFile(repoPath), file, ctx, deps)`; keep the existing `resolveFileSecrets` step **after** it. Build `ctx` + `getPassphrase` once at command entry. On `MaterializeError`/`DecryptionError`: record the file as failed, never write. |
| `src/commands/restore.ts` | Route single-file writes (`restore.ts:282`) through `materializeForLive` instead of raw `copyFileOrDir`; directories still copy verbatim. Same error handling. |
| `src/commands/add.ts` + `src/lib/fileTracking.ts` | Add `--template` / `--encrypt` options (un-comment `fileTracking.ts:59-68`); thread through `trackFilesWithProgress`. Set `template`/`encrypted` in the manifest instead of hardcoded `false` (`:281-282`). When `--encrypt`: encrypt the bytes with the keystore passphrase before writing to the repo; `checksum` is of the stored (cipher)text, as today. Refuse `--encrypt` with a clear error if no passphrase is set. |
| `src/commands/sync.ts` | In `detectChanges` (`sync.ts:90`), skip files where `file.template || file.encrypted` from live→repo capture; push a JSON-mode-safe warning ("X is template/encrypted; edit the repo source and run `tuck apply`"). |
| `src/lib/stateModel.ts` | In `computeFileState`, for `template`/`encrypted` files compare `liveChecksum` against `checksum(materializeForLive(repoBytes, …))` rather than the raw `repoChecksum`; keep the raw `repoChecksum` vs `manifestChecksum` check for `drift-repo`. If the passphrase is unavailable for an encrypted file, degrade to "ok-by-presence" (both sides exist → `ok`) rather than throwing. Template-only files need no passphrase (render is pure). When such a file differs from `materialize(repo)` it classifies as `drift-local`, but `status`/`verify` must present its remedy as **`tuck apply`** (re-render/re-decrypt), not `tuck sync` — since `sync` intentionally skips these files. |
| `src/schemas/manifest.schema.ts` | No change — `template`/`encrypted` already exist (`:11-12`). |
| `src/errors.ts` | Add `MaterializeError`. |

## 6. Error handling

- Decrypt failure (wrong/absent passphrase, corrupt ciphertext) → fail **that file** with
  its path + remedy; never write ciphertext-as-plaintext or partial output. Apply continues
  with other files and reports the failure (and a non-zero summary).
- Template render is total (never throws; unbalanced blocks flush verbatim — see
  `template.ts:129`), so rendering cannot abort an apply.
- `stateModel` never throws on a locked keystore (degrades as above) — `status`/`verify`
  stay usable offline.

## 7. Testing plan (TDD — write tests first)

Unit (`tests/lib/materialize.test.ts`):
- render-only: `{{os}}` / `tuck:if` substituted using ctx.
- decrypt-only: a TCKE1 buffer with the right passphrase → plaintext; wrong passphrase → throws, no output.
- encrypted **and** template: decrypt then render (order asserted).
- no passphrase + encrypted → `MaterializeError`, nothing written.

Command/integration:
- `apply`: a `template:true` repo file lands rendered (`{{os}}` → real platform) in a temp HOME.
- `apply`: a TCKE1 `encrypted:true` repo file lands **decrypted** on disk (not ciphertext).
- `restore`: same two assertions (proves apply/restore parity through the shared helper).
- **sync-skip (the safety test)**: add a template file, edit its live copy, run `sync`,
  assert the **repo source is byte-unchanged** and a warning was emitted.
- `add --template` / `add --encrypt`: manifest flags set; `--encrypt` stores TCKE1 ciphertext
  (round-trips via decrypt); `--encrypt` with no passphrase errors.
- `stateModel`/`status`: a correctly-applied template file reports `ok` (not false `drift-local`);
  an edited live template reports drift (needs apply).

Gate: `pnpm typecheck && pnpm lint && pnpm test` green before commit; keep existing 831 tests passing.

## 8. Risks & mitigations

- **Binary/non-UTF-8 encrypted files**: out of scope; the transform is text-oriented and such
  files should be tracked without `--encrypt`/`--template` (documented limitation).
- **stateModel keystore dependency**: mitigated by the "ok-by-presence" degrade path; template-only
  files (the common case) need no keystore.
- **Behavior change for would-be template/encrypted files**: none today, because the flags were
  never settable; this spec is the first path that sets them, so there is no migration concern.

## 9. Out of scope (tracked fast-follows)

`tuck edit`, re-encrypt-on-sync (bidirectional encrypted capture), `.tuckdata` machine-data file,
age/GPG interop, autotemplate-on-add. Each is a separate roadmap item.
