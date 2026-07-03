I have everything I need. I've verified all the load-bearing facts: the exact `resolveWriteTarget` signature/branches, `validateSafeDestinationPath` defaulting to `[homedir()]` (the critical gotcha designs 1 and 2 missed but design 3 caught), the `copyFileOrDir`/`createSymlink` call into `validateSafeDestinationPath`, `getRemoteUrl`/`getRemotes` already existing in git.ts, `findGitRoot`/`slugifyPath`/`repoScopeKey` in context.ts, and the `FileState` exhaustive switch. Now I'll synthesize the final design and plan.

The most important correctness finding from reading the real code: **all three designs claim restore writes go only through `resolveWriteTarget`, but in fact `copyFileOrDir`/`createSymlink` independently call `validateSafeDestinationPath(expandedDest)` which defaults to `[homedir()]`.** A repo target outside `$HOME` is rejected there regardless of `resolveWriteTarget`. Only design 3 caught this. Any working plan MUST thread `allowedRoots()` into those two functions' calls. This is the single load-bearing detail that decides whether the feature works at all.

---

# SYNTHESIZED DESIGN: repo-scoped tracking for tuck

## Decisions (the hard problem, resolved)

**1. Manifest shape (committed, machine-independent).** Add three fields to `trackedFileSchema`:
- `scope: z.enum(['home','repo']).optional()` — **`.optional()`, NOT `.default('home')`.** Decisive: I reject designs 2 & 3's `.default('home')`. A default rewrites every legacy entry's bytes on the next `saveManifest` (adding `"scope":"home"` to all of them), producing noisy diffs in committed dotfiles repos and breaking the "loads byte-identical" promise. `.optional()` leaves legacy entries untouched; `file.scope !== 'repo'` is the home test everywhere. This matches how the codebase actually treats absence (the `file.bundle ?? 'default'` pattern in apply.ts:312).
- `repoKey: z.string().optional()` — stable cross-machine repo identity. Never an absolute path.
- `repoRelative: z.string().optional()` — POSIX repo-root-relative path (e.g. `.vscode/settings.json`).
- A `.superRefine`: if `scope==='repo'` then `repoKey` and `repoRelative` are required & non-empty; `repoRelative` must pass no-`..`/not-absolute. If `scope` is absent/`'home'`, both must be absent. A malicious half-formed entry fails at `loadManifest`, not at write time.
- `source` is kept for repo files as a **display string** `"<repoKey>:<repoRelative>"` so `generateFileId`/`getTrackedFileBySource`/logging keep working; resolution never does `expandPath(source)` for repo files.
- `destination` stays under `files/`, namespaced as `files/repos/<repoKey>/<repoRelative>` so `validateSafeManifestDestination`/`getSafeRepoPathFromDestination`/`computeFileState`'s `join(tuckDir, destination)` work unchanged.

**2. Per-machine remapping (the core).** `repoKey → absolute root` is stored **machine-local, off-repo** at `join(getStateDir(), 'repos.json')` (XDG_STATE_HOME / Library/Application Support — same off-repo pattern as snapshots/audit/keystore, never inside tuckDir, never committed). New `src/lib/repoScope.ts` owns it, validated by a new `src/schemas/repos.schema.ts` (parsed, never `as`-cast, mirroring context.ts's untrusted-JSON discipline). Live location of a repo file = `join(resolveRepoRoot(repoKey), repoRelative)`. Unknown `repoKey` on a machine → resolves to `null` → **skipped, never guessed** (new `'unknown-repo'` FileState; explicit `tuck repo link`).

**3. repoKey derivation.** `deriveRepoKey(repoRoot)` = `slugify(basename(repoRoot)) + '-' + sha256(canonicalRemoteUrl).slice(0,8)` where the hash input is the canonicalized `origin` URL (via existing `getRemoteUrl`, strip scheme/`.git`/trailing slash, lowercase host) — this is what makes machine A and machine B derive the **same** key. No remote → fall back to first-commit hash (`git rev-list --max-parents=0 HEAD`), then to `basename` + short random with a warning. `--repo-key <label>` is the explicit override/escape hatch. **Never embed the absolute path in the committed key** (this is exactly the cross-machine bug in context.ts:208's `repoScopeKey`, which I deliberately do not reuse for the portable key).

**4. Path guard (do NOT weaken home confinement).** `validateSafeSourcePath` is untouched and still gates home scope. Add a sibling `validateSafeRepoSourcePath(repoRoot, repoRelative)`: rejects absolute/`..`/UNC `repoRelative` (reuse the normalized-split checks from `validateSafeManifestDestination`), then `validatePathWithinRoot(resolve(repoRoot, repoRelative), repoRoot)`. Symmetric to home confinement, but the allowed root is the registered repo root. The repo root comes ONLY from the machine-local registry, so a hostile manifest can only *name* a key — an unknown key is skipped; a known key still confines the write inside that bound repo.

**5. Sandbox composition (the decisive part — and the bug all designs but one missed).** Two changes, both required:
- Extend `resolveWriteTarget(source, repo?)` with an optional `repo?: { repoKey; repoRelative; repoRoot }`. **When `isSandbox()`**, rebase by *stable identity*: `target = resolve(root, 'repos', repoKey, repoRelative)` — the real (possibly out-of-home) `repoRoot` is used ONLY to compute the tail, never to place the file; the existing final `validatePathWithinRoot(target, root)` backstop holds, so an out-of-home repo can never escape `--root`. **When NOT sandboxed**, `target = resolve(repoRoot, repoRelative)` (the genuine repo on this machine), confined by `validateSafeRepoSourcePath` upstream.
- **Critical, load-bearing:** `resolveWriteTarget` is NOT the only guard on the write path. `copyFileOrDir`/`createSymlink` independently call `validateSafeDestinationPath(expandedDest)` which **defaults to `[homedir()]`** and will reject any out-of-home repo target. So `allowedRoots()` must change to return `[homedir(), ...ctx.repoRoots]` when **not** sandboxed (and `[getWriteRoot()]` when sandboxed, since rebased repo writes already land under it), and **every** `copyFileOrDir`/`createSymlink` call that can target a repo file MUST pass `allowedRoots()`. The known repo roots are loaded into the write context in the `index.ts` preAction hook (`setKnownRepoRoots(...)` right after `setWriteContext`).

**6. Single resolver.** `resolveLiveTarget(file)` in `repoScope.ts`: home → `expandPath(file.source)`; repo → `resolveRepoRoot(repoKey)` then `join(root, repoRelative)`, or `null`. Used by stateModel, restore, apply, sync. One choke point, decided once at add time, never re-inferred from cwd.

**7. `add` is the only constructor of repo entries**, gated behind explicit `--repo` (auto-detect prompts interactively, but `--json`/`--yes` require explicit `--repo` so home files are never silently re-scoped). v1 restricts repo scope to **copy strategy** (no symlinking working-tree files).

I reject design 1's reuse of `repoScopeKey` for identity (path-embedded = cross-machine-broken) and adopt design 2/3's remote-URL-canonicalized key. I adopt design 3's `allowedRoots()`/`validateSafeDestinationPath` threading (the only design that's actually buildable). I adopt design 1's `.optional()` (no default) for true byte-identical backward compat.

---

# IMPLEMENTATION PLAN (ordered, test-first, independently committable)

**Step 0 — Branch.** `git checkout -b feat/repo-scoped-tracking` off `development`. Run `pnpm lint && pnpm typecheck && pnpm test` once to capture a green baseline.

**Step 1 — Manifest schema + backward-compat.**
- Test first: extend `tests/lib/manifest.test.ts` — (a) a legacy manifest (no `scope`) parses and re-saves byte-identical (no injected `scope` key); (b) a valid repo entry parses; (c) `scope:'repo'` with missing `repoKey`/`repoRelative` fails parse; (d) `repoRelative:"../x"` fails; (e) home entry with stray `repoKey` fails.
- Change: `src/schemas/manifest.schema.ts` — add `scope`/`repoKey`/`repoRelative` as `.optional()` + `.superRefine`. No version bump, no `migrateBundles` change.
- Proof: the byte-identical re-save test is the load-bearing one.

**Step 2 — repos.json schema + machine-local registry.**
- Test first: new `tests/lib/repoScope.test.ts` — `loadReposRegistry()` returns empty when absent; `bindRepo`/`resolveRepoRoot` round-trip via a temp `XDG_STATE_HOME`; malformed `repos.json` parses to empty (never throws); `resolveRepoRoot(unknown)` → `null`.
- Change: new `src/schemas/repos.schema.ts` (`{version:'1', repos: Record<key,{root,remoteUrl?,boundAt}>}`); new `src/lib/repoScope.ts` with `getReposRegistryPath` (uses `getStateDir`), `loadReposRegistry`, `bindRepo` (`ensureDir` + `atomicWriteFile`), `resolveRepoRoot`; move/share `findGitRoot` here (re-export from context.ts to avoid a second copy).
- Proof: round-trip + malformed-safe tests.

**Step 3 — repoKey derivation + canonical remote URL.**
- Test first: in `tests/lib/repoScope.test.ts` — `canonicalRemoteUrl('git@github.com:u/r.git') === canonicalRemoteUrl('https://github.com/u/r')`; `deriveRepoKey` is deterministic for the same remote; `--repo-key` override wins; no-remote falls back to first-commit hash.
- Change: add `canonicalRemoteUrl`, `deriveRepoKey(repoRoot, opts?)` to `repoScope.ts` (uses existing `getRemoteUrl` from git.ts + `git rev-list --max-parents=0 HEAD`). Reuse `slugifyPath` (export it from context.ts or lift to `repoScope.ts`).
- Proof: SSH/HTTPS-equivalence test.

**Step 4 — Path guard for repo sources.**
- Test first: extend `tests/lib/paths.test.ts` / `tests/security/*` — `validateSafeRepoSourcePath(root, '.vscode/settings.json')` passes for a root outside `$HOME` (e.g. `/tmp/foo`); rejects `..`, absolute, `\\`-UNC; confirm `validateSafeSourcePath` behavior is unchanged (existing tests stay green).
- Change: add `validateSafeRepoSourcePath` to `src/lib/paths.ts`; add `getRepoScopedDestination(repoKey, repoRelative)` returning `files/repos/<key>/<rel>` (POSIX, runs through `validateSafeManifestDestination`).
- Proof: out-of-home root passes; traversal rejected.

**Step 5 — `resolveWriteTarget(source, repo?)` + `allowedRoots()` + write context repo roots.**
- Test first: extend `tests/lib/writeContext.test.ts` — sandbox: `resolveWriteTarget('ignored', {repoKey:'k', repoRelative:'a/b', repoRoot:'/srv/out/of/home'})` → `<root>/repos/k/a/b`, and a hostile `repoRoot:'/'` + `repoRelative:'etc/passwd'` still lands under `<root>/repos/...` (no escape); non-sandbox: returns `resolve(repoRoot, repoRelative)`; `allowedRoots()` returns `[homedir(), ...knownRepoRoots]` when not sandboxed and `[getWriteRoot()]` when sandboxed; calling 1-arg `resolveWriteTarget(source)` is byte-identical to today (existing tests must stay green).
- Change: `src/lib/writeContext.ts` — add optional `repo` param + branch; add `repoRoots: string[]` to `WriteContext` + `setKnownRepoRoots`; update `allowedRoots()`. Wire `setKnownRepoRoots(Object.values(loadReposRegistry().repos).map(r=>resolve(r.root)))` into `src/index.ts` preAction hook right after `setWriteContext`.
- Proof: the hostile-`repoRoot`-in-sandbox containment test.

**Step 6 — Thread `allowedRoots()` into the copy/symlink write path (the load-bearing fix).**
- Test first: new `tests/lib/files-repo-dest.test.ts` — with `setKnownRepoRoots(['/tmp/repoX'])`, `copyFileOrDir(src, '/tmp/repoX/sub/file')` succeeds; without it, it still rejects (defaults to home). Same for `createSymlink`.
- Change: `src/lib/files.ts` — `copyFileOrDir`/`createSymlink` call `validateSafeDestinationPath(expandedDest, allowedRoots())` (import from writeContext). This is safe for all existing home callers because `allowedRoots()` already includes `homedir()`.
- Proof: out-of-home repo dest accepted only when bound.

**Step 7 — `resolveLiveTarget` + stateModel `unknown-repo`.**
- Test first: extend `tests/lib/stateModel.test.ts` — repo entry with bound key classifies normally (ok/drift/missing); repo entry with unbound key → `'unknown-repo'`; home entries unchanged. Add exhaustiveness: the new state must appear in `summarizeStateModel` and the `STATE_LABEL` map (TS strict catches a miss at compile time).
- Change: add `resolveLiveTarget(file)` to `repoScope.ts`; `stateModel.ts` `computeFileState` uses it (async), adds `'unknown-repo'` to `FileState` union + `summarizeStateModel`; `verify.ts` `STATE_LABEL` gets the new entry; `fixMissingRepo` skips files whose live target is `null`.
- Proof: unbound-key classification + exhaustive-switch compile.

**Step 8 — `tuck add --repo` constructs repo entries.**
- Test first: `tests/commands/add-repo.test.ts` (integration, temp git repo outside the temp `$HOME`) — `add --repo` writes a manifest entry with `scope:'repo'`, correct `repoKey`/`repoRelative`, `destination` under `files/repos/`, copies the live file into the repo dir, and calls `bindRepo`; rejects a path outside the detected root; `--json`/`--yes` without `--repo` stays home-scoped.
- Change: `add.ts` (`--repo [dir]`, `--repo-key`), `src/types.ts` `AddOptions`; a repo-aware branch in `trackPipeline.ts` (`validateSafeRepoSourcePath` instead of `validateSafeSourcePath`, secret-scan on the absolute path, `destination=getRepoScopedDestination(...)`); extend `PreparedTrackFile` + `FileToTrack` + `trackFilesWithProgress`/`addFileToManifest` call to carry `scope`/`repoKey`/`repoRelative`. Restrict repo scope to copy strategy.
- Proof: the manifest-shape assertion + `bindRepo` call.

**Step 9 — restore uses the resolver + sandbox repo writes.**
- Test first: extend `tests/commands/` restore tests — restore of a repo file on a machine where the repo is bound to a *different* path writes to that path; unbound key → skipped with a warning (and `skipped[]` in `--json`); under `--root`, the repo file lands under `<root>/repos/<key>/...`.
- Change: `restore.ts` — `prepareFilesToRestore`/`restoreFilesInternal` branch on `file.scope`: home keeps `validateSafeSourcePath` + `resolveWriteTarget(source)`; repo uses `validateSafeRepoSourcePath` + `resolveLiveTarget` + `resolveWriteTarget(live, {repoKey,repoRelative,repoRoot})`. Add `--repo-root <dir>` opt-in for binding on restore.
- Proof: cross-path restore + sandbox containment.

**Step 10 — apply + sync repo-awareness.**
- Test first: apply test — cloned manifest with a repo entry whose key is bound locally writes to the local checkout; unbound → skipped + listed in JSON envelope (never guessed). sync test — `detectChanges` uses `resolveLiveTarget`; unbound repo entry is skipped, NOT reported as `deleted`.
- Change: `apply.ts` `prepareFilesToApply` (write destination via `resolveLiveTarget`; `repoPath` read stays `join(repoDir, destination)`; pass `repo` ctx into the four `resolveWriteTarget` call sites); `sync.ts` `detectChanges` (and the secret-scan source paths) via `resolveLiveTarget`.
- Proof: unbound-not-deleted (the regression the design flags as the main sync hazard).

**Step 11 — `tuck repo` command.**
- Test first: `tests/commands/repo.test.ts` — `repo link <key> <path>` binds; `repo list` shows bindings; `repo unlink` removes; `link` rejects a non-existent / non-git path.
- Change: new `src/commands/repo.ts` (`link`/`list`/`unlink`, `--json`), register in `src/index.ts` + `src/commands/index.ts`.
- Proof: link→resolve round-trip.

**Step 12 — docs + `.gitignore` guard.**
- Change: `CLAUDE.md` (repo scope section: tracks config files inside repos, not whole repos; `repos.json` is machine-local; `tuck repo link` on new machines), `README`/`docs/` as present. Confirm `repos.json` lives under `getStateDir()` (already gitignored by being off-repo) — no manifest/`.tuckrc` leak of absolute paths.
- Proof: `grep` test/CI assertion that no committed artifact contains an absolute `repoRoot` (a small unit test asserting the manifest entry has no absolute-path fields).

**Final gate:** `pnpm lint && pnpm typecheck && pnpm test`, plus a manual two-dir end-to-end: `add --repo` in `/tmp/repoA`, copy manifest, `repo link` to `/tmp/repoB`, `restore`, `verify` (expect `ok`), and the same under `--root /tmp/sandbox` (expect writes under `/tmp/sandbox/repos/<key>/...`, nothing in `/tmp/repoB`).

---

Relevant files (all absolute): manifest schema `/Users/pranavkarra/Developer/tuck/src/schemas/manifest.schema.ts`; new `/Users/pranavkarra/Developer/tuck/src/schemas/repos.schema.ts`; new `/Users/pranavkarra/Developer/tuck/src/lib/repoScope.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/paths.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/writeContext.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/files.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/stateModel.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/state.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/fileTracking.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/trackPipeline.ts`; `/Users/pranavkarra/Developer/tuck/src/lib/git.ts` (reuse `getRemoteUrl`); `/Users/pranavkarra/Developer/tuck/src/commands/add.ts`; `/Users/pranavkarra/Developer/tuck/src/commands/restore.ts`; `/Users/pranavkarra/Developer/tuck/src/commands/apply.ts`; `/Users/pranavkarra/Developer/tuck/src/commands/sync.ts`; `/Users/pranavkarra/Developer/tuck/src/commands/verify.ts`; new `/Users/pranavkarra/Developer/tuck/src/commands/repo.ts`; `/Users/pranavkarra/Developer/tuck/src/index.ts`; `/Users/pranavkarra/Developer/tuck/src/types.ts`; `/Users/pranavkarra/Developer/tuck/src/commands/context.ts` (export `findGitRoot`/`slugifyPath`).

The single most important correctness note for whoever executes this: **`copyFileOrDir`/`createSymlink` in `/Users/pranavkarra/Developer/tuck/src/lib/files.ts:249,328` call `validateSafeDestinationPath(expandedDest)` with the default `[homedir()]` root.** Without Step 6 threading `allowedRoots()`, every out-of-home repo restore silently fails at that guard even though `resolveWriteTarget` would have allowed it. Two designs omitted this; it is non-optional.