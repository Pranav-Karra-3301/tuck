# Tuck Doctor Plan

## Summary
`tuck doctor` will be a read-only diagnostics command that validates installation health, repository integrity, and safety posture. It should produce human-friendly output by default and machine-readable JSON for CI.

## Goals
- Detect common setup and runtime issues before `add`, `sync`, `apply`, and `restore` fail.
- Catch risky states early (unsafe manifest entries, missing backups/secrets config, git misconfiguration).
- Provide concrete, fix-oriented guidance for each failing check.
- Stay non-destructive by default.

## Non-Goals
- Automatic repair in v1 (`--fix` deferred to later release).
- Network-heavy remote diagnostics beyond lightweight `git remote` validation.

## Command Contract
- Command: `tuck doctor`
- Flags:
  - `--json`: Emit structured JSON report.
  - `--strict`: Exit non-zero on warnings (default: non-zero only for failures).
  - `--category <name>`: Run only one category (`env|repo|manifest|security|hooks`).
- Exit codes:
  - `0`: All checks pass.
  - `1`: At least one failure.
  - `2`: Warnings only with `--strict`.

## Check Categories

### 1) Environment
- Node version is supported.
- `pnpm` available when project scripts require it.
- TTY capability and fallback behavior are sane.

### 2) Repository
- `~/.tuck` exists and contains `.git`.
- Manifest and config files are present and parseable.
- Working tree sanity (`git status`) and branch tracking.

### 3) Manifest Integrity
- Validate with `tuckManifestSchema`.
- Validate each `source` with `validateSafeSourcePath`.
- Validate each `destination` with `validateSafeManifestDestination`.
- Ensure destination resolves within tuck root (`validatePathWithinRoot`).
- Detect duplicate normalized `source` or destination collisions.

### 4) Security Posture
- Secret scanning config is enabled/reasonable.
- Hooks trust model warnings (`trustHooks` usage).
- Backup/snapshot settings present for destructive flows.

### 5) Hooks and Integrations
- Hook command strings are syntactically valid and executable context is clear.
- Optional check: GH CLI availability when configured workflows depend on it.

## Output Shape (JSON)
```json
{
  "summary": {
    "passed": 0,
    "warnings": 0,
    "failed": 0
  },
  "checks": [
    {
      "id": "manifest.safe-destination",
      "category": "manifest",
      "status": "pass|warn|fail",
      "message": "...",
      "details": "...",
      "fix": "..."
    }
  ]
}
```

## Implementation Plan
1. Add `src/commands/doctor.ts` and register in `src/index.ts`.
2. Add typed check runner framework in `src/lib/doctor.ts`:
   - `DoctorCheck`, `DoctorResult`, `DoctorReport`.
   - Category filtering and strict-mode exit mapping.
3. Implement read-only checks by category using existing path/schema/security utilities.
4. Add UI formatter:
   - Default: grouped table + concise fix hints.
   - `--json`: deterministic object output.
5. Add tests:
   - Unit tests for check runner and each check.
   - Command tests for exit behavior and JSON format.
   - Security regression tests for malicious manifest inputs.
6. Add docs updates in `docs/TESTING.md` and README command list.

## Acceptance Criteria
- `tuck doctor` returns actionable output in <2s on normal repos.
- Fails on unsafe manifest entries and clearly identifies offending keys.
- JSON output is stable and CI-consumable.
- Tests cover pass/warn/fail/strict paths and malformed manifest cases.

## Assumptions and Defaults
- Best-practice default: non-destructive diagnostics only.
- Best-practice default: warnings do not fail unless `--strict`.
- Best-practice default: local checks first; avoid network dependence.
