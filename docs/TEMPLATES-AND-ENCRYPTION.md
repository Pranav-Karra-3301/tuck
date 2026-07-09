# Templates & Encryption

tuck can store a file as a **template** (rendered per-machine on apply) or **encrypted**
(ciphertext at rest in the repo, decrypted on apply). Both are wired through one shared
`materialize` step — see `docs/superpowers/specs/2026-06-03-templating-and-decrypt-on-apply-design.md`.

## The mental model (important)

For a normal tracked file, the repo copy and the live file are kept **in sync both ways**
(`tuck sync` copies live → repo; `tuck apply`/`tuck restore` copy repo → live).

For a **template or encrypted** file this is different and **one-directional**:

- the **repo** holds the *source* — the `{{ }}` template text, or the ciphertext;
- the **live** file is a *derived artifact* — the rendered text, or the decrypted plaintext.

Because the two intentionally differ, **`tuck sync` never captures a template/encrypted file
back into the repo** (doing so would overwrite your template with machine-specific output, or
write your plaintext secret into the repo). To change one of these files, **edit the repo
source and run `tuck apply`** (a `tuck edit` helper is planned). `tuck status`/`tuck verify`
still report real drift for them — a stale live file shows up, with the remedy being `tuck apply`.

## Templates

```bash
tuck add --template ~/.gitconfig    # store the {{ }} source; render on apply
tuck apply                          # writes the rendered file to ~/.gitconfig
```

### Syntax

```
{{os}}                              # variable substitution
{{email | default "me@example.com"}}# fallback when missing/empty
{{#if os == "darwin"}}...{{else}}...{{/if}}   # inline conditional (nests correctly)

# tuck:if os == "linux"             # whole-line / comment-marker style for files
alias open=xdg-open                 #   that can't carry {{ }} inline
# tuck:endif
```

### Variables

Built-ins are always available: `os`, `arch`, `hostname`, `user`, `home`, `ci`, and any
`env.NAME` (read from the environment at render time). Add your own machine-specific values
under `templates.variables` in `.tuckrc.json`:

```json
{ "templates": { "variables": { "email": "me@work.com", "profile": "work" } } }
```

A dedicated `.tuckdata` file for richer per-machine data is planned.

## Encryption

Whole-file encryption uses **AES-256-GCM** (PBKDF2, the `TCKE1` format) with a single
encryption password stored in your OS keystore (Keychain / libsecret / encrypted fallback):

```bash
tuck encryption setup               # set the encryption password (once per machine)
tuck add --encrypt ~/.netrc         # store TCKE1 ciphertext in the repo
tuck apply                          # decrypts ~/.netrc back into place
```

If no password is configured, `tuck add --encrypt` fails with a clear message rather than
committing plaintext. A file can be **both** encrypted and a template — apply decrypts first,
then renders.

## Read-only commands never prompt

**`tuck status`, `tuck diff`, and `tuck list` are guaranteed never to unlock the
keystore or contact a secret backend (1Password / Bitwarden / pass / local
external).** They only read what is already on disk, so they can never trigger a
biometric/password prompt — no matter how many encrypted files you track. This is
the difference other managers stumble on, where "every command wanted me to log in
to my password manager."

How the guarantee is kept:

- These commands enter a process-wide **read-only mode**. In that mode the keystore
  accessor returns a value already cached in the process (or nothing) without ever
  touching the OS keychain, and the secret resolver refuses to reach a backend
  (a stray attempt throws `READ_ONLY_VIOLATION` rather than prompting).
- Drift in **encrypted** files is detected with a **keyed HMAC** instead of a
  decryption. A full command (`tuck verify`, and any non-read-only state check)
  records a machine-local HMAC of the last-known-good plaintext, pinned to the
  repo copy it came from. `tuck status`/`tuck diff` then HMAC the *live* bytes and
  compare — zero decryptions, zero keystore access.
  - The HMAC key and cache live in tuck's per-machine state dir (never in the repo
    and never pushed to git). Keying — rather than a plain checksum — means the
    fingerprint reveals nothing about the secret to anyone who doesn't already hold
    the local key.
  - Until the cache has been warmed for a given encrypted file, read-only commands
    report it as **unchanged** rather than guessing (they never emit a false drift
    and never decrypt to find out). Run **`tuck verify`** once to warm the cache;
    after that `tuck status` detects local edits to encrypted files offline.
  - `tuck diff` on a changed encrypted file reports *that* it changed but withholds
    the line-level diff (showing it would require decrypting the repo copy). Run
    `tuck verify` or `tuck apply` for a full comparison.
- Pure (non-encrypted) template files touch no secret, so read-only commands render
  them directly as before.

### One prompt per session

For the commands that *do* need the encryption key (`tuck apply`, `tuck restore`),
the unlocked passphrase is cached in memory for the process with a TTL, so a run
that decrypts many files unlocks the keystore **at most once** — one prompt per
session, not one per file.

## Limitations

- Template/encrypted files are **copy-only** — they cannot use the symlink strategy (a symlink
  would expose the raw source/ciphertext at the live path). `--encrypt`/`--template` with the
  symlink strategy is rejected.
- The transform is **text-oriented** (dotfiles are text). Track binary files without
  `--encrypt`/`--template`.
- If a decryption fails (wrong/absent password, corrupt ciphertext), that one file is **skipped
  loudly** during apply/restore — tuck never writes ciphertext or partial output to your system.
