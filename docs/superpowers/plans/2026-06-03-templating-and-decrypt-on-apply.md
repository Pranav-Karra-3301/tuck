# Templating + Decrypt-on-Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `template:true` files render and `encrypted:true` files decrypt when written to the live system by `tuck apply`/`tuck restore`, expose `tuck add --template/--encrypt`, and stop `tuck sync` from clobbering the repo source of these one-directional files.

**Architecture:** A single shared `materializeForLive(repoBytes, file, ctx, deps)` transform (decrypt → render) is the only place repo→live content conversion happens. `apply` and `restore` route single-file writes through it; `stateModel` uses it to compute the expected live content so status/verify don't show false drift; `sync.detectChanges` skips materialized files (capture is one-directional). The read side (decrypt/render) is built before the write side (`add --encrypt`) so encryption can never create a file the apply path can't decrypt.

**Tech Stack:** TypeScript (ESM, strict), Vitest, Node crypto (AES-256-GCM/PBKDF2 via existing `fileEncryption.ts`), per-OS keystore (`crypto/keystore`), `renderTemplate` (`lib/template.ts`).

Reference spec: `docs/superpowers/specs/2026-06-03-templating-and-decrypt-on-apply-design.md`.

---

## File Structure

- **Create** `src/lib/materialize.ts` — the repo→live transform + `MaterializeError`-using logic. One responsibility: "given repo bytes + a tracked-file's flags + context, produce the bytes that belong on the live system."
- **Modify** `src/errors.ts` — add `MaterializeError extends TuckError`.
- **Modify** `src/commands/apply.ts` — thread `TemplateContext` + `getPassphrase` into `applyWithMerge`/`applyWithReplace`; materialize before `resolveFileSecrets`; ensure `ApplyFile` carries `template`/`encrypted`.
- **Modify** `src/commands/restore.ts` — materialize single-file writes (currently a raw `copyFileOrDir`).
- **Modify** `src/lib/stateModel.ts` — compare materialized files as `live vs materialize(repo)`, degrade gracefully when the keystore is locked.
- **Modify** `src/commands/sync.ts` — `detectChanges` skips `template||encrypted` files with a warning.
- **Modify** `src/commands/add.ts` + `src/types.ts` + `src/lib/fileTracking.ts` — `--template`/`--encrypt` flags; encrypt-on-store; set manifest flags.
- **Create** tests alongside: `tests/lib/materialize.test.ts`, plus additions to `tests/commands/{apply,restore,sync,add}.test.ts` and `tests/lib/stateModel.test.ts`.

Conventions to follow: existing tests use Vitest + `tests/utils/factories.ts` + `tests/utils/testHelpers.ts` (temp HOME / temp tuck dir). Mirror the closest existing test file for setup.

---

## Task 1: `materializeForLive` foundation + `MaterializeError`

**Files:**
- Modify: `src/errors.ts`
- Create: `src/lib/materialize.ts`
- Test: `tests/lib/materialize.test.ts`

- [ ] **Step 1: Add the error class** in `src/errors.ts` next to the other `TuckError` subclasses:

```ts
export class MaterializeError extends TuckError {
  constructor(source: string, reason: string) {
    super(
      `Cannot materialize ${source}: ${reason}`,
      'MATERIALIZE_FAILED',
      ['Check the encryption password (tuck encryption setup)', 'Verify the repo file is not corrupted']
    );
  }
}
```
(Match the exact `TuckError` constructor signature already used in the file — adjust arg order if it differs, e.g. `(message, code, suggestions)`.)

- [ ] **Step 2: Write the failing test** `tests/lib/materialize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { materializeForLive } from '../../src/lib/materialize.js';
import { encryptFileContent } from '../../src/lib/crypto/fileEncryption.js';
import { MaterializeError } from '../../src/errors.js';

const ctx = { os: 'darwin', hostname: 'mac1' };
const deps = (pass: string | null = 'pw') => ({ getPassphrase: async () => pass });

describe('materializeForLive', () => {
  it('renders a template file using the context', async () => {
    const repo = Buffer.from('host={{hostname}} os={{os}}');
    const out = await materializeForLive(repo, { template: true, encrypted: false, source: '~/.x' }, ctx, deps());
    expect(out).toBe('host=mac1 os=darwin');
  });

  it('passes plain non-template files through unchanged', async () => {
    const repo = Buffer.from('literal {{not-a-var-because-not-template}}');
    const out = await materializeForLive(repo, { template: false, encrypted: false, source: '~/.x' }, ctx, deps());
    expect(out).toBe('literal {{not-a-var-because-not-template}}');
  });

  it('decrypts an encrypted file', async () => {
    const repo = await encryptFileContent(Buffer.from('secret-body'), 'pw');
    const out = await materializeForLive(repo, { template: false, encrypted: true, source: '~/.s' }, ctx, deps('pw'));
    expect(out).toBe('secret-body');
  });

  it('decrypts THEN renders for encrypted+template files', async () => {
    const repo = await encryptFileContent(Buffer.from('os={{os}}'), 'pw');
    const out = await materializeForLive(repo, { template: true, encrypted: true, source: '~/.s' }, ctx, deps('pw'));
    expect(out).toBe('os=darwin');
  });

  it('throws MaterializeError when an encrypted file has no passphrase', async () => {
    const repo = await encryptFileContent(Buffer.from('x'), 'pw');
    await expect(
      materializeForLive(repo, { template: false, encrypted: true, source: '~/.s' }, ctx, deps(null))
    ).rejects.toBeInstanceOf(MaterializeError);
  });

  it('throws on wrong passphrase (never returns ciphertext)', async () => {
    const repo = await encryptFileContent(Buffer.from('x'), 'right');
    await expect(
      materializeForLive(repo, { template: false, encrypted: true, source: '~/.s' }, ctx, deps('wrong'))
    ).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm vitest run tests/lib/materialize.test.ts`
Expected: FAIL — `materializeForLive` not found.

- [ ] **Step 4: Implement** `src/lib/materialize.ts`:

```ts
import type { TrackedFileOutput } from '../schemas/manifest.schema.js';
import { renderTemplate, type TemplateContext } from './template.js';
import { isEncryptedFile, decryptFileContent } from './crypto/fileEncryption.js';
import { MaterializeError } from '../errors.js';

export interface MaterializeDeps {
  /** Returns the file-encryption passphrase, or null if none is configured/available. */
  getPassphrase: () => Promise<string | null>;
}

export type MaterializableFile = Pick<TrackedFileOutput, 'template' | 'encrypted' | 'source'>;

/**
 * Convert a repo file's raw bytes into the content that belongs on the live
 * system. Order: decrypt -> render template. Secret-placeholder resolution stays
 * in apply and runs AFTER this step. Text-oriented (dotfiles are text); callers
 * handle directories/binary separately.
 */
export const materializeForLive = async (
  repoBytes: Buffer,
  file: MaterializableFile,
  ctx: TemplateContext,
  deps: MaterializeDeps
): Promise<string> => {
  let bytes = repoBytes;
  if (file.encrypted || isEncryptedFile(repoBytes)) {
    const pass = await deps.getPassphrase();
    if (!pass) throw new MaterializeError(file.source, 'no encryption password configured');
    try {
      bytes = await decryptFileContent(bytes, pass);
    } catch (err) {
      throw new MaterializeError(file.source, err instanceof Error ? err.message : 'decryption failed');
    }
  }
  let text = bytes.toString('utf8');
  if (file.template) text = renderTemplate(text, ctx);
  return text;
};

/** Shared passphrase getter: the single per-OS keystore "encryption password". */
export const keystorePassphrase = async (): Promise<string | null> => {
  const { getKeystore, TUCK_SERVICE, TUCK_ACCOUNT } = await import('./crypto/keystore/index.js');
  return (await getKeystore()).retrieve(TUCK_SERVICE, TUCK_ACCOUNT);
};
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run tests/lib/materialize.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: typecheck + commit**

```bash
pnpm typecheck
git add src/lib/materialize.ts src/errors.ts tests/lib/materialize.test.ts
git commit -m "feat(materialize): add repo->live decrypt+render transform

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire materialize into `apply` (render + decrypt on apply)

**Files:**
- Modify: `src/commands/apply.ts` (ApplyFile interface; `applyWithMerge`/`applyWithReplace`; both call sites at ~1050 and ~1170)
- Test: `tests/commands/apply.test.ts`

- [ ] **Step 1: Write failing tests** in `tests/commands/apply.test.ts` (follow the file's existing temp-HOME/manifest setup; craft repo files + a manifest with the flags set, then run the apply path):

```ts
it('renders a template file on apply (P0-1)', async () => {
  // Arrange: repo file containing {{os}}, manifest entry template:true (use factories).
  // Act: run the apply/replace path against a temp HOME.
  // Assert: the written live file contains process.platform, NOT the literal "{{os}}".
});

it('decrypts an encrypted file on apply (P0-2)', async () => {
  // Arrange: repo file = encryptFileContent("plain-body","pw"); manifest encrypted:true;
  //          stub keystorePassphrase()/getPassphrase to return "pw".
  // Assert: the written live file equals "plain-body" (decrypted), not ciphertext.
});
```
(Use the same stubbing approach the suite already uses for keystore/secret backends; assert on file contents read back from the temp HOME.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/commands/apply.test.ts`
Expected: FAIL — template literal still present / file is ciphertext.

- [ ] **Step 3: Implement.** (a) Ensure `ApplyFile` includes `template: boolean` and `encrypted: boolean`, populated by `prepareFilesToApply` from the manifest entry. (b) Build context + passphrase getter once and pass them into both apply functions:

```ts
// near the top of apply.ts
import { materializeForLive, keystorePassphrase } from '../lib/materialize.js';
import { renderTemplate, defaultTemplateContext } from '../lib/template.js';
import { loadConfig } from '../lib/config.js';
import { MaterializeError } from '../errors.js';

// helper used by both apply functions:
const buildMaterializeCtx = async (tuckDir: string) => {
  const config = await loadConfig(tuckDir);
  return defaultTemplateContext(config.templates?.variables ?? {});
};
```

In `applyWithMerge` and `applyWithReplace`, replace the single-file read:

```ts
// BEFORE:
let fileContent = await readFile(file.repoPath, 'utf-8');
// AFTER:
let fileContent: string;
try {
  const raw = await readFile(file.repoPath);
  fileContent = await materializeForLive(raw, file, ctx, { getPassphrase: keystorePassphrase });
} catch (err) {
  if (err instanceof MaterializeError) {
    logger.warning?.(err.message);
    result.filesWithPlaceholders.push({ path: collapsePath(file.destination), placeholders: ['<decrypt-failed>'] });
    continue; // never write ciphertext/partial output
  }
  throw err;
}
```
Thread `ctx` in by changing the signatures to `applyWith*(files, dryRun, ctx)` and building `ctx = await buildMaterializeCtx(getTuckDir())` at both call sites (~1050, ~1170) before dispatch. The existing `resolveFileSecrets` call stays immediately after (secrets resolve on the already-rendered/decrypted text).

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/commands/apply.test.ts`
Expected: PASS (new + existing apply tests).

- [ ] **Step 5: commit**

```bash
pnpm typecheck
git add src/commands/apply.ts tests/commands/apply.test.ts
git commit -m "feat(apply): render templates and decrypt encrypted files on apply (P0-1/P0-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire materialize into `restore` (parity with apply)

**Files:**
- Modify: `src/commands/restore.ts` (single-file write at ~282; `prepareFilesToRestore` to carry flags)
- Test: `tests/commands/restore.test.ts`

- [ ] **Step 1: Write failing tests** mirroring Task 2's two assertions but via the restore path (template renders; encrypted decrypts).

- [ ] **Step 2: Run, verify fail** — `pnpm vitest run tests/commands/restore.test.ts` → FAIL.

- [ ] **Step 3: Implement.** For single (non-directory) files, replace the raw copy:

```ts
// restore.ts, single-file branch (~282)
// BEFORE: await copyFileOrDir(file.destination /* repo copy */, targetPath, { overwrite: true });
// AFTER:
if ((await stat(repoCopyPath)).isDirectory()) {
  await copyFileOrDir(repoCopyPath, targetPath, { overwrite: true });
} else {
  const raw = await readFile(repoCopyPath);
  const content = await materializeForLive(raw, file, ctx, { getPassphrase: keystorePassphrase });
  await ensureDir(dirname(targetPath));
  await writeFile(targetPath, content, 'utf-8');
}
```
Build `ctx` once in the restore entry (same `buildMaterializeCtx` helper — export it from a shared spot or duplicate the 2-line build). Carry `template`/`encrypted` onto the restore file descriptor from the manifest. Wrap in the same `MaterializeError` guard (log + skip the one file, never write ciphertext).

- [ ] **Step 4: Run, verify pass** — `pnpm vitest run tests/commands/restore.test.ts` → PASS.

- [ ] **Step 5: commit**

```bash
pnpm typecheck
git add src/commands/restore.ts tests/commands/restore.test.ts
git commit -m "feat(restore): materialize (render+decrypt) on restore for apply parity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Materialize-aware `stateModel` (no false drift; stale templates flagged)

**Files:**
- Modify: `src/lib/stateModel.ts` (`computeFileState`)
- Test: `tests/lib/stateModel.test.ts`

- [ ] **Step 1: Write failing tests:**

```ts
it('reports a correctly-applied template file as ok (not drift-local)', async () => {
  // repo file "{{os}}"; live file = process.platform; manifest template:true
  // expect computeFileState(...).state === 'ok'
});
it('reports an edited live template as drift-local (needs apply)', async () => {
  // live file = "hand edited"; expect state === 'drift-local'
});
it('degrades to ok-by-presence for an encrypted file when the keystore is locked', async () => {
  // encrypted:true, getPassphrase -> null, both sides exist; expect state === 'ok' (no throw)
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm vitest run tests/lib/stateModel.test.ts` → FAIL (template file currently reports drift-local).

- [ ] **Step 3: Implement** a branch in `computeFileState` before the plain `classifyFileState`:

```ts
if ((file.template || file.encrypted) && repoChecksum !== null && liveChecksum !== null) {
  // Compare live against the MATERIALIZED repo content, not the raw repo bytes.
  try {
    const raw = await readFile(repoAbs);
    const ctx = defaultTemplateContext(/* config vars threaded by caller, or built here */);
    const expected = await materializeForLive(raw, file, ctx, { getPassphrase: keystorePassphrase });
    const expectedChecksum = sha256Hex(Buffer.from(expected, 'utf8'));
    const liveMatches = liveChecksum === expectedChecksum;
    const state: FileState = !liveMatches
      ? 'drift-local'                                   // remedy: tuck apply (presentation layer)
      : repoChecksum !== file.checksum ? 'drift-repo' : 'ok';
    return { id, source: file.source, destination: file.destination, state, liveChecksum, repoChecksum, manifestChecksum: file.checksum };
  } catch {
    // Locked keystore / undecryptable: degrade to presence-based ok rather than failing status/verify.
    return { id, source: file.source, destination: file.destination, state: 'ok', liveChecksum, repoChecksum, manifestChecksum: file.checksum };
  }
}
```
(Use the project's existing checksum helper for `sha256Hex`/`getFileChecksum`-on-buffer; if only a path-based `getFileChecksum` exists, hash the buffer with `createHash('sha256')` to match its format. Verify the format matches `getFileChecksum` so comparisons are valid.)

- [ ] **Step 4: Run, verify pass** — `pnpm vitest run tests/lib/stateModel.test.ts` → PASS.

- [ ] **Step 5: commit**

```bash
pnpm typecheck
git add src/lib/stateModel.ts tests/lib/stateModel.test.ts
git commit -m "feat(stateModel): compare template/encrypted files vs materialize(repo)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `sync` capture guard (the safety guard — never clobber/leak)

**Files:**
- Modify: `src/commands/sync.ts` (`detectChanges`, ~90-150)
- Test: `tests/commands/sync.test.ts`

- [ ] **Step 1: Write the failing safety test:**

```ts
it('does NOT capture template files live->repo (source not clobbered)', async () => {
  // Arrange: track a template file (manifest template:true); repo source = "{{os}}".
  //          Write a DIFFERENT live file (simulating a rendered/edited copy).
  // Act: detectChanges(tuckDir) (or run the sync change-detection path).
  // Assert: the template file is NOT in the returned changes; repo source bytes unchanged.
});
```

- [ ] **Step 2: Run, verify fail** — the template file currently appears as a change.

- [ ] **Step 3: Implement** — in `detectChanges`, skip materialized files:

```ts
for (const [id, file] of Object.entries(manifest.files)) {
  if (file.template || file.encrypted) {
    addJsonWarning?.(`${file.source} is ${file.template ? 'a template' : 'encrypted'}; live edits are not captured — edit the repo source and run \`tuck apply\``);
    continue; // one-directional: repo is the source of truth
  }
  // ... existing change-detection ...
}
```
(Use the existing warning channel the file already imports — `addJsonWarning` for JSON mode and/or `logger.warning`; match the file's pattern. Place the skip before the `getFileChecksum` work.)

- [ ] **Step 4: Run, verify pass** — `pnpm vitest run tests/commands/sync.test.ts` → PASS.

- [ ] **Step 5: commit**

```bash
pnpm typecheck
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "fix(sync): never capture template/encrypted files live->repo (no clobber/leak)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `add --template` / `add --encrypt` flags (write side, last)

**Files:**
- Modify: `src/types.ts` (`AddOptions`: add `template?: boolean; encrypt?: boolean`)
- Modify: `src/commands/add.ts` (options at 298-317; pass through `addFiles`→`trackFilesWithProgress`)
- Modify: `src/lib/fileTracking.ts` (accept `template`/`encrypt`; encrypt-on-store; set manifest flags at :281-282 instead of hardcoded `false`)
- Test: `tests/commands/add.test.ts`

- [ ] **Step 1: Write failing tests:**

```ts
it('add --template sets template:true in the manifest', async () => { /* assert manifest.files[id].template === true */ });
it('add --encrypt stores TCKE1 ciphertext and sets encrypted:true', async () => {
  // stub keystore passphrase = "pw"; after add, the repo copy must satisfy isEncryptedFile()
  // and decryptFileContent(repoBytes,"pw") === original live content.
});
it('add --encrypt errors clearly when no passphrase is configured', async () => { /* getPassphrase -> null => throws */ });
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** Add the two `commander` options:

```ts
.option('--template', 'Track as a template (rendered on apply; sync will not capture live edits)')
.option('--encrypt', 'Encrypt the file at rest in the repo (decrypted on apply)')
```
Add `template?: boolean; encrypt?: boolean` to `AddOptions` (`src/types.ts`). Thread them through `addFiles` → `FileTrackingOptions` → `trackFilesWithProgress`. In `trackFilesWithProgress` (`fileTracking.ts`), un-comment the `encrypt`/`template` options (`:59-68`, `:143-147`) and, in the copy branch:

```ts
if (encrypt) {
  const pass = await keystorePassphrase();
  if (!pass) throw new EncryptionError('No encryption password set. Run `tuck encryption setup` first.');
  const plaintext = await readFile(expandedPath);
  await ensureDir(dirname(destination));
  await writeFile(destination, await encryptFileContent(plaintext, pass));
} else {
  await copyFileOrDir(expandedPath, destination, { overwrite: true });
}
```
and set the manifest fields (replace `:281-282`):

```ts
encrypted: Boolean(encrypt),
template: Boolean(template),
```
(`checksum = getFileChecksum(destination)` already hashes the stored bytes, so it correctly hashes ciphertext for encrypted files. Symlink strategy is incompatible with `--encrypt` — reject that combination with a clear error, mirroring the existing `--symlink --repo` guard in `add.ts:27-31`.)

- [ ] **Step 4: Run, verify pass** — `pnpm vitest run tests/commands/add.test.ts` → PASS.

- [ ] **Step 5: commit**

```bash
pnpm typecheck
git add src/types.ts src/commands/add.ts src/lib/fileTracking.ts tests/commands/add.test.ts
git commit -m "feat(add): --template and --encrypt flags (encrypt-on-store)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full green gate

- [ ] **Step 1:** `pnpm typecheck` → clean.
- [ ] **Step 2:** `pnpm lint` → clean (fix any new lint; do not introduce `no-useless-escape` etc.).
- [ ] **Step 3:** `pnpm test` → all green (existing 831 + new). Investigate any regression before proceeding.
- [ ] **Step 4:** `pnpm build` → succeeds (tsup).
- [ ] **Step 5: docs** — add a short "Templates & Encryption" section to README/docs noting: repo stores the source, apply renders/decrypts, sync does not capture these files (edit the source + apply), one keystore password drives `--encrypt`.
- [ ] **Step 6: final commit**

```bash
git add -A
git commit -m "docs+chore: document templating/encryption flow; green gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (against the spec)

- **Spec §4.1 materialize** → Task 1. ✅
- **Spec §4.2 passphrase / §4.3 context** → Task 1 (`keystorePassphrase`) + Task 2 (`buildMaterializeCtx` using `config.templates.variables`). ✅
- **Spec §5 apply** → Task 2; **restore** → Task 3; **stateModel** → Task 4; **sync guard** → Task 5; **add flags + encrypt-on-store** → Task 6; **errors.ts** → Task 1. ✅
- **Spec §6 error handling** (never write ciphertext/partial; stateModel degrades; render is total) → Tasks 2/3 guard + Task 4 degrade. ✅
- **Spec §7 testing** (materialize units, apply render+decrypt, restore parity, sync-skip safety, add flags, stateModel) → Tasks 1-6 each have the matching test. ✅
- **Type consistency:** `materializeForLive(repoBytes, file, ctx, deps)`, `MaterializeDeps.getPassphrase`, `keystorePassphrase()`, `defaultTemplateContext(vars)` are used identically across Tasks 1-4. ✅
- **Open detail to confirm during impl (not a placeholder):** the exact `getFileChecksum` hashing so Task 4's buffer hash matches; the exact `ApplyFile`/restore-descriptor field plumbing for `template`/`encrypted`. Both are read-and-match, not design decisions.
