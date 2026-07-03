# What's Next for tuck

> A critical product review. Opinionated, not exhaustive. Nothing is set in stone.

---

## TL;DR

tuck is a beautifully-built TypeScript CLI that solves the problem chezmoi already solves, but with prettier prompts. That is not a moat. The moat — if there is one — is **"the dotfiles manager for the era when half your dotfiles are AI instructions and half the operators are AI agents."** Nobody owns that category today. To take it, tuck needs three structural changes (single binary, JSON-everywhere, plugin-extensible), one positioning change (agent-native, not "modern beautiful"), and one honest cut to the roadmap (kill half of v1.3–v2.0). The current roadmap is 20 features across 6 versions chasing chezmoi's feature parity. That race is unwinnable. The race tuck *can* win is a different one.

---

## 1. Where tuck actually is today (honest)

What I read across `src/`, `ROADMAP.md`, `AGENTS.md`, `package.json`, and the test suite:

**Strengths — real, not marketing**
- `@clack/prompts` UX is genuinely the best in this category. chezmoi/yadm/stow look 10 years older.
- Safety defaults are strong: Time Machine snapshots (`src/lib/timemachine.ts`, 30 passing tests, restores individual files OR whole state), secret scanning before sync (71 patterns in `src/lib/secrets/patterns.ts`, context-aware), gitignored fallback secrets, `tuck doctor` with ~77 checks across 5 categories.
- Provider abstraction exists (`src/lib/providers/types.ts:87` — clean `GitProvider` interface). GitHub, GitLab, local, custom all work.
- External secret managers (1Password, Bitwarden, pass) are **functional, not stubbed** (`src/lib/secretBackends/`). This is genuinely good.
- Encryption command exists and stores passwords in OS keychain (macOS Keychain / Linux pass / Windows Credential Manager).
- Windows support is real: junctions, PowerShell preserve markers, env var expansion.
- TypeScript strict + Zod = the codebase will not rot the way bash-based competitors do.

**Weaknesses — also real**
- `src/commands/init.ts` is **1,747 lines** with 12+ branch points and 164 prompt calls. This is one bad merge away from being unmaintainable.
- Detection is **completely hardcoded** (`src/lib/detect.ts` — 200+ patterns in a static `DOTFILE_PATTERNS` list, lines 99–655). To support a new tool you fork or PR.
- `tuck sync`, `tuck init`, `tuck diff` have **no `--json` output**. Only `tuck scan --json` exists. Agents and CI can't drive tuck.
- Sync conflict handling is `git pull --rebase` and pray (`src/commands/sync.ts:134`). No 3-way merge UI, no "keep mine/theirs."
- Manifest declares fields it doesn't use: `encrypted`, `template`, `permissions` in `src/schemas/manifest.schema.ts`. Aspirational schema is technical debt.
- Hooks are **shell-only** (`src/lib/hooks.ts`) — 4 lifecycle events, no programmatic API, no extension points.
- Providers are a **closed set of 4** (`src/lib/providers/index.ts:27`). No plugin loader.
- Test coverage gaps: zero integration tests for 1Password/Bitwarden/pass backends; encryption command has UI tests but not crypto logic tests.
- Node.js is a **runtime tax**. Every install means `node` first. chezmoi is a single static Go binary.
- Package name `@prnv/tuck` signals "personal project." The npm tap is `pranav-karra-3301/tap/tuck`. Not "serious infrastructure."
- ROADMAP.md is 1,765 lines describing 20 features across 6 versions. This is a wishlist, not a plan.

**Status, in one sentence:** Excellent foundation, beautiful UX, solid safety primitives — but the product strategy is "chezmoi but prettier," and that's not a wedge.

---

## 2. The strategic question: what is tuck FOR?

Three positioning options. They're mutually exclusive in practice because each implies different priorities.

### Option A — "Modern, beautiful chezmoi" (current trajectory)
You ship templates, encryption, profiles. You chase feature parity with chezmoi for 18 months. You end up with a slightly nicer chezmoi that 5% of dotfiles-aware developers might try. chezmoi has 19.7k stars and an active maintainer. This is a losing race because the only thing you're winning on is *aesthetics*, and aesthetics is not switching cost.

### Option B — "Dotfiles for AI agents" (recommended wedge)
You ship JSON-everywhere, single-binary distribution, agent-native primitives (manage `CLAUDE.md`/`.cursorrules`/`.aider.conf.yml`/skill directories as first-class), and `tuck plan` that emits structured diffs an agent can read. You position tuck as **the way an AI coding agent manages its operator's terminal**, and as the way humans manage their *AI configs* alongside their shell configs. Nobody owns this category today. The closest thing — `agent-dotfiles` — is a stub.

This is the wedge. Everything else in this doc assumes you take it.

### Option C — "Plug-and-play terminal setup" (consumer)
You ship recipes/installers/themes, target beginners, become "create-react-app for terminals." This is what the v1.3 roadmap mostly is. It's a real market but a crowded one (omakub, prezto, oh-my-zsh ecosystem), and the buyer is a *learner*, not someone who'll pay or evangelize. Hard to monetize, hard to retain.

**Pick B.** The rest of this document assumes B.

---

## 3. The big bottlenecks (root-cause framing)

These are the load-bearing problems. Fixing them unlocks everything else.

### 3.1 Interactive-by-default is incompatible with agents
Every command that matters (`init`, `sync`, `add`, `restore`, `apply`) is built around `@clack/prompts`. The non-interactive escape hatches are partial: `tuck apply` has `--yes`, `runSyncCommand()` exists as a programmatic API but lacks `--quiet`, `tuck init` is the worst offender with 12+ interactive branch points.

**Why this is fatal:** An AI agent running `tuck init` in a sandbox gets stuck on the first prompt. So they don't run it. So tuck never enters their workflow.

**Fix:** Every command gets three modes:
1. **TTY interactive** (current). 
2. **`--json` + `--yes`** for full automation. Reads inputs from flags or stdin JSON, writes JSON to stdout, never prompts. Errors are structured.
3. **`--plan`** prints the operation as machine-readable JSON without executing. Agent can read, decide, apply.

This is roughly the `terraform plan` / `kubectl apply --dry-run=client -o json` pattern. It's table stakes for any tool in 2026.

### 3.2 Hardcoded detection is a community-killer
`DOTFILE_PATTERNS` in `detect.ts` is 555 lines of static config. Every new editor, every new tool, every new shell framework is a PR to tuck. This is fine for v1, lethal for v2.

**Fix:** Make patterns *data*, not code.
- Ship a `tuck-patterns` package (or registry-on-disk at `~/.tuck/patterns/*.json`) that the detector loads at runtime.
- Open a community-contributable registry repo (separate from tuck itself) where adding "Cursor 0.50 added a new config path" is a one-line PR to a JSON file.
- Local override: `~/.tuck/patterns.local.json` for the user's private patterns.

This also fixes a roadmap gap: "Recipes" (v1.3 item 4) and "Plugin Ecosystem" (v2.0 item 16) are the same idea expressed twice. Collapse them into one extensibility surface from the start.

### 3.3 The init.ts complexity bomb
1,747 lines in one file is a maintenance landmine. The flow is: detect → choose-provider → maybe-clone → maybe-create → select-files → commit → push, with auth fallbacks at every step. That's a state machine. Right now it's a linear procedural script with deep nesting.

**Fix:** Refactor into an explicit state machine (or a small workflow library). Each step becomes a pure function `(state) → state | error`. The interactive UI becomes a thin layer over the state machine; the JSON/agent mode reuses the same state machine without prompts. **This is the single change that makes agent-mode actually achievable** — you can't ship reliable non-interactive flows on top of a 12-level-nested prompt tree.

### 3.4 Node.js runtime tax
A fresh Linux box, an SSH'd-into server, a Dockerfile bootstrap, an AI agent's sandbox — none of these come with Node by default. The friction of "install node, install pnpm, install tuck" loses you 80% of the funnel. chezmoi's `curl -sfL https://chezmoi.io/get | sh` produces a working binary in 3 seconds.

**Fix:** Ship a single binary alongside the npm package. Options ranked:
1. **Bun's `bun build --compile`** — produces a single executable. tsup already targets ESM. This is a one-day change.
2. **Deno compile** — clean and signs nicely on macOS, but requires porting some Node-specific bits.
3. **`pkg` / `nexe`** — older, gnarlier, still works.
4. **Rewrite in Go/Rust** — biggest commitment, biggest payoff. Probably wrong move at this stage. Maybe later.

Ship the Bun-compiled binary via `curl -sfL tuck.sh/install | sh`, mirror to Homebrew, and the install story stops being a tax.

### 3.5 No templating means no per-machine reality
This is chezmoi's killer feature for a reason: your work laptop and personal laptop have different `git config user.email` values. Today, tuck users either keep separate branches (gross), separate forks (worse), or `tuck:preserve` markers (only on PowerShell, per README).

**Fix:** Adopt a small, declarative template language. Two viable directions:
- **Handlebars/mustache** with a sandboxed variable set (`os`, `arch`, `hostname`, `profile`, `env.X`). Roadmap item 9 already specs this. Build it now, not in v1.5.
- **Conditional sections via comment markers** (`# tuck:if os=darwin` … `# tuck:endif`) — works in any file format that has line comments. Less expressive but trivially safe.

Pick one. Sandbox aggressively. **Templates execute at restore time, never at storage time** — the file in the repo is always the templated source, never the rendered output. (chezmoi violates this and it confuses people.)

### 3.6 No encryption of tracked files
The README says "never tracks private keys." Fine. But the *useful* use case is encrypted `.ssh/config`, encrypted `.aws/config`, encrypted `.netrc` — files you want to sync but contain sensitive paths/usernames. tuck's `encryptionCommand` exists but doesn't (as far as the code shows) encrypt arbitrary tracked files; it encrypts a keystore.

**Fix:** Wire age (or libsodium-based equivalent) into the file pipeline. `tuck add ~/.ssh/config --encrypt`. The roadmap (v1.6 item 10) specs this well — just *ship it*, and don't ship more new features until this is done. It's the single biggest functional gap vs chezmoi.

### 3.7 Sync conflict handling is "and pray"
`sync.ts:134` does `git pull --rebase` and leaves the user stranded if it fails. This is the one place tuck's "git-native but hides complexity" pitch breaks down hardest. If a user has two machines and forgets to sync one for a week, they will eventually hit this. When they do, they'll either lose data or fall back to raw git — at which point they don't need tuck.

**Fix:** A real merge UI. When pull conflicts, present:
1. Files in conflict, side-by-side diff (`tuck diff --side-by-side` is in the roadmap — pull it forward).
2. Per-file resolution: keep local, keep remote, edit in `$EDITOR`, abort.
3. Snapshot before *and* after, so undo always works.

This is non-trivial UI work but it's also the **only place** where users will think hard about whether tuck is actually safer than raw git.

---

## 4. The agent-native wedge — what it concretely means

If the positioning is "dotfiles for the AI agent era," here's what the product looks like.

### 4.1 First-class AI-config tracking
Add an `agents` category to the detector (it's already there in `detect.ts` — expand it) that captures:
- `CLAUDE.md`, `~/.claude/`, `~/.claude/projects/*/memory/`, `~/.claude/keybindings.json`, `~/.claude/settings.json`
- `.cursorrules`, `.cursor/`, `~/.cursor/`
- `.aider.conf.yml`, `.aider.input.history` (the history you might *not* want tracked — flag it)
- `.github/copilot-instructions.md`, agent skill directories
- `AGENTS.md`, `GEMINI.md`
- `mcp.json`, `~/.config/mcp/`
- Agent memory directories (mem0, supermemory, etc.)

This is real, this is now, and nobody is doing it well. The `awesome-claude-code` repo has an open issue asking for exactly this tool.

### 4.2 Repo-scoped + home-scoped unified
Today, tuck thinks of dotfiles as `$HOME` files. But AI agent configs live in two places: home (global) and per-repo (`./CLAUDE.md`, `./.cursorrules`). A new command surface:

```
tuck context add ./CLAUDE.md      # tracks repo-scoped agent config
tuck context list                  # shows all agent files across all tracked repos
tuck context sync                  # propagates one repo's CLAUDE.md as a template to others
tuck context apply <user>/<repo>   # grab someone's agent config for your own repo
```

This bleeds into a different concept than "dotfiles." That's fine — `tuck` as a name is generic enough.

### 4.3 JSON parity for every command
Concrete inventory of what needs adding (audit your current commands):

| Command | Has `--json` | Has `--yes` | Has `--plan` | Priority |
|---|---|---|---|---|
| `init` | no | no | no | **P0** |
| `sync` | no | partial | no | **P0** |
| `add` | no | n/a | no | P1 |
| `scan` | yes | n/a | n/a | done |
| `apply` | no | yes | no | **P0** |
| `restore` | no | partial | no | P1 |
| `diff` | no | n/a | yes (planned) | P1 |
| `status` | yes | n/a | n/a | done |
| `list` | yes | n/a | n/a | done |
| `doctor` | yes | n/a | n/a | done |
| `secrets scan` | partial | n/a | n/a | P1 |
| `encryption` | no | no | no | P2 |

`init`, `sync`, `apply` non-interactive are the agent-blocking ones. Ship those first.

### 4.4 Structured errors
Today's errors are human-readable strings. For agents, errors need to be structured:

```json
{
  "code": "NOT_INITIALIZED",
  "message": "Tuck is not initialized in this environment.",
  "hint": "Run `tuck init` first.",
  "exit_code": 2
}
```

You already have `TuckError` subclasses. Add `.toJSON()` to the base class. Done.

### 4.5 An `mcp` integration
This is the one piece of speculative work in this section, but it's the highest-leverage. Build a minimal MCP server that exposes tuck as tools to any MCP-compatible agent (Claude Code, Cursor, etc.):

```
tuck mcp serve                    # starts MCP server on stdio
```

Exposes: `list_tracked_files`, `add_file`, `sync`, `diff`, `apply_user_dotfiles`. Now agents can manage dotfiles natively. Nobody else has this. It's a 200-line file once the JSON-everywhere refactor is done.

---

## 5. Generalization: should tuck be just "dotfiles"?

Probably not, in the long run. The core mechanism — "categorize files, track them in git, sync across machines, snapshot before changes, scan for secrets, apply someone else's set" — is more general than dotfiles. It applies to:

- **AI agent configs** (as above)
- **Editor configs** that don't sit in `$HOME` (`./.vscode/`, `./.editorconfig`)
- **Project-level tool configs** (`.prettierrc`, `.eslintrc`, `tsconfig.json`)
- **Personal scripts** in `~/bin` or `~/.local/bin`
- **Browser configs** (Arc, Zen)
- **Window manager configs** (yabai, Aerospace, hyprland)

The data model already supports this — categories are strings. What's missing is the UX for "this file lives in `./` not `~/`" and the manifest for "this set of files moves together as a unit."

**Concrete generalization move:** Introduce a `Bundle` concept above files. A bundle is a named, versionable group of files with metadata. `dotfiles` is a bundle. `claude-code-setup` is a bundle. `my-rust-toolchain` is a bundle. Then `tuck apply <bundle>` makes sense for both "your shell setup" and "your AI agent setup."

The manifest grows one level: bundles → files. Migration is trivial (existing tuck setups = one bundle named "default"). The mental model gets much cleaner.

---

## 6. Plug-and-play / batteries-included

This is the v1.3 roadmap reframed for the agent-era positioning.

### Bundled starter packs
`tuck preset <name>` applies a curated, opinionated bundle to a fresh machine. Each preset is a small JSON+templates package:

- `tuck preset minimal` — sensible bash/zsh + git + ssh defaults
- `tuck preset modern-cli` — eza, bat, ripgrep, fd, zoxide, fzf with aliases
- `tuck preset claude-code` — installs Claude Code, tracks the right config files, sets up hooks
- `tuck preset agent-everything` — Claude Code + Cursor + Aider + mcp + agent skill directories all wired up
- `tuck preset starship` — Starship prompt installed and configured

The roadmap calls these "Recipes" — same idea, just call them "Presets" so people understand "this is a starting point, not a sandwich."

### Bring your own preset
`tuck preset publish my-setup` produces a tarball + manifest that someone else can `tuck preset apply ./my-setup.tar.gz`. Eventually publish to npm as `tuck-preset-*` packages, then a registry. This is the plugin ecosystem (roadmap item 16) done as data, not code — much safer.

### Installer that doesn't suck
`tuck install <tool>` (roadmap item 2) should be a thin shim over the system's actual package manager (`brew`, `apt`, `pacman`, `winget`), with a small JSON file per supported tool that says "here's the brew name, here's the apt name, here's the config file to track after install." Don't reinvent package management. Be a wrapper that *also tracks the result*.

---

## 7. Own formats — yes, but carefully

You should own these formats:

### 7.1 Preset format
A small, declarative JSON/YAML schema for "here's a bundle of files and the templates they need." Document it as a stable contract. Version it. Publish a schema for tooling.

```yaml
name: claude-code
version: 1.0.0
description: Claude Code optimized terminal setup
provides:
  - category: agents
    files:
      - source: templates/CLAUDE.md
        target: ~/.claude/CLAUDE.md
        template: true
      - source: templates/settings.json
        target: ~/.claude/settings.json
      - source: hooks/postRestore.sh
        target: ~/.claude/hooks/postRestore.sh
        permissions: "0755"
requires:
  - tool: claude
    install: "npm i -g @anthropic-ai/claude-code"
hooks:
  postApply:
    - "claude config get >/dev/null || claude /init"
```

### 7.2 Patterns format
The data-driven detection registry (section 3.2). One JSON file per tool or one big registry — either works. Keep it boring.

### 7.3 Manifest format
The current `.tuckmanifest.json` is fine but the *aspirational fields* (`encrypted`, `template`, `permissions`) are tech debt. Either ship them now or remove them from the schema until you do. Right now they're a lie the codebase tells itself.

### Don't own
- A new diff format. Use unified diff.
- A new secret format. Use environment-style placeholders (`{{SECRET_NAME}}`) — already the design.
- A new git workflow. You're git-native; don't fight it.
- A new MCP. Use the standard.

---

## 8. Robustness gaps to close

Concrete, audited holes the test suite can't catch today:

1. **No integration tests for secret backends.** `tests/commands/secrets.test.ts` has 5 tests; zero of them exercise 1Password/Bitwarden/pass. These are exactly the integrations that break silently when the user upgrades their CLI tool.
2. **No crypto round-trip tests.** `encryption.test.ts` tests UI but not encrypt-then-decrypt. Property-based testing here is cheap and finds bugs fast.
3. **No "two machines diverge" integration test.** The sync conflict path (section 3.7) has no test reproducing the actual disaster scenario.
4. **No long-tail filesystem test.** Symlinks pointing outside `$HOME`, broken symlinks, files with weird permissions, files with non-UTF8 names, files larger than 100MB. The 50/100MB warn/block logic exists (`sync.ts:576`) but isn't exercised in CI.
5. **No Windows CI.** README claims Windows support. Without a Windows job in CI, every PR is a roll of the dice. (Check `.github/workflows/ci.yml`.)
6. **No `--dry-run` exists anywhere.** Add it to every destructive command. This is a 1-line change per command and saves hours of "oh god what did I just do."

---

## 9. Roadmap reset

The current `ROADMAP.md` has 20 features across v1.3 → v2.0. I count three that matter for the agent-era wedge:
- v1.3 #1: AI Agent Terminal Setup *(rescope: agent config tracking, not env-var dumping)*
- v1.5 #8/#9: Profiles + Templates *(this is chezmoi parity; necessary table stakes)*
- v1.6 #10: Encryption *(necessary table stakes)*

Here's a tighter sequence that ships in 6–9 months instead of 18+:

### v1.3 — Agent surface area (the wedge)
1. **JSON-everywhere refactor.** Every command gets `--json` and `--yes`. Errors get `.toJSON()`. ~2 weeks of mechanical work.
2. **`tuck context`** — agent-config-aware commands. Tracks `CLAUDE.md`, `.cursorrules`, etc. across home + repo. New top-level surface.
3. **MCP server.** `tuck mcp serve`. Exposes 8–10 tools. ~1 week once #1 is done.
4. **Structured `tuck plan` mode.** Every destructive command shows the plan as JSON before executing.

### v1.4 — Distribution and reach
5. **Single binary** via `bun build --compile`. Ship via `curl | sh`. Mirror to Homebrew, scoop (Windows), AUR.
6. **Renamed package**: `@tuck/cli` not `@prnv/tuck`. (Personal scope reads as "personal project.")
7. **Windows CI.** Real Windows runner, not just "in theory."
8. **Plugin/preset registry**: data-driven, separate repo, contributable via one-line JSON PRs.

### v1.5 — Robustness
9. **Templating.** Sandbox-friendly Handlebars or comment-marker style. Roadmap item 9, just shipped earlier.
10. **Encryption.** Age-based file-level encryption. Roadmap item 10, shipped earlier.
11. **Real merge UI** for sync conflicts. Side-by-side diff + per-file resolution.
12. **`--dry-run` on every destructive command.**
13. **`init.ts` state-machine refactor.** Pre-requisite for the JSON mode being reliable.

### v1.6 — Generalization
14. **Bundles** as a level above files. Migration path from "default bundle = current behavior."
15. **Repo-scoped tracking.** `tuck context add ./CLAUDE.md` works in any git repo, not just `$HOME`.
16. **Presets.** ~10 curated bundles shipped at v1.6 launch. `tuck preset apply claude-code`.

### Cut from the roadmap (or push to v2+)
- v1.3 #3 "Guided Terminal Setup Wizard" — overlap with #4 Recipes. Roll into presets.
- v1.3 #4 "Recipe System" — becomes "presets," but ship the *format*, not the *registry*, in v1.6.
- v1.4 #5 "Validation" — nice to have, low leverage. v2.
- v1.4 #7 "Dependency Tracking" — interesting, but third-priority. v2.
- v1.6 #11 "Enhanced Diff Viewer" — merge into the merge UI work.
- v1.7 #12 "Migration Tools" — important for adoption, **prioritize the chezmoi importer** (everyone else is rounding error).
- v1.7 #13 "Flexible Backends" — already done; remove from roadmap.
- v2.0 #14–20 — half of these (web dashboard, real-time sync, team support, AI-assisted config) are speculative. Don't list them publicly until the wedge has landed. They distract from what's actually shipping.

---

## 10. Adoption — how more people actually start using it

Strategy, not tactics. Tactics are easy once the strategy is right.

1. **Be the tool the next "awesome-claude-code-style" repo links to.** When someone writes "manage your AI agent configs across machines," they should link to tuck. That requires (a) the agent-native surface area in §4, (b) docs/examples that say "here's how to share your CLAUDE.md across all your repos with one command."
2. **Ship a `curl | sh` install.** §3.4. Until install is a single line, you'll keep losing servers, sandboxes, and agents.
3. **One canonical demo.** A 60-second video: "this is my new MacBook. `curl | sh && tuck apply prnv/dotfiles`. Done." Put it at the top of the README. tuck.sh should autoplay it.
4. **Cross-post the migration story.** Write "I switched from chezmoi to tuck and here's what I gained and lost." Honest. People share honest comparisons; they ignore marketing.
5. **MCP is a Trojan horse.** When tuck has an MCP server, it shows up in Claude Code's "tools available" list. That's free distribution to the most relevant audience.
6. **`tuck apply <github-user>` is a social loop.** Lean into it. Make it easier to share dotfiles, easier to fork them, easier to remix. The "dotfiles as gist" social pattern is real and tuck is the only tool positioned to own it.
7. **A real domain story.** `tuck.sh` exists. Use it as more than a landing page. Host a registry of presets/bundles, a public list of "people whose dotfiles you might want to copy," a `tuck doctor` audit submission service.
8. **Be honest about what tuck doesn't do.** A comparison table on the homepage that says "chezmoi has Go-template power; tuck doesn't (yet)" earns more trust than five paragraphs of "modern beautiful CLI."

---

## 11. Things to kill or aggressively de-prioritize

- The "modern beautiful CLI" pitch as the headline value prop. It's a feature, not a wedge.
- The 1,765-line `ROADMAP.md` as public-facing. Replace with a 1-page "next 3 quarters" plan; archive the rest.
- v2.0 speculative features in the public docs. They are distractions and they make tuck look unfocused.
- `@prnv/tuck` as the package name. Rename now while user count is small.
- Aspirational manifest fields (`encrypted`, `template`, `permissions`) until they're actually used. Either ship them or remove them.
- The README's claim "secrets manager? never" — but then there's a whole secrets subsystem. Tighten the messaging: tuck manages *references* to secrets via external managers; it doesn't store secret values in tracked files. That's a real, defensible position.

---

## 12. Open questions for the maintainer

Things I'd want answered before committing to the plan above:

1. **Is the wedge — "dotfiles for AI agents" — interesting to you, or are you building this for the dotfiles ecosystem?** They're different products.
2. **Are you willing to drop Node-only and ship a single binary?** Bun-compile is low-cost; it's mostly about CI complexity and signing on macOS.
3. **What's the realistic time budget?** v1.3 (agent surface + JSON) is ~6 focused weeks of work. Templating + encryption is another 6. If this is nights/weekends, the schedule doubles.
4. **Is there a co-maintainer story?** A solo-maintainer Node CLI in a category dominated by a solo-maintainer Go CLI is hard. Worth bringing one or two contributors in early.
5. **Monetization story, if any?** A hosted preset registry? `tuck.sh` paid tier for teams? Doesn't matter today, but it shapes which features get priority later.

---

## 13. Appendix: where tuck stands vs the field

A condensed version of the competitive landscape that informed this doc:

| Tool | Stars | Lang | Wedge | tuck's gap to it |
|---|---|---|---|---|
| chezmoi | ~19.7k | Go | Templates + encryption + password mgr; single binary | Templates, encryption, single binary |
| yadm | ~6.3k | Bash | Files stay in `$HOME`; trivial for git users | tuck already wins on UX, loses on simplicity |
| stow | OG | C | Symlink farm; pure Unix; rock-solid | Different model; tuck doesn't compete here |
| dotbot | ~7.9k | Python | YAML bootstrap config; plugin ecosystem | tuck has better runtime UX, lacks plugin maturity |
| home-manager | ~9.8k | Nix | Atomic reproducibility | Different universe; not a competitor |
| bare git | n/a | n/a | No tool, just git | tuck wins on discovery, loses on simplicity |
| **tuck today** | TBD | TS | Beautiful UX, multi-provider scan + push wizard | — |
| **tuck if it takes the agent wedge** | TBD | TS | Only tool managing AI agent configs as first-class dotfiles, JSON-everywhere, MCP-native | — |

The right way to read this table: tuck doesn't need to be the best dotfiles manager. It needs to be the **only** dotfiles manager that takes AI agents seriously as users of, and operators within, the tool. Take that wedge, ship the supporting infrastructure (single binary, JSON, MCP, encryption, templates — in that order), and tuck has a defensible category nobody else is fighting for.

---

*Written 2026-05-20. Subject to violent disagreement.*
