# Value-Level (SOPS-Style) Encryption

tuck can encrypt **only the secret values** inside a config file while leaving
keys, structure, whitespace, and comments in plaintext. This is the same idea
[SOPS](https://github.com/getsops/sops) made popular for infrastructure configs,
brought to dotfiles.

Because only the value changes, an encrypted file stays **diffable and
mergeable**:

```diff
 # ~/.env
 AWS_REGION=us-east-1
-AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
+AWS_SECRET_ACCESS_KEY=ENC[tuck:v1:AAknwO2INTZ4mT9hFXgZ6ux2Mki...]
```

`git diff`, `git merge`, and code review keep working on the file — you can see
exactly which keys changed, review structure changes, and resolve conflicts,
without ever exposing the plaintext secret. This is the property whole-file
encryption (git-crypt, `tuck add --encrypt`) throws away.

## How it differs from the other secret features

| Feature | Repo copy holds | Good for |
| --- | --- | --- |
| `{{PLACEHOLDER}}` (redaction) | a placeholder; value stored in a backend/local store | resolving a value from 1Password/Bitwarden/pass on apply |
| `tuck add --encrypt` (whole-file) | opaque `TCKE2` ciphertext for the whole file | files that are *entirely* sensitive (`.netrc`) |
| **value-level encryption** | plaintext structure with inline `ENC[tuck:v1:…]` tokens | configs that are mostly plaintext with a few secret values, where you still want diffs |

## Quick start

```bash
# One-time: configure the encryption password in your OS keystore.
tuck encryption setup

# Encrypt every detected secret value across a file (or all tracked files).
tuck secrets encrypt ~/.env

# IMPORTANT: encrypt rewrites the LIVE file; the tracked repo copy under
# ~/.tuck still holds plaintext until a sync captures the encrypted version.
tuck sync

# ... commit / push the file with encrypted values ...
git -C ~/.tuck add . && git -C ~/.tuck commit -m "rotate keys"

# On another machine (or to use the values locally): decrypt back to plaintext.
tuck secrets decrypt ~/.env
```

`tuck secrets encrypt` uses tuck's secret **scanner** to locate the value spans,
then replaces each span with a self-contained ciphertext token. With no path
arguments it operates on **all tracked files**; pass explicit paths to scope it.

## The token format

Each encrypted value becomes an inline token:

```
ENC[tuck:v1:<base64>]
```

The base64 payload is self-contained — it carries its own PBKDF2 iteration count,
salt, AES-GCM nonce, and authentication tag — so every value decrypts
independently. A three-way merge that moves or reorders lines can never corrupt a
value, and re-encrypting a file leaves already-encrypted tokens **byte-for-byte
unchanged** for clean diffs.

Crypto: **PBKDF2-HMAC-SHA256** (600,000 iterations, OWASP-recommended) derives a
256-bit key; **AES-256-GCM** encrypts each value under a unique 96-bit nonce.
Within one `encrypt` run the key is derived once for all values.

## The password

Value encryption reuses the single **encryption password** that
`tuck encryption setup` stores in your OS keystore (macOS Keychain, libsecret,
Windows Credential Manager, or the encrypted fallback) — the same password
`tuck add --encrypt` and `tuck apply` use for whole-file decryption.

Resolution order:

1. `TUCK_ENCRYPTION_PASSWORD` environment variable (for CI — never put it in argv)
2. the OS keystore
3. an interactive prompt

If none is available in non-interactive mode, the command fails with a clear
message rather than guessing.

## Safety

- **Snapshot first** — every `encrypt`/`decrypt` takes a Time Machine snapshot of
  the target files before mutating them, so `tuck undo` can revert.
- **Atomic writes** — files are written via a temp-file + rename, so a crash never
  leaves a truncated file.
- **Confirmation** — interactive runs confirm before rewriting files. Use `--yes`
  (or `--json`) for non-interactive use.
- **Never leaks values** — human and `--json` output only ever report counts and
  paths, never the plaintext.

## Security notes

### No context binding (token transplant)

Each `ENC[tuck:v1:…]` token is authenticated with AES-GCM, so tampering with a
token's *bytes* is detected — decryption fails loudly. What the auth tag does
**not** cover is the token's **context**: it authenticates only the encrypted
value, not the key name it sits beside or the file it lives in. tuck's tokens
carry no associated data (AAD) and there is no file-level MAC (the mechanism
[SOPS](https://github.com/getsops/sops) uses to bind every value to the file).

The practical consequence: an attacker who already has **write access to the
repo** can move a valid token from one place to another — swap two keys' values,
or copy a token between files — and it will still decrypt cleanly under the
correct passphrase. Because the value was legitimately encrypted, nothing at
decrypt time flags the substitution.

- This is **not** a confidentiality break: the attacker never learns any
  plaintext, and cannot forge a token for a value they don't already have in
  ciphertext.
- The token format is intentionally frozen for v1 compatibility, so context
  binding is **not** added by changing the token.
- **Mitigation:** a transplant is a change to tracked files, so it shows up in
  `git diff` and `git log`. Review diffs and protect the repo's write access
  (branch protection, signed commits, trusted remotes) — the same discipline that
  protects any config in version control.

If you need cryptographic guarantees against reordering/transplant within a
single file, use whole-file encryption (`tuck add --encrypt`) for that file
instead, at the cost of losing per-value diffs.

## Scope (v1)

- Works on any UTF-8 text file; it is designed for and tested against **env-style**
  (`KEY=value`) and **JSON** configs. The base64 token alphabet is safe inside both
  env values and JSON strings.
- The commands are **manual and explicit** (`tuck secrets encrypt` /
  `tuck secrets decrypt`). A typical workflow is to encrypt before committing and
  decrypt after pulling.

### Deferred to a later iteration

- **Automatic decrypt-on-apply / sync integration.** A future `valueEncrypted`
  manifest flag would let `tuck apply`/`tuck restore` decrypt tokens automatically
  and stop `tuck sync` from capturing plaintext back into the repo (the same
  one-directional model whole-file encryption uses today). Until then, run
  `tuck secrets decrypt` explicitly.
- **YAML/TOML-aware value detection.** v1 relies on the generic secret scanner to
  find spans; format-aware value selection is future work.
```
