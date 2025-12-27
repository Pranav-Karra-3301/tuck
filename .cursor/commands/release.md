---
description: Release and versioning commands
---

# Check Version

Check current version.

```bash
node -p "require('./package.json').version"
```

# Dry Run Release

Test semantic-release without publishing.

```bash
npx semantic-release --dry-run
```

# Manual Release Trigger

Trigger release workflow manually (via GitHub UI or CLI).

```bash
gh workflow run release.yml
```

# Check Release Status

Check the status of release workflow.

```bash
gh run list --workflow=release.yml
```

# View Changelog

View the changelog.

```bash
cat CHANGELOG.md
```

# Check NPM Package

Check if package is published on npm.

```bash
npm view @pranav-karra/tuck
```

# Verify Commit Messages

Check recent commits follow conventional format.

```bash
git log --oneline -10
```

Each should start with: feat:, fix:, docs:, refactor:, test:, or chore:
