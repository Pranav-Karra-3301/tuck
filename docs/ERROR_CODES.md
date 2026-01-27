# Error Codes Reference

This document lists all error codes used by tuck for programmatic error handling.

---

## Error Code Table

| Code | Error Class | Description | Common Causes | Suggestions |
|------|-------------|-------------|---------------|-------------|
| `NOT_INITIALIZED` | `NotInitializedError` | Tuck is not initialized | Running commands before `tuck init` | Run `tuck init` to get started |
| `ALREADY_INITIALIZED` | `AlreadyInitializedError` | Tuck already exists at path | Running `tuck init` twice | Use `tuck status` to see current state |
| `FILE_NOT_FOUND` | `FileNotFoundError` | Specified file doesn't exist | Wrong path, deleted file | Check path, use absolute paths |
| `FILE_NOT_TRACKED` | `FileNotTrackedError` | File isn't being tracked | File not added with `tuck add` | Run `tuck add <path>` first |
| `FILE_ALREADY_TRACKED` | `FileAlreadyTrackedError` | File is already tracked | Adding same file twice | Use `tuck sync` to update |
| `GIT_ERROR` | `GitError` | Git operation failed | Auth issues, network, conflicts | Check git credentials and network |
| `CONFIG_ERROR` | `ConfigError` | Configuration problem | Corrupted config, invalid values | Run `tuck config reset` |
| `MANIFEST_ERROR` | `ManifestError` | Manifest file issue | Corrupted JSON, schema mismatch | Restore from remote with `tuck init --from` |
| `PERMISSION_ERROR` | `PermissionError` | Cannot read/write file | Wrong permissions, locked file | Check file permissions |
| `GITHUB_CLI_ERROR` | `GitHubCliError` | GitHub CLI issue | Not installed, not authenticated | Install `gh` and run `gh auth login` |
| `BACKUP_ERROR` | `BackupError` | Backup operation failed | Disk full, permissions | Check disk space and permissions |
| `ENCRYPTION_ERROR` | `EncryptionError` | Encryption failed | Wrong password, key issues | Check encryption password |
| `DECRYPTION_ERROR` | `DecryptionError` | Decryption failed | Wrong password, corrupted data | Verify correct password is used |
| `SECRETS_DETECTED` | `SecretsDetectedError` | Secrets found in files | API keys, passwords in dotfiles | Review and remove secrets, or use `--force` |
| `SECRET_BACKEND_ERROR` | `SecretBackendError` | Password manager issue | Not installed, not authenticated | Check CLI installation and auth |
| `SECRET_NOT_FOUND` | `SecretNotFoundError` | Secret not in backend | Missing mapping, deleted secret | Check secrets.mappings.json |
| `BACKEND_NOT_AVAILABLE` | `BackendNotAvailableError` | Backend CLI missing | 1Password/Bitwarden not installed | Install the backend CLI |
| `BACKEND_AUTH_ERROR` | `BackendAuthenticationError` | Backend not authenticated | Session expired | Re-authenticate with backend |
| `UNRESOLVED_SECRETS` | `UnresolvedSecretsError` | Could not resolve secrets | Missing in backend | Ensure secrets are configured |

---

## Error Structure

All tuck errors extend the base `TuckError` class and include:

```typescript
interface TuckError {
  message: string;      // Human-readable error message
  code: string;         // Error code (from table above)
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

Using `--force` to bypass secret scanning is logged in `~/.tuck/audit.log` for security tracking. This audit trail helps identify when potentially sensitive operations occurred.

### Non-Interactive Mode (CI/Scripts)

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
2. Check `~/.tuck/audit.log` for recent operations
3. Open an issue at https://github.com/Pranav-Karra-3301/tuck/issues

Include:
- The full error message
- What command you ran
- Your OS and Node.js version
