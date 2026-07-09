# Error Codes Reference

This document lists all error codes used by tuck for programmatic error handling.

---

## Error Code Table

| Code                         | Error Class                  | Description                                                                     | Common Causes                                           | Suggestions                                             |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| `NOT_INITIALIZED`            | `NotInitializedError`        | Tuck is not initialized                                                         | Running commands before `tuck init`                     | Run `tuck init` to get started                          |
| `ALREADY_INITIALIZED`        | `AlreadyInitializedError`    | Tuck already exists at path                                                     | Running `tuck init` twice                               | Use `tuck status` to see current state                  |
| `FILE_NOT_FOUND`             | `FileNotFoundError`          | Specified file doesn't exist                                                    | Wrong path, deleted file                                | Check path, use absolute paths                          |
| `FILE_NOT_TRACKED`           | `FileNotTrackedError`        | File isn't being tracked                                                        | File not added with `tuck add`                          | Run `tuck add <path>` first                             |
| `FILE_ALREADY_TRACKED`       | `FileAlreadyTrackedError`    | File is already tracked                                                         | Adding same file twice                                  | Use `tuck sync` to update                               |
| `GIT_ERROR`                  | `GitError`                   | Git operation failed                                                            | Auth issues, network, conflicts                         | Check git credentials and network                       |
| `MERGE_CONFLICTS`            | `MergeConflictsError`        | Merge left unresolved conflicts (**exit code 3**, distinct for agent branching) | Overlapping local/remote edits                          | Resolve conflicts, then re-run the operation            |
| `CONFIG_ERROR`               | `ConfigError`                | Configuration problem                                                           | Corrupted config, invalid values                        | Run `tuck config reset`                                 |
| `MANIFEST_ERROR`             | `ManifestError`              | Manifest file issue                                                             | Corrupted JSON, schema mismatch                         | Restore from remote with `tuck init --from`             |
| `PERMISSION_ERROR`           | `PermissionError`            | Cannot read/write file                                                          | Wrong permissions, locked file                          | Check file permissions                                  |
| `GITHUB_CLI_ERROR`           | `GitHubCliError`             | GitHub CLI issue                                                                | Not installed, not authenticated                        | Install `gh` and run `gh auth login`                    |
| `BACKUP_ERROR`               | `BackupError`                | Backup operation failed                                                         | Disk full, permissions                                  | Check disk space and permissions                        |
| `ENCRYPTION_ERROR`           | `EncryptionError`            | Encryption failed                                                               | Wrong password, key issues                              | Check encryption password                               |
| `DECRYPTION_ERROR`           | `DecryptionError`            | Decryption failed                                                               | Wrong password, corrupted data                          | Verify correct password is used                         |
| `SECRETS_DETECTED`           | `SecretsDetectedError`       | Secrets found in files                                                          | API keys, passwords in dotfiles                         | Review and remove secrets, or use `--force`             |
| `SECRET_BACKEND_ERROR`       | `SecretBackendError`         | Password manager issue                                                          | Not installed, not authenticated                        | Check CLI installation and auth                         |
| `SECRET_NOT_FOUND`           | `SecretNotFoundError`        | Secret not in backend                                                           | Missing mapping, deleted secret                         | Check secrets.mappings.json                             |
| `BACKEND_NOT_AVAILABLE`      | `BackendNotAvailableError`   | Backend CLI missing                                                             | 1Password/Bitwarden not installed                       | Install the backend CLI                                 |
| `BACKEND_AUTH_ERROR`         | `BackendAuthenticationError` | Backend not authenticated                                                       | Session expired                                         | Re-authenticate with backend                            |
| `UNRESOLVED_SECRETS`         | `UnresolvedSecretsError`     | Could not resolve secrets                                                       | Missing in backend                                      | Ensure secrets are configured                           |
| `MATERIALIZE_FAILED`         | `MaterializeError`           | Could not materialize a template/encrypted file on apply                        | Bad template, decryption failure                        | Check the source file and encryption password           |
| `OPERATION_CANCELLED`        | `OperationCancelledError`    | Operation was cancelled                                                         | User aborted, or a prompt required in a non-TTY context | Re-run interactively, or pass `-y/--yes`                |
| `PRIVATE_KEY_ERROR`          | `PrivateKeyError`            | Refused to track a private key                                                  | Attempting to add an SSH/GPG private key                | Store keys in a secret manager, not dotfiles            |
| `REPOSITORY_NOT_FOUND`       | `RepositoryNotFoundError`    | No dotfiles repository found for the source                                     | Bad user/repo, missing remote                           | Check the source argument and remote access             |
| `INVALID_MANIFEST`           | `InvalidManifestError`       | Manifest failed schema validation                                               | Hand-edited or corrupted manifest                       | Restore from remote with `tuck init --from`             |
| `PATH_TRAVERSAL_ERROR`       | `PathTraversalError`         | Path escaped the allowed root                                                   | `..` segments or absolute escape in a path              | Use a path within the tuck/target root                  |
| `SECRETS_STORE_ERROR`        | `SecretsStoreError`          | Local secrets store operation failed                                            | Corrupted store, permissions                            | Check the secrets store file and permissions            |
| `SCAN_LIMIT_ERROR`           | `ScanLimitError`             | Too many files to scan                                                          | Directory exceeds the scan limit                        | Narrow the scan scope or raise the limit                |
| `VALIDATION_ERROR`           | `ValidationError`            | Input failed validation                                                         | Invalid flag/field value                                | Correct the input per the message                       |
| `KEYSTORE_ERROR`             | `KeystoreError`              | OS keystore operation failed                                                    | Keychain/secret-service unavailable                     | Check the OS keystore or use the fallback               |
| `UNKNOWN_AGENT_PRESET`       | `TuckError`                  | `tuck add --preset` was given an unknown agent                                  | Typo or unsupported agent id                            | Use one of: claude-code, cursor, codex, gemini, copilot |
| `UNKNOWN_TRANSLATION_TARGET` | `TuckError`                  | `tuck preset translate --to` named an unknown agent                             | Typo in the `--to` list                                 | Use claude-code, codex, or gemini                       |
| `MCP_CONFIG_INVALID` | `McpConfigError` | An MCP config file could not be parsed during `secrets extract --mcp` | Invalid JSON, comments in the config | Fix the JSON syntax, then re-run the extraction |
| `INVALID_REQUIREMENT` | `InvalidRequirementError` | A `requires:` dependency spec is malformed | Missing `<manager>:` prefix or unknown manager | Use `<manager>:<package>` (e.g. `brew:starship`) |
| `CYCLIC_DEPENDENCY` | `CyclicDependencyError` | The `requires:` graph contains a cycle | A package/file dependency loops back on itself | Remove one edge so dependencies form a DAG |
| `BOOTSTRAP_ERROR` | `BootstrapError` | `tuck bootstrap` could not complete a phase | Missing git, unclonable repo, or no manifest | Follow the error's suggestions and re-run (idempotent) |
| `ALLOW_REASON_REQUIRED` | `TuckError` | `tuck secrets allow add` needs a reason | Ran non-interactively without `--reason` | Pass `--reason "<why safe>"` |
| `JSON_MERGE_CONFLICTS` | `JsonMergeConflictsError` | Structured JSON merge left unresolved key conflicts (**exit code 3**) | Same JSON key set to different values on two machines | Run `tuck sync` interactively, or set a policy with `tuck merge set <file> --conflict ours\|theirs` |
| `SETTINGS_UNSUPPORTED_OS` | `SettingsUnsupportedOsError` | `tuck settings` not supported on this OS | Running on a non-macOS platform | macOS is supported today; Linux/dconf is planned |
| `SETTINGS_ERROR` | `SettingsError` | OS-settings operation failed | Missing capture flags, no TTY for interactive capture | Follow the message; pass `--domain/--key/--type/--value` for non-interactive capture |
| `SETTING_NOT_FOUND` | `SettingNotFoundError` | No tracked setting/manual step with that id | Wrong id passed to `remove`/`manual done` | Run `tuck settings list` to see valid ids |
| `READ_ONLY_VIOLATION` | `ReadOnlyViolationError` | A read-only command (status/diff/list) attempted a secret/keystore operation | Bug — these commands guarantee zero prompts | Use `tuck apply`/`tuck sync`/`tuck verify` for operations that need secrets |
| `RULES_MANIFEST_CORRUPT` | `TuckError` | `rules.json` is not valid JSON | Hand-edit corrupted the rules fan-out manifest | Fix or delete `~/.tuck/rules.json` and re-run `tuck rules track` |
| `RULES_MANIFEST_INVALID` | `TuckError` | `rules.json` failed schema validation | Unsafe path override or missing repo root | Correct the manifest per the message |
| `RULES_SET_NOT_FOUND` | `TuckError` | No tracked rule set with the given id | Wrong `--id` / untrack id | Run `tuck rules list` to see tracked sets |
| `RULES_UNKNOWN_TOOL` | `TuckError` | Unknown `--tool` name | Typo or unsupported tool | Use one of the known tools listed in the hint |

---

## Error Structure

All tuck errors extend the base `TuckError` class and include:

```typescript
interface TuckError {
  message: string; // Human-readable error message
  code: string; // Error code (from table above)
  suggestions?: string[]; // Helpful suggestions to resolve
}
```

---

## Handling Errors Programmatically

When using tuck programmatically or in scripts, you can check error codes:

```bash
# Check exit code
tuck add ~/.config/secret
if [ $? -ne 0 ]; then
  echo "tuck add failed"
fi
```

In Node.js:

```typescript
import { execFile } from 'child_process';

// Use execFile instead of exec to avoid shell injection vulnerabilities
execFile('tuck', ['status'], (error, stdout, stderr) => {
  if (stderr.includes('NOT_INITIALIZED')) {
    console.log('Tuck needs to be initialized first');
  }
});
```

---

## Security-Related Errors

### `SECRETS_DETECTED`

This error occurs when tuck's secret scanner finds potential secrets in files you're trying to track.

**What triggers it:**

- API keys (AWS, GitHub, etc.)
- Passwords in config files
- Private keys
- OAuth tokens

**Resolution options:**

1. Remove the secrets from the file
2. Use a password manager integration
3. Use `--force` to bypass (not recommended)

**Example:**

```
✖ Found 2 potential secret(s) in: ~/.aws/credentials

Suggestions:
  → Review the detected secrets and choose how to proceed
  → Use --force to bypass secret scanning (not recommended)
  → Run `tuck secrets list` to see stored secrets
```

### Force Bypass Warning

Using `--force` to bypass secret scanning is logged to the audit trail for security tracking, which helps identify when potentially sensitive operations occurred. The active audit log lives in the platform state directory — on macOS `~/Library/Application Support/tuck/audit.log`, on Linux `$XDG_STATE_HOME/tuck/audit.log` (falling back to `~/.local/state/tuck/audit.log`). (`~/.tuck/audit.log` is the deprecated legacy location.)

### Non-Interactive Mode (CI/Scripts/Agents)

Pass `--non-interactive` (or `--json`, which implies it) to guarantee tuck never
blocks on a prompt: any command that would need to ask a question fails fast with
`OPERATION_CANCELLED` instead of hanging. This is also the default whenever stdin
is not a TTY. Combine with `-y/--yes` to auto-confirm ordinary prompts. See
[AGENT-MODE.md](./AGENT-MODE.md) for the full JSON-envelope and exit-code contract.

When running tuck in non-interactive environments (CI pipelines, scripts), dangerous operations that normally require typed confirmation will fail by default.

To bypass confirmation in automated environments, set:

```bash
TUCK_FORCE_DANGEROUS=true tuck push --force
```

> **⚠️ SECURITY WARNING**: This environment variable bypasses safety confirmations. Only use in trusted CI/CD pipelines where you control the inputs. Never set this in interactive shells or user environments. All operations are still logged to the audit trail.

---

## Debug Mode

Enable debug mode to see full error details:

```bash
DEBUG=1 tuck status
```

This shows:

- Full stack traces
- Internal error messages
- Additional diagnostic information

---

## Common Error Scenarios

### Network Errors

```
✖ Git operation failed: Network error

Suggestions:
  → Check your internet connection
  → Verify SSH keys: ssh -T git@github.com
```

### Permission Errors

```
✖ Permission denied: cannot write ~/.zshrc

Suggestions:
  → Check file permissions
  → Try running with appropriate permissions
```

### Manifest Corruption

```
✖ Manifest error: Invalid JSON

Suggestions:
  → The manifest file may be corrupted
  → Run `tuck init --from <remote>` to restore from remote
```

---

## Reporting Issues

If you encounter an unexpected error:

1. Run with `DEBUG=1` to get full details
2. Check the audit log in the platform state directory for recent operations (macOS: `~/Library/Application Support/tuck/audit.log`; Linux: `$XDG_STATE_HOME/tuck/audit.log` or `~/.local/state/tuck/audit.log`)
3. Open an issue at https://github.com/Pranav-Karra-3301/tuck/issues

Include:

- The full error message
- What command you ran
- Your OS and Node.js version
