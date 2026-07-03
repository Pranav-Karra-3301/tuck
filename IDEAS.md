# IDEAS.md — tuck Roadmap Ideas

> Synthesized from a survey of pain points across the dotfiles ecosystem: chezmoi, yadm, GNU Stow, dotter, dotbot issue trackers; HN threads; the AI-agent config tooling scene; and secrets-management practitioner writeups. Every idea below is anchored to a documented, unresolved community complaint.

tuck's structural advantages are already unusual: home-directory-as-source-of-truth, a shipped MCP server, 8 secret backends with decrypt-on-apply, time-machine snapshots, smart merging, and repo-scoped tracking. The biggest open lane is **agent-first dotfiles management** — no competitor is even trying, single-purpose tools keep spawning to fill the gap (claude-sync, claude-code-dotfiles, mcp-desktop), and tuck's MCP server means we're the only dotfiles manager an agent can already drive. The second lane is the **bootstrap gap** every manager punts on (packages, OS settings, one-command machine setup). The third is turning tuck's secrets machinery from a safety net into a headline UX.

**Effort key:** S = days, M = 1–2 weeks, L = multi-week.

---

## Top 10 Shortlist

| # | Idea | Theme | Effort | Why now |
|---|------|-------|--------|---------|
| 1 | JSON-path-scoped tracking (`tuck add --key mcpServers`) | Agent-first | M | Genuinely novel; no manager can track part of a JSON file |
| 2 | AI agent config presets (`--preset claude-code`, `cursor`, `codex`) | Agent-first | S | Multiple single-purpose tools exist just for this; one command kills them |
| 3 | Agent-native CLI audit (`--json`, `--yes`, TTY-honest everywhere) | Agent-first | M | Cements the MCP lead; "the dotfiles tool agents can drive" |
| 4 | Rules fan-out (one AGENTS.md → CLAUDE.md, .cursorrules, copilot-instructions…) | Agent-first | M | The five-files problem has no dotfiles-native answer |
| 5 | `tuck packages` — declarative cross-platform package management | Bootstrap | L | chezmoi declares it out of scope; the single biggest declared gap |
| 6 | `tuck bootstrap <repo>` — one curl-able, idempotent machine setup | Bootstrap | M | Everyone hand-rolls a rotting bootstrap.sh |
| 7 | Auto-capture sync (`tuck sync --auto` + watcher) | Power | M | Directly answers chezmoi's "using it backwards" discussion; our model wins here |
| 8 | Per-platform target path mapping | Power | M | chezmoi's most-upvoted open issue (84 reactions) |
| 9 | Fix-instead-of-block secret remediation | Secrets UX | S | Scanner says "no" everywhere else; tuck can say "yes, fixed" |
| 10 | Multi-source layering (team repo + personal overlay) | Collaboration | L | Fig is dead; chezmoi closed it unresolved; open-source successor slot is empty |

---

## Theme 1: Agent-First Features

tuck already ships an MCP server. Extend that lead — no other dotfiles manager assumes anything but a human at the keyboard, and the AI-agent config ecosystem is currently held together with symlinks, LaunchAgents, and copy scripts.

### 1.1 JSON-Path-Scoped Tracking — `tuck add ~/.claude.json --key mcpServers` (M)

**Pitch:** Track a *subtree* of a JSON file instead of the whole file. tuck extracts only the specified key path (e.g. `mcpServers`) into the repo, and on apply deep-merges it back into the live file, leaving machine-managed keys, session caches, and OAuth tokens untouched. Generalizes to VS Code `settings.json` and any other mixed config/state file.

**Why the community lacks it:** `~/.claude.json` is a 1300+-line monolith mixing durable MCP config with conversation history and 40+ machine-managed keys, so whole-file tracking or symlinking is impossible — MCP config is "invisible to dotfiles/config managers and at risk of being lost." No dotfiles manager can track part of a file. (anthropics/claude-code #9794, #32145, #4938)

### 1.2 AI Agent Config Presets — `tuck add --preset claude-code` (S)

**Pitch:** One command that knows exactly which files under `~/.claude` are safe to track (CLAUDE.md, settings.json, commands/, skills/, agents/, hooks/, rules/) and which must be excluded (settings.local.json, CLAUDE.local.md, credentials, history, sessions, projects/, plugin cache). Ship the same for `--preset cursor` (including per-OS Application Support paths), `codex`, `gemini`, `copilot`. Turns a hand-rolled allowlist ritual into one command.

**Why the community lacks it:** Multiple single-purpose tools exist *solely* to sync `~/.claude` (claude-code-dotfiles, claude-sync, Claude Sync), plus blog posts describing custom macOS LaunchAgents that pull/rebase/commit/push on every change — proof that generic managers aren't solving it. Cursor has years of open "sync settings between devices" forum threads and no answer at all. (github.com/elizabethfuentes12/claude-code-dotfiles; github.com/baptisterajaut/claude-sync; forum.cursor.com/t/we-need-ability-to-sync-settings-between-devices/153503)

### 1.3 Agent-Native CLI Audit — uniform `--json`, `--yes`, honest TTY detection (M)

**Pitch:** Audit every tuck command: guaranteed non-interactive path (`--yes` / `--non-interactive` / fail-fast when no TTY), one consistent `--json` flag with documented, versioned output schemas, results to stdout / diagnostics to stderr, ANSI suppressed when not a terminal, and machine-readable error codes (tuck's typed errors already carry code + suggestion — expose them in JSON). Then position: "the agent-native dotfiles manager" — MCP server plus a JSON CLI that agents can safely drive.

**Why the community lacks it:** "Agents would start a workflow, hit an interactive prompt, and get stuck." The emerging agent-CLI bar is `--json` everywhere, `--no-input` everywhere, and schemas treated as stable contracts (Codex's `--json` docs drifting broke every parser, openai/codex #4776). chezmoi/stow/yadm all assume a human; tuck is @clack/prompts-heavy today, which is exactly the hazard — and exactly the opportunity. (speakeasy.com/blog/engineering-agent-friendly-cli; blog.arcjet.com/designing-a-cli-for-ai-agents)

### 1.4 Rules Fan-Out — one canonical AGENTS.md, materialized per tool (M)

**Pitch:** Track one canonical rules source; on `tuck apply`, materialize or symlink each tool-specific variant (CLAUDE.md, .cursorrules/.cursor/rules, .windsurfrules, copilot-instructions.md, GEMINI.md) per repo or globally, with per-tool overrides via tuck's existing templating. Repo-scoped tracking plus templating means tuck is uniquely positioned to keep the whole set in lockstep.

**Why the community lacks it:** Teams "copy the same paragraph into five files, forget which one is canonical, and six weeks later the agents are following conflicting orders." Current workarounds are symlinks, cp-as-generated-artifact, and hand-written pre-commit hooks targeting 8 filenames; converter tools like Rule-porter exist because nothing manages this. (agentrulegen.com/guides/cursorrules-vs-claude-md; forum.cursor.com/t/rule-porter…/153197)

### 1.5 MCP Fleet Management — define servers once, render per client (M)

**Pitch:** Declare MCP servers once in tuck's config (name, command/url, env, transport) and render each client's format (Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, JetBrains) via tuck's templating on apply — with credentials injected from tuck's secret backends at apply time. tuck becomes the git-versioned source of truth for a user's MCP fleet across all clients and machines.

**Why the community lacks it:** "The configuration format varies between clients — Claude Desktop uses one JSON structure, Cursor uses another, VS Code uses a third." Desktop GUI apps and even an MCP server exist purely to write one definition into every client's format — but nothing does it dotfiles-natively with git history. (github.com/vinkius-labs/mcp-desktop; glama.ai mcp-client-configuration-server)

### 1.6 MCP Secrets Extraction — `tuck secrets extract --mcp` (M)

**Pitch:** Add scanner patterns and target paths for `mcp.json`, `.mcp.json`, `~/.claude.json`, Claude Desktop config, `.cursor/mcp.json`; then a one-shot command that rewrites inline env credentials into tuck template placeholders backed by 1Password/keychain/age and injects them on apply. Also emit `${env:VAR}` / `op run`-style references for clients that support them.

**Why the community lacks it:** ~48% of reviewed MCP servers recommend plaintext credentials in .env/JSON config; keys sit cleartext in mcp.json, get committed to dotfiles repos and backed up to iCloud, with "no clean rotation story." 1Password and Doppler are publishing guides because the ecosystem has no built-in answer. (doppler.com/blog/mcp-server-secure-secrets-management; 1password.com blog on MCP credential exposure)

### 1.7 Structured JSON Smart Merge — three-way merge for agent-mutated configs (L)

**Pitch:** Extend tuck's smart-merge (currently shell files) to key-level three-way JSON merge: union permission allowlists in Claude settings, merge plugin lists, configurable per-file merge policy in the manifest, and conflict surfacing instead of silent overwrite on `tuck sync`. This is the missing piece that makes syncing high-churn, tool-rewritten config files safe.

**Why the community lacks it:** Agent tools constantly rewrite their own configs (Claude Code appends redundant permission entries — anthropics/claude-code #27139), so naive push/pull loses data. claude-sync's *entire* differentiator is three-way conflict detection because "competing solutions use simple push/pull operations (risking data loss)." (github.com/baptisterajaut/claude-sync)

### 1.8 Cross-Agent Config Translation (M)

**Pitch:** Map common concepts (global instructions file, per-repo rules, MCP servers, ignore patterns) across Claude Code / Codex / Gemini CLI / Cursor so `tuck apply` populates a newly-adopted agent from canonical tracked config. Even a v1 that symlinks `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` to one tracked file addresses documented behavior. Natural follow-on to 1.2 and 1.4.

**Why the community lacks it:** People using multiple agent CLIs write personal glue scripts to mirror config between them ("How I keep Claude Code and Codex in sync"), and accumulated prompts/skills don't port when users hop agents. (stafforini.com/notes/how-i-keep-claude-code-and-codex-in-sync)

### 1.9 Remote / SSH Apply — agent configs onto every box (M)

**Pitch:** `tuck apply --target ssh://host` (or a documented one-liner bootstrap) that pushes agent configs onto SSH boxes and remote dev servers. Pairs with the Cursor preset for the exact ".cursor folder onto every server I SSH into" request.

**Why the community lacks it:** Cursor forum's newest sync request is auto-syncing `.cursor` (rules, skills) when SSH-ing into a server; the current answer is git repos plus manual symlinks. (forum.cursor.com/t/sync-cursor-folder-across-instances/161749)

---

## Theme 2: Onboarding / Bootstrap

### 2.1 `tuck packages` — declarative cross-platform package management (L)

**Pitch:** A declarative package list in the manifest with per-OS sections (brew/apt/dnf/winget/scoop/cargo/npm -g): `tuck packages dump` (cross-platform `brew bundle dump`), `tuck packages diff` (installed vs declared), and `tuck apply --packages` installing missing packages in the right phase before dotfiles are linked. Uninstall detection ("these 3 installed packages are not in your manifest") closes the loop chezmoi refuses to.

**Why the community lacks it:** chezmoi explicitly declares cross-platform package management out of scope and defers to hand-written `run_onchange_` scripts; a user begged for "a simple YAML file listing apps" and found nothing; yadm has an open winget request; dotbot's top issues are all conditional-task workarounds for this. It is the biggest declared gap in the category. (chezmoi.io install-packages-declaratively docs; chezmoi discussions #1733, #4650; yadm #496; dotbot #81/#225/#312)

### 2.2 `tuck bootstrap <repo>` — one-command, idempotent machine setup (M)

**Pitch:** A single curl-able entry point: install tuck, clone the repo, resolve the secrets backend, install packages, apply dotfiles, run `tuck doctor` at the end — fully idempotent, so re-running converges instead of erroring. Pairs with drift detection so setup doesn't rot between machines.

**Why the community lacks it:** Every dotfiles article reinvents a bespoke bootstrap.sh (curl-install + clone + brew bundle + symlink + macOS defaults) and these scripts rot — "eventually I get lazy and don't bother checking stuff in"; "half of the steps fail immediately because they were already applied." (HN id=34296396; dotfiles.github.io/bootstrap; arslan.io on idempotent bash)

### 2.3 Declarative Bootstrap Plan — phases and dependencies, not filename hacks (M)

**Pitch:** Manifest entries declare `requires: [brew:starship, apt:zsh]`; `tuck apply` topologically orders packages → files → post-hooks, shows the plan first (the MCP server already has `apply_plan`), and fails with a clear "X needs Y" message instead of a broken shell on first login.

**Why the community lacks it:** chezmoi users encode ordering in filename prefixes (`run_before_00_…`) and hit "inconsistent state" failures when script variants conflict (#3947); even Homebrew had taps installed after their dependents (#21416). There is no way anywhere to declare "this dotfile needs this tool first."

### 2.4 Safe First Apply — diff summary + auto-snapshot + adopt-first init (S)

**Pitch:** `tuck apply` on a fresh machine always shows a full diff summary and auto-creates a time-machine snapshot before touching anything (tuck has snapshots — surface them in the flow and the docs), and `tuck init` offers the scan-based "adopt existing dotfiles" path first. Ship a 60-second quick start with zero templating concepts.

**Why the community lacks it:** chezmoi's "first apply is destructive — if $HOME already has hand-edited dotfiles, apply overwrites them" (HN id=32636051), and a maintainer-acknowledged issue exists about users not understanding the quick start (#4955). Stow tutorials are widely described as confusing. Mostly docs + flow polish on existing machinery.

### 2.5 Container / Ephemeral Environment Profile Apply (M)

**Pitch:** A headless one-liner optimized for devcontainers, Codespaces, and SSH agent sandboxes: `curl tuck.sh | sh -s -- apply --profile agent --yes` clones and applies only a named subset (agent configs; no secrets, or secrets from env), plus shipped devcontainer.json and Codespaces dotfiles templates. Profiles/subset-apply is the key primitive: nobody wants their full dotfiles — or their credentials — in every ephemeral sandbox.

**Why the community lacks it:** The current answer is bind-mounting the whole host `~/.claude` into containers, which drags credentials and history into the sandbox; chezmoi's dedicated "Containers and VMs" guide shows the demand, but nothing offers an agent-config-only minimal bootstrap. (markphelps.me on agents in devcontainers; github.com/orgs/community/discussions/134612)

### 2.6 `tuck settings` — versioned OS settings (macOS defaults, dconf) (L)

**Pitch:** (a) Capture mode that diffs `defaults` domains (dconf on Linux) while the user changes a setting in the GUI, recording the write command with the OS version it was captured on; (b) apply mode that replays with per-OS-version guards and auto-restarts affected apps; (c) a tracked manual-steps checklist ("do-nothing scripting") for things that can't be automated — tuck shows the instruction, user confirms, tuck remembers per machine.

**Why the community lacks it:** The 30k-star mathiasbynens `.macos` script is the canonical workaround: undocumented commands, silent breakage across macOS versions, manual `defaults read`/diff/grep discovery. A real new-Mac post-mortem concluded dotfiles "only gets you so far." (gushi.medium.com; emmer.dev/blog/automate-your-macos-defaults; HN id=42976698)

### 2.7 Package Drift Reconciliation (M)

**Pitch:** Extend tuck's drift/verify machinery to package state: `tuck status` shows "declared but not installed / installed but not declared" per package manager; `tuck sync` optionally folds newly installed packages into the manifest with an interactive prune step (like `tuck scan` does for files); a .tuckignore-style list handles cloud-self-syncing apps (VS Code Settings Sync) so they never pollute the repo. Follow-on to 2.1.

**Why the community lacks it:** Brewfiles capture "a few years of cruft" that must be manually pruned; `brew bundle check` output is unhelpful (#320); dump round-trips lose data (#22668, #20870); nothing continuously reconciles installed state with the repo. (respawn.io/posts/dotfiles-brew-bundle-and-mackup)

---

## Theme 3: Secrets UX

tuck already has the scanner, redactor, 8 backends, and decrypt-on-apply. These ideas convert that plumbing into visible, differentiating UX.

### 3.1 Fix-Instead-of-Block Remediation (S)

**Pitch:** When the scanner flags a value at sync time, offer one-keystroke remediation: redact-and-store into the configured backend and rewrite the file as a template — plus a centralized, auditable allowlist (`tuck secrets allow`) instead of inline ignore comments. tuck has every piece; the gap competitors leave is the interactive path from "no" to "yes, fixed."

**Why the community lacks it:** gitleaks-style pre-commit hooks hard-block with false positives, so developers prepend `SKIP=gitleaks` or disable the hooks entirely — "if developers see pre-commit hooks as annoying friction, they will bypass them." (gitleaks #579; dev.to gitleaks workflow writeup)

### 3.2 Value-Level (SOPS-Style) Encryption for Dotfiles (L)

**Pitch:** Encrypt only the secret values in place; keep keys, structure, and comments plaintext so git diff/merge/review keep working. tuck's redactor already locates secret spans — encrypting those spans instead of redacting is a natural extension, and it makes tuck the first manager where encrypted configs stay diffable.

**Why the community lacks it:** git-crypt "does not support merging" and silently treats conflicting encrypted files as unchanged; users can't review diffs of encrypted configs at all. SOPS is beloved in infra for exactly this property, but nothing brings it to dotfiles ergonomically. (git-crypt #140, #20; GitGuardian SOPS guide)

### 3.3 Read-Only Commands Never Prompt (S)

**Pitch:** Guarantee that `status`/`diff`/`list` never touch a secret backend: diff against stored placeholders and keyed plaintext checksums (HMAC) so drift detection needs zero decryptions, plus a session agent caching the unlocked key with a TTL (at most one prompt per session). Advertise the guarantee explicitly.

**Why the community lacks it:** In chezmoi, "every chezmoi command wanted me to login to BitWarden so that the templates could be reconciled" (discussion #3202); encrypted-file re-prompting is an open, unresolved issue where a user proposed checksums and nothing was implemented (#3747, #1782).

### 3.4 `tuck secrets scrub` — guided history rewrite (M)

**Pitch:** Since tuck owns its repo, it can safely run a guided history rewrite (filter-repo under the hood): snapshot first via time-machine, rewrite, re-push, verify the remote no longer contains the string, and print a per-provider "this key is burned, rotate it" checklist. No other manager offers one-command history remediation.

**Why the community lacks it:** A study of dotfiles repos found 9,452 exposed private keys; guides stress that deleting the file in a later commit is not enough, and the actual fix (filter-repo/BFG + force-push) is scary enough that most users get it wrong while bots harvest pushed keys within seconds. (MPG study; dev.to and instatunnel writeups)

### 3.5 `tuck secrets rotate <name>` + secret-age tracking (M)

**Pitch:** tuck knows each secret's provider from its detection patterns, so it can deep-link the provider's revoke/rotate page (howtorotate-style playbooks), update the value in the configured backend, re-render templates on apply, and log the rotation. Add age tracking to `tuck doctor`: "AWS key is 14 months old — rotate?"

**Why the community lacks it:** Rotation is a manual, provider-specific scavenger hunt — an entire community site (howtorotate.com) exists solely to document per-provider steps. (howtorotate.com; Truffle Security on rotation as the only real remediation)

### 3.6 Machine-Scoped Secret Namespaces (S)

**Pitch:** `tuck secrets set OPENAI_KEY --machine work-laptop`: same secret name, different value per machine, with template resolution picking the host-scoped value first and falling back to a default. One template, per-host values — no branches, no hostname-suffix symlink tricks.

**Why the community lacks it:** ArchWiki documents per-hostname branches that "need to be rebased" constantly and hostname-suffixed symlinks as the state of the art; HN threads repeatedly name host-specific secrets as the hard part of syncing. (wiki.archlinux.org/title/Dotfiles; HN id=32636051)

### 3.7 Touch ID / Keychain Unlock (M)

**Pitch:** First-class biometric unlock for tuck's local secret store: store the store key in the macOS Keychain guarded by LocalAuthentication (small helper binary), with a configurable grace window so repeated applies within N minutes don't re-prompt. Fall back to passphrase or libsecret/keyring on Linux.

**Why the community lacks it:** No manager supports biometric unlock natively; macOS users bolt together pinentry-touchid + gpg-agent + Keychain themselves, and even 1Password's biometric flow "interrupts flow when opening terminals in quick succession." (jorgelbg.me pinentry-touchid; magarcia.io)

### 3.8 `tuck secrets env` — instant shell startup with backend-stored secrets (M)

**Pitch:** Render tracked secrets once into a session-cached, encrypted env snippet (unlocked once per login via the agent/biometric flow) that shells source in milliseconds, with a TTL and an explicit refresh command. Bridges "secrets live in a backend" with "shell startup must be instant."

**Why the community lacks it:** Each `op read` costs a subprocess and API call; users report 15–20s startup loading multiple credentials — so they give up and hardcode exports in .zshrc, putting plaintext back into the exact files dotfiles managers publish. (mise discussion #3542; gruntwork.io 1Password/zsh guide)

---

## Theme 4: Collaboration & Sharing

### 4.1 Multi-Source Layering — team repo + personal overlay (L)

**Pitch:** `tuck layer add <repo>` stacks an org/team repo under personal dotfiles with defined precedence, per-layer manifests, conflict prompts on overlapping paths, and per-layer push targets so personal changes never leak into the team repo. tuck's manifest + repo-scoped tracking is a natural fit for "company base + department + personal."

**Why the community lacks it:** chezmoi #1169 ("multiple repos as source") asked to merge a public team repo with private personal settings — closed unresolved since 2021; #3719 (2024) notes "externals don't allow editing relevant files, and completely separate repos don't allow sharing common things."

### 4.2 The Open-Source Fig Replacement — team onboarding (M, mostly composition + positioning)

**Pitch:** `tuck init --from git@github.com/org/dotfiles` merges a team layer into personal setup in one command: shared aliases, hooks/scripts via the existing hooks system, and team secret *references* resolved through tuck's backends (1Password/Vault) instead of Fig's proprietary sharing. Builds directly on 4.1.

**Why the community lacks it:** Fig pitched exactly this — "a lack of a source of truth for a team's dotfiles that can easily be synced and merged with personal dotfiles" — then Amazon acquired and sunset it (Sept 2024), dropping Scripts, Dotfiles, Plugins, and shared secrets, leaving users asking for replacements. The commercial slot is empty. (fig.io/blog/post/dotfiles-launch; HN id=39683889; withfig/fig #2936)

### 4.3 `tuck try <git-url>` — safely preview a stranger's dotfiles (M)

**Pitch:** Clone someone's dotfiles, show a full apply plan (every file it would write, every hook it would run) with diffs against your current files, run the secret scanner over incoming files, refuse arbitrary script execution by default, and take an automatic snapshot so `tuck undo` restores everything. Optional `--sandbox` materializes into a throwaway $HOME/container.

**Why the community lacks it:** The standard mechanism for trying a rice is an opaque `curl | bash` or install.sh with no dry-run and no rollback; HN threads show developers judging script safety "based on vibes," and real users hit breakage running r/unixporn install scripts. (HN id=10277470, id=37489947; ZhongXiLu/dotfiles #1)

### 4.4 `tuck import <repo> --only nvim,tmux` — snippet-level forking with an update path (M)

**Pitch:** Cherry-pick specific tools/paths from another dotfiles repo into your own manifest, recording provenance (source repo + commit) per imported file. Later, `tuck import --check` diffs your copy against upstream so you can pull improvements selectively — structured partial adoption, which neither wholesale forking nor copy-paste gives.

**Why the community lacks it:** Forks diverge and merge history makes pulling upstream improvements "almost impossible"; the community settled on manual copy-paste ("grab bits and pieces") with zero tooling support. (jmsbrdy.com "Are dotfiles meant to be forked?"; zachholman.com)

### 4.5 `tuck share` — one-command safe public export (M)

**Pitch:** Build a publishable copy of the repo where the existing scanner/redactor strips or templates every detected secret, work/repo-scoped files are excluded by policy, and the output is a clean public repo or gist with a generated README of tracked tools. Turns tuck's secrets machinery into the thing that *unlocks* sharing rather than just protecting sync.

**Why the community lacks it:** HN's "Dotfiles feel too personal to share" thread (id=44812611) centers on fear of leaking API keys, SSH configs, and internal hostnames; the workaround is a fragile hand-maintained public-repo + untracked .localrc split. The demand side exists — "I learned so much about vim and zsh just by reading other people's configuration."

### 4.6 `tuck publish` / `tuck compare` — Dotfyle for everything (L)

**Pitch:** tuck already knows exactly what each user tracks (manifest + detect.ts categories). Opt-in anonymized, secret-redacted publishing of a tool inventory enables Dotfyle-style "what do people use for X" stats across shell/git/tmux/terminals, plus `tuck compare <user|preset>` to diff your setup against a popular one and see what you're missing.

**Why the community lacks it:** Dotfyle proved demand for structured config discovery but only covers Neovim; everything else is static curated lists and raw GitHub search. (github.com/codicocodes/dotfyle; dotfiles.github.io)

---

## Theme 5: Power Features

### 5.1 Auto-Capture Sync — home as source of truth, automated (M)

**Pitch:** Double down on tuck's headline model: a login hook / launchd-systemd watcher or `tuck sync --auto` detects drifted tracked files, runs secret redaction, commits, and pushes without prompting per file. Market it directly against chezmoi's edit-in-source friction.

**Why the community lacks it:** Chezmoi's most vocal recurring complaint is that its workflow fights how people work — apps and habit edit $HOME directly; users describe "using chezmoi backwards," merge-all "impractical at scale," re-add missing changes, and "continuous merge loops." (chezmoi discussions #4420, #4928; HN id=48588413)

### 5.2 Per-Platform Target Path Mapping (M)

**Pitch:** One tracked entry, multiple destinations: `targets: { darwin: ~/Library/Fonts/…, linux: ~/.local/share/fonts/… }` (or template variables in paths), so `tuck apply` places files at the right OS-specific location. Ship built-in mappings for common apps (VS Code, fonts, gh, kitty).

**Why the community lacks it:** This is chezmoi's single most-upvoted open issue (#2273, 84 reactions, open since v3 planning), and dotter's top open issue too (#61). Straightforward in tuck's manifest model.

### 5.3 Directory-Tracking Mode — `tuck add ~/.config/nvim --dir` (M)

**Pitch:** Record the directory (with optional glob/ignore) in the manifest; `tuck sync` rescans it, auto-adds new files, and detects deletions/renames with a confirmable, snapshot-backed removal proposal. Closes two open chezmoi asks with one feature.

**Why the community lacks it:** chezmoi's add/re-add only captures files that existed at add time — #2298 (20 reactions, open for years) plus #4361 (no automated sync of deletions/renames, 12 reactions).

### 5.4 Profiles / Tags — work vs personal at the *set* level (M)

**Pitch:** Each tracked file, package, and setting can carry tags (work, personal, server, minimal). `tuck apply --profile work` — or a profile chosen at init and remembered — selects the subset; `tuck status` shows the machine's bound profile and flags files that leaked across profiles. Combines with templating and secrets backends (work uses Vault, personal uses 1Password). Also the primitive behind 2.5's `--profile agent`.

**Why the community lacks it:** chezmoi handles work/personal only at the value level (template a different git email); subset selection across files AND packages AND settings remains scripting. Blog authors call per-machine differences "the biggest pain point"; privacy-conscious users maintain entirely separate repos. (HN id=34296396; rifqimfahmi.dev; theprivacydad.com)

### 5.5 Drift Visibility & Nudges (S)

**Pitch:** `tuck status`/`tuck doctor` show "N files drifted, M commits unpushed, last sync X days ago"; optional shell-prompt segment or login-time one-liner; scheduled `tuck sync` via cron/launchd; a lightweight "machines" view showing when each machine last pushed.

**Why the community lacks it:** Forgetting to commit/push is the #1 complaint about "just use git" and Stow setups — "every edit writes straight through the link into that machine's clone," so uncommitted tweaks silently accumulate for months and cherry-pick pain follows. (HN id=45081764, id=48588413)

### 5.6 Editor-Friendly Templating + `tuck template lint/preview` (S)

**Pitch:** tuck templates the repo copy while the live file stays plain — guarantee that template annotations never change the filename/extension (sidecar metadata or comment-syntax-aware markers), and advertise "your editor tooling keeps working." Add `tuck template lint` / `preview` with clear error messages.

**Why the community lacks it:** chezmoi's `.tmpl` suffix destroys syntax highlighting, LSP, and formatters (#3767); a whole discussion exists on formatter/linter complaints (#2426); Go-template errors are "terse, making debugging difficult." tuck's architecture already sidesteps the problem — make it a promise.

---

## Theme 6: Quick Wins

Small, shippable, each answering a named open issue at a competitor.

### 6.1 Gitignore-Compatible .tuckignore + `tuck check-ignore` (S)

**Pitch:** Proper `!pattern` negation at any depth, explicitly tested nested-unignore cases, and a `tuck check-ignore <path>` debugger that explains *why* a file is included or excluded. Low-cost, high-goodwill: every competitor has this papercut open. (chezmoi #4636, #3097; dotter #181 — its second-most-upvoted issue; yadm #329)

### 6.2 Bulk Conflict Resolution — `--accept-local` / `--accept-repo` (S)

**Pitch:** Explicit per-file and bulk resolution strategies on `tuck sync`/`tuck apply`, plus a per-file config default ("this file is app-managed, always accept local" — iTerm2 et al.), reusing tuck's merge.ts for the interactive path. Small feature, existing named audience. (chezmoi #2162 "inverse of overwrite," 26 reactions, labeled v3, still open; dotter #193)

### 6.3 Per-File Encryption/Secret Status in `tuck status` (S)

**Pitch:** Show each tracked file's secret/encryption state (encrypted, templated, contains detected secrets, clean) directly in status output — the exact "more explicit reporting of the status of encrypted files" yadm users have been asking for. (yadm #386)

### 6.4 Migration Importer + "Switching From" Guides (S — in flight)

**Pitch:** Finish the current branch's importer to ingest yadm's encrypted archive and chezmoi's `encrypted_` files / `.chezmoidata` into tuck secrets, then publish "switching from yadm/chezmoi" guides keyed to their exact open issues. tuck already has all 8 backends yadm's roadmap issue asks for — the gap is migration and marketing, not features. (yadm #483, #137)

### 6.5 Surface Snapshots in Every Destructive Flow (S)

**Pitch:** Make the time-machine snapshot visible and automatic in `apply`, `sync` conflict resolution, `try`, and `scrub` flows, with a one-line "restore with `tuck undo`" breadcrumb after every mutation. Turns an existing feature into the trust story that answers "first apply is destructive" fear. (HN id=32636051; chezmoi #4955)

---

## Suggested Sequencing

1. **Now (extends current work):** 6.4 migration importer → 6.1–6.3, 6.5 quick wins → 1.2 agent presets (small, loud launch).
2. **Next (the agent-native release):** 1.3 CLI audit + 1.1 JSON-path tracking + 1.4 rules fan-out — this is the release that makes "agent-native dotfiles manager" the positioning, compounding the MCP server.
3. **Then (the bootstrap release):** 5.4 profiles → 2.2 bootstrap → 2.1 packages → 2.3 plan/dependencies.
4. **Ongoing differentiators:** 5.1 auto-capture, 3.1/3.3 secrets UX, 4.1 layering as the collaboration bet.
