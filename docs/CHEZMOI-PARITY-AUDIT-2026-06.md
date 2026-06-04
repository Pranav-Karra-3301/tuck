# tuck vs chezmoi & peers — Feature-Parity, Best-Practices & Implementation Audit (2026-06)

> Produced by a 27-agent parallel audit workflow (`chezmoi-parity-audit`): 15 reference deep-dives across **chezmoi** (×8 slices) + **yadm / stow / dotbot / dotter / rcm / vcsh** — reading the actual cloned source — plus 5 tuck-subsystem inventories, fanned into **6 dimension gap-analyses** (each agent re-verified every "tuck is missing/partial" claim against `src/` before asserting it), then synthesized. Reference sources were cloned to `/tmp/dotfiles-refs`; chezmoi's own `comparison-table.md` seeded the matrix. This is the **outward-facing** companion to `docs/AUDIT-2026-05.md` (which is inward-facing code-safety). The headline P0 claims (templating/decrypt not wired into `apply`, no `import`/`edit`/`completion` commands) were independently re-verified against tuck source after the run.

## 1. Executive Summary

tuck is a TypeScript dotfiles manager whose **lifecycle surface is already at near-chezmoi parity** (init, add, remove, sync, push, pull, apply, restore, status, list, diff, verify, undo, scan — all wired and functional per the verified inventory) and whose **safety architecture exceeds chezmoi in three places**: a process-wide write-confinement sandbox (`src/lib/writeContext.ts`, `--root`), secret-scanning-by-default on every sync (`src/commands/sync.ts`), and an atomic snapshot/undo time-machine (`src/lib/timemachine.ts`) taken before every apply and pre-pull sync. It also owns a genuine **category of one**: a native MCP server (`src/commands/mcp.ts`, 6 tools, `TUCK_MCP_ALLOW_WRITE` gate), AI-agent-config sync (`src/commands/context.ts`), and repo-scoped tracking by stable `(repoKey, repoRelative)` identity (`src/lib/repoScope.ts`). None of the seven reference tools (chezmoi, yadm, stow, dotbot, dotter, rcm, vcsh) have any of these.

**Where tuck genuinely stands.** On the *transactional* axis (drift detection, rollback, secret hygiene, agent automation) tuck is at or ahead of chezmoi. On the *declarative-config* axis (per-machine templating, externals, migration on-ramps) tuck has **built the engines but not connected them**. The single most damaging finding, verified directly in source: `renderTemplate` appears only in `src/lib/template.ts` and `src/commands/preset.ts` — **`apply.ts` never calls it**. A complete, tested template engine exists, but the `template: boolean` manifest field is hardcoded `false` and never read at apply time, so tuck's flagship use case ("one repo, many machines") silently does not work for tracked dotfiles. A parallel verified bug: `apply.ts` contains zero `TCKE1`/`decrypt` references, so encrypted repo files are copied to disk as **raw ciphertext** — the keystore-encryption subsystem is dead weight until this is fixed.

**Real strengths to lean on:** (1) the 3-way live/repo/manifest state model (`stateModel.ts`) already distinguishes drift-local from drift-repo — chezmoi's core insight, already built; (2) the `--root` write sandbox is type-stronger than chezmoi's no-op `DryRunSystem`; (3) secret scanning with ReDoS guards + gitleaks is on by default, which chezmoi leaves to user discipline; (4) comprehensive JSON envelopes across all commands enable end-to-end agent control; (5) repo-scoped tracking lets tuck manage configs *inside* other git checkouts, which no peer models.

**The 5 highest-leverage moves:**

1. **Wire the existing template engine into `tuck apply`** (P0, M) — integration of already-tested code, not net-new; closes the largest competitive gap in one stroke.
2. **Add transparent decrypt-on-apply for `TCKE1` files** (P0, M) — a correctness bug, not a feature: encryption currently ships ciphertext to disk.
3. **Widen the MCP server** to expose diff/verify/scan_untracked/apply-plan (P0, M) — turns "has MCP" into "the agent-native dotfiles manager," tuck's only uncontested moat.
4. **Ship `tuck import --from chezmoi|stow`** and stop shipping pseudocode-only migration docs (P1, L) — the primary adoption on-ramp; `docs/migrations/*.md` (5,618 lines) currently *imply* working importers that do not exist.
5. **Quick-win bundle**: `tuck completion <shell>` + doctor env checks (git-version/$EDITOR/umask/symlink/latest-version + homedir redaction) + fix the dead `--keep-original` stub on `remove` (P1, S).

---

## 2. Master Feature Matrix

Legend: ✅ full · ◐ partial/stubbed · ❌ absent · 🏆 tuck better than all peers. tuck statuses reflect only what the gap findings verified.

| Feature | tuck | chezmoi | yadm | stow | dotbot | dotter | rcm | vcsh |
|---|---|---|---|---|---|---|---|---|
| **— chezmoi's own comparison rows —** | | | | | | | | |
| Manage shell/git/editor config | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Single binary / one-line bootstrap | ◐ (npm/brew + `apply <user>`) | ✅ | ✅ | ❌ | ◐ | ✅ | ✅ | ❌ |
| Per-machine differences (templating) | ❌ (engine unwired in apply) | ✅ | ◐ (alt-files) | ❌ | ◐ (`if`) | ✅ | ◐ (host-/tag-) | ❌ |
| Use any tool to edit config | ✅ (direct files) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Manage machine-to-machine secrets | ◐ (scan+redact+PM resolve; no decrypt-on-apply) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Apply / dry-run | ✅ (`--dry-run`/`--plan`) | ✅ | ❌ | ◐ (`--simulate`) | ✅ | ✅ | ❌ | ❌ |
| Diff before apply | ✅ (live-vs-repo) | ✅ | ◐ (`git diff`) | ❌ | ❌ | ✅ | ❌ | ◐ |
| Status (drift) | ◐ (2-way; repo-scoped path bug) | ✅ | ◐ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Verify (CI exit-code gate) | 🏆 (3-way + sandbox dry-apply) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Import from git repo on init | ◐ (GitHub-only; tuck or plain-dotfiles) | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Update (pull + apply) | ✅ (sync) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **— advanced rows (extending chezmoi's table) —** | | | | | | | | |
| Templates wired into deploy | ❌ | ✅ | ◐ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Three-tier template data (built-ins+file+local) | ◐ (built-ins only; config vars inert) | ✅ | ◐ | ❌ | ❌ | ◐ | ❌ | ❌ |
| Whole-file encryption | ◐ (TCKE1/scrypt formats exist) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Transparent decrypt-on-apply | ❌ (verified: none in apply.ts) | ✅ | ✅ | ❌ | ❌ | ◐ (trans_r) | ❌ | ❌ |
| age/GPG interop | ❌ (tuck-only formats) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ (transcrypt) |
| Password-manager integration | ◐ (4: 1Password/Bitwarden/pass/local) | ✅ (14) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Secret scanning (built-in) | 🏆 (ReDoS-guarded + gitleaks, default) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| OS-keystore-managed passphrase | ◐ (macOS/Linux/fallback; Win stub) | ◐ (keyring for secrets) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Agent / MCP server | 🏆 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| AI-agent-config tracking (CLAUDE.md etc.) | 🏆 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Repo-scope (track files in other checkouts) | 🏆 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Write-sandbox (`--root` confinement) | 🏆 | ◐ (DryRunSystem) | ❌ | ❌ | ❌ | ◐ (dry-run FS) | ❌ | ❌ |
| Migration importers (chezmoi/stow/yadm) | ❌ (docs-only pseudocode) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Golden / txtar integration tests | ❌ | ✅ (292) | ◐ (pytest) | ✅ (Perl .t) | ◐ (pytest) | ◐ | ✅ (Cram) | ✅ (Perl) |
| Snapshot/undo time-machine | 🏆 (atomic, recursive) | ◐ (via git) | ◐ (via git) | ❌ | ◐ (backup) | ◐ (backup) | ❌ | ◐ (via git) |
| Structured JSON output (all commands) | 🏆 | ◐ (dump/managed) | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ |
| edit → apply loop | ❌ (no `edit` cmd) | ✅ | ✅ | ✅ (live=link) | ✅ (live=link) | ✅ (live=link) | ✅ | ✅ |
| 3-way merge command | ❌ (merge.ts is shell-append) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| re-add / mass-sync | ❌ | ✅ | ✅ (bare git) | n/a | ❌ | n/a | ❌ | ✅ (bare git) |
| chattr (toggle attrs in place) | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Externals (remote files/archives/repos) | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Archive import/export | ◐ (tar only for clone bootstrap) | ✅ | ❌ | ❌ | ❌ | ❌ | ◐ (`rcup -g`) | ❌ |
| Shell completions | ❌ | ✅ | ✅ | ◐ | ❌ | ✅ | ◐ | ✅ |
| cd / enter / shell subshell | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| exact-dir / managed removal of untracked | ❌ | ✅ | ❌ | ◐ (unstow) | ✅ (clean) | ✅ (set-diff) | ❌ | ❌ |
| Pre/post hooks | ◐ (sync/restore only; preset postApply dead) | ✅ | ✅ | ❌ | ◐ (shell) | ✅ | ✅ | ✅ |
| Watch mode (re-apply on change) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Profiles / personas | ❌ (bundles filter apply only) | ◐ (.chezmoiignore) | ◐ (class) | ❌ | ❌ | ✅ (packages) | ◐ (tag) | ❌ |
| App-settings catalog (mackup-style) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Declarative package bootstrap | ❌ | ◐ (run_once scripts) | ◐ (bootstrap) | ❌ | ◐ (shell) | ❌ | ❌ | ❌ |
| Symlink-farm deploy mode | ◐ (inverted: live becomes link) | ✅ (symlink mode) | ◐ (alt) | 🏆 | ✅ | ✅ | ✅ | ❌ (bare git) |
| Cache-diff safe redeploy (warn on edit) | ❌ (clobbers w/ snapshot) | ✅ (3-state) | ❌ | ◐ (conflict) | ◐ | 🏆 | ❌ | ❌ |
| Persistent run-once/onchange state | ❌ | ✅ (boltdb) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| destroy / purge (clean uninstall) | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (delete) |
| Single System abstraction (one code path) | ◐ (verify reuses apply prep; restore/diff separate) | ✅ | ❌ | ✅ (plan/execute) | ✅ (plugin dispatch) | 🏆 (Filesystem trait) | ❌ | ❌ |

---

## 3. Parity Gaps (Prioritized, Deduplicated)

The six gap analyses produced overlapping items; the following list **deduplicates** them into a single prioritized backlog. Effort: S (≤1 day), M (2–5 days), L (>1 week).

### P0 — correctness bugs and the headline competitive gap

| # | Gap | Effort | Recommendation |
|---|---|---|---|
| P0-1 | **Templating not wired into apply** (verified: `renderTemplate` absent from `apply.ts`; `template:true` never read) | M | Call `renderTemplate` in `apply.ts` for `template:true` entries; add `tuck add --template`; pass `config.templates.variables` into `defaultTemplateContext`. Engine + tests already exist. |
| P0-2 | **No decrypt-on-apply** (verified: no `TCKE1`/`decrypt` in `apply.ts`) — encrypted repo files land as ciphertext | M | Detect the `TCKE1` header in apply's read pipeline, pull passphrase from the keystore, decrypt before write. Mirror the secret-resolution path already wired at `apply.ts` (`resolveFileSecrets`). |
| P0-3 | **MCP surface too thin** (verified: 6 tools, read-only inspection limited to status/scan) | M | Add `diff`, `verify(--exit-code)`, `scan_untracked`, secrets-status, and a sandboxed apply-plan tool behind `TUCK_MCP_ALLOW_WRITE`. |

### P1 — daily-workflow and adoption blockers

| # | Gap | Effort | Recommendation |
|---|---|---|---|
| P1-1 | **No `tuck edit`** (verified: no `edit.ts`; only `config edit`) | M | `tuck edit <file>` opens the repo copy in `$EDITOR`; `--apply` on save; decrypt-to-0700-tempdir for encrypted files. |
| P1-2 | **No re-add / mass-sync** (verified: `add` is one-file, idempotent-by-error) | M | `tuck re-add` iterates tracked non-template files, compares live-vs-repo via `stateModel`, updates changed files in one pass. |
| P1-3 | **No migration importers** (verified: no `import.ts`, no `src/lib/migrations/`; docs are pseudocode) | L | Ship `tuck import --from chezmoi|stow` first (largest switcher pools); map `dot_`/`private_`/`.tmpl`/`encrypted_` and stow packages into the manifest pipeline with `--dry-run` + write-only-missing. |
| P1-4 | **Migration docs over-state capability** (5,618 lines of `ChezmoiMigrator` pseudocode with no src) | S | Either implement, or banner each doc as "design — not yet implemented." |
| P1-5 | **No shell completions** (verified: none in `index.ts`) | S | `tuck completion <bash|zsh|fish>` — Commander lacks built-in; generate static scripts. Every major peer ships this. |
| P1-6 | **No 3-way merge command** (verified: `merge.ts` is shell-append, not external merge tool) | M | `tuck merge <file>` invoking configurable `merge.command` (default vimdiff) with live/repo/computed-target. |
| P1-7 | **Doctor missing env checks** (verified: no umask/EDITOR/latest/gitVersion/symlink/redact) | S | Add git-version (semver-min), `$VISUAL`/`$EDITOR`, umask, symlink-probe, npm/GitHub latest-version (`--no-network`), and redact `homedir()`→`~` in all messages. |
| P1-8 | **`--keep-original` is a dead stub** on `remove` (verified: flag declared, value never read) | S | On removing a symlink-tracked file, materialize repo content back to the original path as a regular file before untracking. |
| P1-9 | **No machine-specific file selection** (profiles/alt-files) | L | `tuck apply --profile <name>` built on the existing bundle concept (profiles = bundle subsets + variable overrides). Covers all-or-nothing per-machine inclusion that templates don't. |
| P1-10 | **No `.tuckdata` machine-data file** (verified: `config.templates.variables` never read) | M | Add `.tuckdata.{yaml,toml,json}` + deep-merge with built-ins and local config. Depends on P0-1. |

### P2 — declarative-management completeness and polish

| # | Gap | Effort | Recommendation |
|---|---|---|---|
| P2-1 | **No cache-diff safety** — apply `--replace` clobbers manually-edited live files (recoverable via snapshot, but silent) | M | Before overwrite, consult `stateModel` drift-local; if user-edited and no `--force`, warn-and-skip (dotter's core guarantee). |
| P2-2 | **No System abstraction** — apply/restore/diff keep separate write paths that can diverge | L | Introduce `System` interface (writeFile/mkdir/remove/chmod/symlink) with Real/DryRun/ReadOnly impls; route all four commands through it. Keystone that makes P2-1 cheap. |
| P2-3 | **No persistent EntryState** — hooks re-run every time; apply has no no-op short-circuit | M | State file under `getStateDir()` keyed by content SHA-256 (run-once) and target path (run-onchange); add apply already-up-to-date short-circuit. |
| P2-4 | **No externals** (verified: no `.tuckexternal` subsystem) | L | `.tuckexternal.toml` declaring remote files/archives/git-repos, cached by SHA-256(url), `refreshPeriod`, required checksum before write. |
| P2-5 | **No exact-dir / managed removal** (verified: no prune/deleteUntracked in apply) | M | Exact/managed directory flag so apply deletes untracked destination entries for strict declarative sync. |
| P2-6 | **No `tuck export`/`archive`** (verified: `preset publish` is a no-tar stub) | M | `tuck export` (self-contained installer à la `rcup -g`) and/or `tuck archive` (tar/zip of rendered target). |
| P2-7 | **No `tuck shell`/`cd`** (verified: no GIT_DIR subshell) | S | Spawn `$SHELL` with cwd at the repo (and GIT_DIR if bare) for raw-git debugging. ~10 lines. |
| P2-8 | **age/GPG interop absent** | L | `Encryption` interface with `AgeEncryption` (bundle `age-encryption` npm) + `GpgEncryption`. |
| P2-9 | **No watch mode** (verified: no chokidar in commands) | S | `tuck watch` re-runs apply on repo change, excluding `.tuck/` and `.git/`. Only valuable after P0-1. |
| P2-10 | **No app-settings catalog / package bootstrap** | M–L | `src/lib/apps/*.toml` for ~50 dev apps + `tuck add --app`; `[packages]` block + `tuck bootstrap` (Brewfile-first). |
| P2-11 | **No destroy/purge** (verified: only `remove` untracks, `undo` restores) | M | `tuck purge` (config/state/snapshots) + optional `tuck destroy <file>` behind a typed-phrase confirm (vcsh pattern). |
| P2-12 | **`status` repo-scoped path bug + no porcelain** | S | Fix `expandPath` misuse for repo-scoped sources (use `resolveLiveTarget` as verify does); add `--porcelain` A/M/D codes. |
| P2-13 | **diff doesn't compare vs manifest checksum** — repo-drift shows "no difference" | S | Extend diff to the 3-way model `verify` already uses. |
| P2-14 | **gitignore re-assertion only at init** (verified: `ensureRuntimeArtifactsGitignored` called only in `init.ts`) | S | Call it at the top of the sync commit path (and apply/import) so pre-existing repos can't leak `secrets.local.json`/state. |

---

## 4. Best Practices to Adopt From the Source Code

Each item cites the specific reference technique and the verified tuck gap.

1. **chezmoi's `System` abstraction — one code path for dry-run/diff/apply/verify.** chezmoi implements target-state traversal once (`applyArgs → SourceState.Apply`) and injects a different `System` (RealSystem, DryRunSystem, ErrorOnWriteSystem, GitDiffSystem) per command; dotter does the same with a 10-method `Filesystem` trait. tuck verified state: `verify` reuses `prepareFilesToApply`, but `restore` has its own `prepareFilesToRestore` and `apply` has inline `applyWithMerge`/`applyWithReplace`. **Adopt:** a single injected `System` so `--dry-run` is structural (a no-op sink) rather than scattered `if (dryRun)` branches, halving the surface where apply and diff can disagree. (P2-2)

2. **chezmoi's three-state reconciliation (target/last-written/actual) for idempotency and conflict detection.** chezmoi stores the last-applied `EntryState{type, mode, SHA256}` in boltdb and compares all three to distinguish "repo changed" from "user edited" from "conflict." tuck verified state: `stateModel.ts` already computes the 3-way comparison and powers `verify` — but `apply`/`sync` use 2-way and never gate on drift-local. **Adopt:** persist `EntryState` keyed by content SHA-256 and consult it in apply.

3. **dotter's cache-diff safe redeploy.** dotter writes the last-deployed output to `.dotter/cache/<path>` and refuses to overwrite a live file whose content no longer matches the cache without `--force` — its central safety guarantee. tuck verified state: `applyWithReplace` checks `pathExists` only to label add/modify, then writes unconditionally (a pre-apply snapshot makes it recoverable, but the edit is clobbered silently). **Adopt:** warn-and-skip on drift-local before destructive write. (P2-1)

4. **chezmoi/boltdb persistent state for run-once/run-onchange scripts.** Idempotency is proven by the script's own content hash (`ScriptStateBucket` keyed on `hex(sha256(body))`) for run-once, and by target path (`EntryStateBucket`) for run-onchange — so renaming re-runs but identical content does not. tuck verified state: no persistent script state; hooks run on every sync/restore. **Adopt:** the two-keyspace model (content-hash for once, path for onchange), recorded only after success so failures retry. (P2-3)

5. **chezmoi's transparent encryption (decrypt-on-apply + edit-encrypted).** The `encrypted_` filename attribute drives a strategy-pattern `Encryption` interface; apply decrypts on read, and `edit-encrypted` decrypts to a 0700 tempdir, edits, re-encrypts. tuck verified state: per-file `encrypt-file`/`decrypt-file` exist but `apply.ts` never decrypts. **Adopt:** decrypt-on-apply (P0-2) and an `Encryption` interface to enable age/GPG (P2-8).

6. **chezmoi's password-manager call memoization + `op`/`pass` `--` argv hardening.** Each PM CLI call is memoized per-run on the joined arg list, and user-controlled paths follow `--`. tuck verified state: `execFile` + `--` is implemented for backends, and `bitwarden-argv.test.ts` asserts it for Bitwarden — but `op`/`pass` lack recorded-argv tests. **Adopt:** the memoization pattern (a `.zshrc.tmpl` may reference one item 10×) and bitwarden-style argv assertions for the other backends.

7. **chezmoi's `doctor` as a composable check framework with PII redaction.** Each check is `Name() + Run() → (result, message)`; output redacts `homedir()→~` because it's pasted into public issues. tuck verified state: ~15–20 checks exist, but none for git-version/$EDITOR/umask/symlink/latest-version and no redaction pass. **Adopt:** the missing actionable env checks and a single `replaceAll(homedir(), '~')` pass. (P1-7)

8. **chezmoi's atomic write via temp-file + same-filesystem rename, with chmod-before-write.** `renameio` guarantees a file is old-or-new, never truncated; `f.Chmod(perm)` runs *before* `f.Write` so a new `.ssh/config` is never briefly world-readable. tuck verified state: `atomicWriteFile` (`files.ts:54`) does same-dir temp+rename (good) and honors mode, but the apply/restore `writeFile` calls chmod *after* writing. **Adopt:** pass `{mode}` to the initial write for sensitive destinations (or route through `atomicWriteFile`).

9. **rcm's hook contract: cwd = hook's own dir, propagate exit code, support file-or-sorted-dir.** A failing pre-hook aborts with the hook's *own* exit code (e.g. 7, not 1); cwd is the hook directory so hooks reference siblings; `find … | sort` handles both a single file and a numbered directory. tuck verified state: hooks cover sync/restore only, `preset.json` postApply hooks are never executed, no per-command pre/post for add/apply/edit. **Adopt:** generalize hooks to all commands, execute preset postApply, set cwd + propagate exit code. (Gap: hooks, P1)

10. **stow's / dotbot's two-phase plan-then-execute conflict collection.** Stow runs a pure planning pass collecting *all* conflicts before any write, then executes; dotbot's Link detects "already correct" and skips. tuck verified state: apply conflict detection is implicit (copy overwrites). **Adopt:** collect would-be conflicts, print together, abort before writing — preventing partial-apply states.

11. **chezmoi/stow/dotbot/yadm golden integration tests (txtar / Cram / `.t`).** Each declares an inline filesystem + commands + expected stdout in one self-contained file; chezmoi has 292 txtar scripts, 107 named `issueNNNN.txtar`. tuck verified state: ~1,175 it() cases but ~95% memfs-mocked, **zero tests spawn `dist/index.js`** (CI only smoke-tests `--version`/`--help`), no golden corpus. **Adopt:** a txtar-equivalent harness (see §5).

12. **XDG config/state separation (chezmoi, yadm, dotter).** chezmoi keeps `~/.config/chezmoi/chezmoi.toml` *out* of the repo (`~/.local/share/chezmoi`); machine-specific values live in a never-tracked local file. tuck verified state: `getConfigPath` resolves `config.json` *inside* the repo dir, risking commit/overwrite-on-pull. **Adopt:** move config to `$XDG_CONFIG_HOME/tuck/config.json`; split per-machine template vars into a never-tracked local override. (UX gap)

---

## 5. Testing Upgrades

tuck's CI matrix (3 OS × 3 Node, `fail-fast: false`) already beats every peer, and its security suite (path traversal, ReDoS payloads, redaction, sandbox confinement) and `bitwarden-argv` test are genuinely strong. The gaps are concentrated and concrete:

1. **Build an end-to-end binary harness (P0, M).** Build `dist/index.js` once, set `HOME` to a throwaway temp dir, run `init → add → sync → apply` round-trips, assert on-disk files + stdout. Verified: nothing spawns the binary today; the `parseAsync()` entry point is untested. This is the single biggest testing hole — bugs in flag parsing/command wiring ship behind memfs-mocked unit tests.

2. **Adopt a txtar/testscript-equivalent golden harness (P0, L).** One self-contained script per command (`add`/`apply`/`sync`/`restore`/`status`) with embedded fixtures + golden stdout, plus one named script per fixed bug (chezmoi's `issueNNNN.txtar` convention). This makes human-readable output regressions catchable and enables the harness in (1).

3. **De-mock the flagship workflow against real git (P1, M).** `full-workflow.test.ts` mocks `simple-git`, so it asserts mock call counts, not real commit/push/pull/rebase staging. Two suites (`mergeConflicts`, `provider-e2e`) already prove the `hasGit()`-gated real-git pattern; extend it to the main path.

4. **Add an idempotency assertion (P1, S).** Run apply twice on every integration test; assert the second run reports zero changes. The strongest guarantee a dotfiles manager makes — currently unverified for the main restore path (and apply has no no-op short-circuit, so this test would also surface P2-3).

5. **Recorded-argv tests for `op`/`pass`/GitLab (P1, S).** Mirror `bitwarden-argv.test.ts`: assert `--` precedes the user-controlled path for `op`/`pass`, and add a `GitLabProvider` argv test (only GitHub's `buildCreateRepoArgs()` is covered). A flag/injection regression is currently undetectable.

6. **Run Linux CI twice under umask 022 and 002 (P1, S).** tuck chmods-after-write in apply/restore — a classic umask-order bug class that 022-only CI hides. chezmoi injects umask via ldflags; tuck can set `process.umask()` in setup or via a matrix env.

7. **Tests for the newly-wired pipelines (gated on P0 work).** Once P0-1/P0-2 land: assert `{{os}}` substitution in an applied `template:true` file; assert a `TCKE1` repo file is decrypted on apply; add the end-to-end `apply → resolveFileSecrets → op/bw/pass → restoreContent` test using a mockcommand-style fake binary (yadm's `pinentry-mock` pattern).

8. **Property/fuzz tests with fast-check (P2, M).** `expandPath`/`collapsePath` round-trips, repo-scoped pseudo-path parsing, and template render invariants. The two template nesting bugs already found by hand are exactly what fuzzing catches systematically.

9. **Complete or remove the hand-rolled `fs-extra` mock (P2, S).** `tests/setup.ts` mocks only `copy`/`ensureDir`/`pathExists`; `ensureFile`/`move`/`outputFile`/`readJson` fall through to real `fs-extra`, so tests can silently hit real disk.

10. **Ratchet coverage thresholds (P2, S).** 40% statements / 34% functions is too low to enforce subsystem coverage; raise gradually as the e2e harness lands. Optionally wire `pnpm bench` into a non-blocking CI job for perf-trend tracking.

---

## 6. "tuck Should Be MORE" — Differentiation Roadmap

tuck's defensible wedge is **the agent-native, safety-first dotfiles manager**, not chezmoi-templating-parity. The play is to deepen the three moats that no reference tool can quickly copy, while fixing the two verified bugs that currently neuter them.

**Wedge 1 — The AI-agent dotfiles manager (already built, under-marketed).** `context.ts` tracks CLAUDE.md/.cursorrules/AGENTS.md/GEMINI.md across repos with a 10-type classifier and Zod-validated remote manifests; `repoScope.ts` tracks configs *inside any git checkout* by stable key. Combined with the MCP server, this is a category of one.
- Promote to headline positioning: "tracks configs anywhere, not just dotfiles in `~`."
- Add `tuck context diff` and a shared-template registry so teams sync one canonical `AGENTS.md`/`CLAUDE.md` across all their repos.

**Wedge 2 — The richest agent surface (MCP).** Today's 6 read tools can list/status/scan but cannot let an agent preview a diff, check drift, see untracked dotfiles, or dry-run an apply into the `--root` sandbox.
- Surface diff/verify/scan_untracked/secrets-status/apply-plan (P0-3).
- Expose the `--root` sandbox through the apply-plan tool so an agent can preview real changes with **zero risk to live HOME** — a concrete, demoable "agents physically cannot touch your home dir" claim.

**Wedge 3 — Safety as a marketed guarantee.** Secret-scanning-by-default (`sync.ts`), the `--root` write-jail (`writeContext.ts`), and the atomic snapshot/undo (`timemachine.ts`) all exceed chezmoi and are verified — but under-advertised.
- Market "cannot accidentally commit a secret" and "every apply is a transaction you can roll back."
- Expose the secret scan as an MCP read tool so agents never propose committing a key.

**Ambitious, none-of-the-seven-have-it features (after the moats are solid):**
- **AI-assisted migration** (`tuck import --from <tool>`, LLM-guided): parse a chezmoi/stow/yadm source-state and *propose* the tuck manifest plus which files to encrypt/redact. Uses tuck's own MCP/AI DNA; turns the adoption blocker (P1-3) into a differentiator.
- **App-settings catalog** (`tuck add --app vscode`): mackup is decaying on macOS 14+ and none of the seven cloned tools fill this. ~50 dev-app TOML mappings.
- **`tuck watch`**: only dotter has it; cheap delight once templating-in-apply lands.
- **Profiles** built on the existing bundle concept: dotdrop's top differentiator, mostly a layer over code tuck already has.

**Explicitly do NOT chase first:** full Go-template/sprig parity, externals, declarative package bootstrap, a full-screen TUI — these are lower-leverage than deepening the agent + safety moats, and several (externals, bootstrap) are low-frequency needs.

---

## 7. Concrete Next Actions (Engineer Checklist)

### P0 — start immediately (correctness + headline gap)
- [ ] **Wire templating into apply.** In `src/commands/apply.ts`, for each manifest entry with `template === true`, run `renderTemplate(content, defaultTemplateContext(...))` before writing. Stop hardcoding `template:false` in `src/lib/fileTracking.ts`; add `--template` to `tuck add`. Pass `config.templates.variables` into the context.
- [ ] **Decrypt-on-apply.** In apply's read path, detect the `TCKE1` header; fetch the passphrase from the keystore (`src/lib/crypto/keystore/*`); decrypt before write. Reuse the structure of the existing `resolveFileSecrets` hook.
- [ ] **Add tests for both pipelines:** `{{os}}` substitution appears in the written file; a `TCKE1` repo file is decrypted on disk after apply.
- [ ] **Widen MCP** (`src/commands/mcp.ts`): add `diff`, `verify(--exit-code)`, `scan_untracked`, secrets-status, and a sandboxed apply-plan tool; keep all writes behind `TUCK_MCP_ALLOW_WRITE`.
- [ ] **Build the e2e binary harness:** spawn `dist/index.js` against a temp `HOME`, run `init→add→sync→apply`, assert files + stdout.

### P1 — next (daily workflow + adoption + quick wins)
- [ ] `tuck edit <file>` (open repo copy in `$EDITOR`, `--apply` on save, decrypt-to-0700-tempdir for encrypted).
- [ ] `tuck re-add` (mass-sync edited live files via `stateModel` comparison).
- [ ] `tuck merge <file>` (configurable `merge.command`, default vimdiff, with live/repo/computed-target).
- [ ] `tuck import --from chezmoi` and `--from stow` with a shared `Migrator` interface, `--dry-run`, and write-only-missing semantics; route clone through the provider-neutral `remoteSetup` so non-GitHub sources work.
- [ ] Banner `docs/migrations/*.md` as "design — not yet implemented" until the importer ships.
- [ ] `tuck completion <bash|zsh|fish>` (generate static scripts).
- [ ] Doctor env checks: git-version (semver-min), `$VISUAL`/`$EDITOR`, umask, symlink-probe, npm/GitHub latest-version (`--no-network`); add `replaceAll(homedir(), '~')` redaction over all messages.
- [ ] Implement the dead `--keep-original` flag on `remove` (materialize repo content back to a regular file).
- [ ] `tuck apply --profile <name>` built on bundles (subset + variable overrides); foreign-manager auto-detect hints in `scan`/`init`.
- [ ] De-mock `full-workflow.test.ts` against real git (gated by `hasGit()`); add an apply-twice idempotency assertion; add `op`/`pass`/GitLab recorded-argv tests; run Linux CI under umask 022 *and* 002.
- [ ] Move `config.json` to `$XDG_CONFIG_HOME/tuck/`; split per-machine vars into a never-tracked local file.
- [ ] Call `ensureRuntimeArtifactsGitignored(tuckDir)` at the top of the sync commit path (and apply/import), not only at init.

### P2 — declarative completeness + architecture
- [ ] **Introduce the `System` interface** (Real/DryRun/ReadOnly) and route apply/restore/diff/verify through it (keystone for the next two items).
- [ ] **Cache-diff safety:** in apply `--replace`, consult `stateModel` drift-local and warn-and-skip without `--force`.
- [ ] **Persistent EntryState** under `getStateDir()` (content-hash keyspace for run-once, path keyspace for run-onchange); add apply already-up-to-date no-op.
- [ ] Adopt a txtar/testscript golden harness; add property/fuzz tests (fast-check) for path resolution and templating; complete the `fs-extra` mock; ratchet coverage thresholds.
- [ ] `.tuckexternal.toml` (remote files/archives/repos, SHA-256(url) cache, `refreshPeriod`, required checksum); exact-dir managed removal of untracked entries.
- [ ] `tuck export`/`archive`; `tuck shell`/`cd` subshell; `tuck watch` (chokidar, exclude `.tuck/`+`.git/`).
- [ ] `tuck purge` + optional `tuck destroy <file>` (typed-phrase confirm); fix `status` repo-scoped path resolution (use `resolveLiveTarget`) and add `--porcelain`; extend `diff` to the 3-way model.
- [ ] Generalize hooks to all commands; execute preset `postApply`; set hook cwd to the hook's own dir and propagate its exit code.
- [ ] `Encryption` interface with `AgeEncryption` + `GpgEncryption` for ecosystem interop; broaden PM backends (rbw/keepassxc/vault) opportunistically.
- [ ] App-settings catalog (`src/lib/apps/*.toml` + `tuck add --app`); `[packages]` block + `tuck bootstrap` (Brewfile-first).
- [ ] Publish a GitHub Action wrapping `tuck verify --exit-code --json` to advertise native CI drift detection.
