# Sandboxing tuck

tuck writes configuration files into your home directory. When an **AI agent**
(or any untrusted automation) drives tuck — applying someone else's dotfiles,
a preset, or a cloned agent-config repo — you want a hard guarantee that it
cannot touch your real `~`. tuck provides this in layers.

## TL;DR

```sh
# Apply into a throwaway "dry home" — your real ~ is never touched.
tuck apply someuser/dotfiles --root /tmp/tuck-fakehome --yes

# Diff what it produced against your real config before you trust it:
diff -ru /tmp/tuck-fakehome ~    # (or use your own diff tool)
```

`--root <dir>` (or the `TUCK_TARGET_ROOT` env var) confines **every** write
under `<dir>`. For maximum safety — including against shell hooks, which run
arbitrary commands tuck cannot constrain — wrap the whole process in an OS-level
sandbox (below).

---

## Layer 1 — `--root` / `TUCK_TARGET_ROOT` (built in)

Every tuck command accepts a global `--root <dir>`:

```sh
tuck apply user/dotfiles --root /tmp/fakehome --yes
tuck restore --all        --root /tmp/fakehome --yes
tuck preset apply minimal --root /tmp/fakehome --yes
tuck context apply user/repo --root /tmp/fakehome --yes
TUCK_TARGET_ROOT=/tmp/fakehome tuck apply user/dotfiles --yes
```

When `--root` is set, tuck runs in **sandbox mode**:

- A home-relative target like `~/.zshrc` is redirected to `<root>/.zshrc`.
- An absolute path under your real home is re-based into `<root>`.
- Any attempt to escape the root — a `..` traversal, or an absolute path
  outside `<root>` — is **rejected before anything is written** (no directory
  is even created).

This covers the write-family commands: `apply`, `restore`, `preset apply`,
`context apply`. Reads still come from the real locations (so a merge can
preview against your actual files); only **writes** are confined.

> **What `--root` does NOT protect against:** lifecycle **hooks**. A
> `postRestore`/`postApply` hook is an arbitrary shell command; once it runs it
> can do anything your user can. tuck already refuses to run hooks
> non-interactively unless you pass `--trust-hooks`, but if you do trust them,
> use an OS-level sandbox (Layer 2) so the hook itself is confined.

## Layer 2 — OS-level wrappers (defense in depth)

These confine the **entire process**, including hooks and any subprocess. Point
tuck at a fake home with `--root` *and* wrap it so even a rogue hook can only
write there.

### macOS — `sandbox-exec`

```scheme
; tuck-sandbox.sb
(version 1)
(deny default)
(allow process-fork process-exec)
(allow file-read*)                                  ; reading is fine
(deny  file-write*)                                 ; deny writes by default
(allow file-write* (subpath "/tmp/tuck-fakehome"))  ; ...except the sandbox
(allow file-write* (subpath "/private/var/folders")) ; temp dirs / clones
```

```sh
sandbox-exec -f tuck-sandbox.sb \
  tuck apply user/dotfiles --root /tmp/tuck-fakehome --yes
```

### Linux — `bubblewrap`

```sh
mkdir -p /tmp/tuck-fakehome
bwrap \
  --ro-bind / / \
  --tmpfs /home \
  --bind /tmp/tuck-fakehome /home/agent \
  --setenv HOME /home/agent \
  --dev /dev --proc /proc \
  -- tuck apply user/dotfiles --root /home/agent --yes
```

### Linux — landlock (kernels ≥ 5.13)

Wrap tuck with a small [landlock](https://docs.kernel.org/userspace-api/landlock.html)
helper (e.g. `landrun`) that grants write access only to the sandbox root, then
pass the same dir as `--root`. landlock pairs well with Layer 1: the kernel
enforces the boundary even if tuck has a bug.

### Containers (most robust for CI / agents)

```sh
docker run --rm \
  -v "$PWD/fakehome:/home/agent" \
  -e HOME=/home/agent \
  --read-only --tmpfs /tmp \
  node:20 \
  npx @prnv/tuck apply user/dotfiles --root /home/agent --yes
```

The container's read-only root filesystem plus a single writable mount is the
strongest local guarantee: nothing outside `fakehome`/`tmp` can be modified
regardless of what tuck or its hooks attempt.

> **Vercel Sandbox / Firecracker microVMs** isolate *cloud* code execution —
> they protect the host running an agent, not a developer's local `~`. They are
> relevant only if you run tuck *inside* such a VM (in which case `HOME` inside
> the VM is already disposable). For protecting your own machine, use the
> wrappers above.

## Layer 3 — preview, then trust (`tuck verify`)

Combine the sandbox with `tuck verify` to inspect changes before applying them
for real:

```sh
# 1. Apply into a sandbox.
tuck apply user/dotfiles --root /tmp/fakehome --yes

# 2. Review the produced tree vs your real home.
diff -ru ~ /tmp/fakehome 2>/dev/null

# 3. If you're happy, apply for real (no --root).
tuck apply user/dotfiles --yes
```

## Recommended posture for agents

If you let an AI agent run tuck unattended:

1. Always pass `--root <throwaway-dir>` (or set `TUCK_TARGET_ROOT`).
2. Never pass `--trust-hooks` to an agent unless you also wrap it in an
   OS-level sandbox (Layer 2).
3. Use `--json` so the agent gets structured, parseable results and structured
   errors (every command supports it).
4. Prefer a container for fully-unattended/CI use.
