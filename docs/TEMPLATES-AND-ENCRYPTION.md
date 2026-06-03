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

## Limitations

- Template/encrypted files are **copy-only** — they cannot use the symlink strategy (a symlink
  would expose the raw source/ciphertext at the live path). `--encrypt`/`--template` with the
  symlink strategy is rejected.
- The transform is **text-oriented** (dotfiles are text). Track binary files without
  `--encrypt`/`--template`.
- If a decryption fails (wrong/absent password, corrupt ciphertext), that one file is **skipped
  loudly** during apply/restore — tuck never writes ciphertext or partial output to your system.
