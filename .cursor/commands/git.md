---
description: Git workflow commands
---

# Sync Main

Fetch and pull latest from main branch.

```bash
git checkout main && git fetch origin && git pull origin main
```

# New Feature

Create a new feature branch.

```bash
git checkout -b feat/FEATURE_NAME
```

Replace FEATURE_NAME with your feature name.

# New Fix

Create a new bugfix branch.

```bash
git checkout -b fix/FIX_NAME
```

Replace FIX_NAME with the bug description.

# Commit Feature

Create a feature commit (triggers minor version bump).

```bash
git add -A && git commit -m "feat: DESCRIPTION"
```

# Commit Fix

Create a fix commit (triggers patch version bump).

```bash
git add -A && git commit -m "fix: DESCRIPTION"
```

# Commit Docs

Create a documentation commit (no version bump).

```bash
git add -A && git commit -m "docs: DESCRIPTION"
```

# Commit Refactor

Create a refactor commit (no version bump).

```bash
git add -A && git commit -m "refactor: DESCRIPTION"
```

# Status

Check git status and recent commits.

```bash
git status && git log --oneline -5
```

# Push Branch

Push current branch to origin.

```bash
git push -u origin HEAD
```
