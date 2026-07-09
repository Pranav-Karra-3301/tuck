# Agent-Native CLI

tuck is designed to be driven safely by AI agents, scripts, and CI — not just
humans at a terminal. This document is the contract for that automation surface:
what to pass, what you get back, and how failures are reported.

> The emerging bar for an agent-friendly CLI is: `--json` everywhere, a guaranteed
> non-interactive path everywhere, and output schemas treated as stable contracts.
> tuck follows that bar.

---

## The three flags that matter

| Flag | Effect |
|------|--------|
| `--json` | Emit exactly one JSON envelope on **stdout** and nothing else. Human banners, spinners, and colored logs are suppressed; diagnostics go to **stderr**. |
| `--non-interactive` | Never prompt. If a command would need to ask a question, it fails fast with a typed error instead of hanging. Implied by `--json` and by a non-TTY stdin. |
| `-y, --yes` | Auto-confirm prompts (answer "yes"). Pair with `--json`/`--non-interactive` for full automation of commands that would otherwise ask for confirmation. |

`--non-interactive` is a **global** flag: it can be placed before the subcommand
(`tuck --non-interactive add ...`). `--json` and `--yes` are per-command.

### When does tuck refuse to prompt?

A prompt is refused (fail-fast) when **any** of these is true:

1. `--non-interactive` was passed, or
2. `--json` was passed (a prompt would corrupt the single-object stdout stream), or
3. stdin is not a TTY (piped input, CI, an agent harness).

In every one of those cases a required prompt raises `OPERATION_CANCELLED`
(non-zero exit; a JSON error envelope under `--json`) rather than blocking.

---

## The JSON envelope

Every `--json` invocation prints exactly one JSON object on stdout. The envelope
is stable across versions — field semantics may grow but never shrink.

**Success:**

```json
{ "ok": true, "command": "sync", "data": { "committed": true, "pushed": true }, "warnings": ["hook skipped"] }
```

**Failure:**

```json
{
  "ok": false,
  "command": "push",
  "error": {
    "code": "GIT_ERROR",
    "message": "Git operation failed: push rejected: the remote has commits you do not have locally",
    "hint": "Run `tuck pull` first to integrate the remote changes, then push again",
    "suggestions": [
      "Run `tuck pull` first to integrate the remote changes, then push again",
      "Or use `tuck push --force` to overwrite the remote (use with caution — this can discard remote history)"
    ],
    "exit_code": 1
  }
}
```

- `command` — the full command path (e.g. `"secrets add"`).
- `data` — command-specific, documented per command.
- `warnings` — present only when non-fatal warnings were emitted.
- `error.code` — a stable, machine-readable code (see [ERROR_CODES.md](./ERROR_CODES.md)).
- `error.hint` — the single most useful suggestion (`suggestions[0]`).
- `error.exit_code` — the process exit code that accompanies this error.

Parse the **last non-empty line** of stdout as the envelope; diagnostics (which
never go to stdout in JSON mode) will not interfere.

---

## Exit codes

| Exit code | Meaning |
|-----------|---------|
| `0` | Success |
| `1` | Generic failure (most `TuckError`s) |
| `2` | `NOT_INITIALIZED` — run `tuck init` first |
| `3` | `MERGE_CONFLICTS` — a pull left unresolved conflicts |

Agents can branch on the specific exit code without parsing text. The exit code
is also carried in `error.exit_code` in the JSON envelope.

---

## Color / ANSI suppression

tuck strips ANSI color codes automatically for machine consumers. Color is
disabled when:

- `--json` is set, or
- `--non-interactive` is set, or
- the `NO_COLOR` environment variable is set (any value), or
- stdout is not a TTY.

An explicit `FORCE_COLOR` (a truthy value) overrides all of the above and keeps
color on — useful when capturing colorized output deliberately.

---

## Contextual git errors

Network operations (`push`, `pull`, `fetch`) classify git's terse stderr into an
actionable message plus suggestions. For example, a rejected push reports "the
remote has commits you do not have locally" with `tuck pull` / `tuck push --force`
suggestions rather than a bare "Failed to push". The raw git output is preserved
internally for debugging (`DEBUG=1`).

---

## Example: driving tuck from an agent

```bash
# Fully non-interactive add: fails fast (never hangs) if anything needs a prompt.
tuck add ~/.zshrc --json --yes

# Read status as structured data.
tuck status --json | jq '.data'

# Push, and branch on the machine-readable error code.
out=$(tuck push --json) || {
  code=$(printf '%s' "$out" | tail -n1 | jq -r '.error.code')
  case "$code" in
    GIT_ERROR) echo "sync needed"; tuck pull --json --yes && tuck push --json ;;
    NOT_INITIALIZED) tuck init --bare --json ;;
    *) echo "unhandled: $code" >&2; exit 1 ;;
  esac
}
```

See also: [ERROR_CODES.md](./ERROR_CODES.md) for the full code table, and
`tuck mcp` for the Model Context Protocol server that exposes tuck to agents over
JSON-RPC.
