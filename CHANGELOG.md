# [1.1.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.0.0...v1.1.0) (2025-12-27)


### Bug Fixes

* **add:** correct sensitive file pattern matching for paths with ~/ prefix ([af4372f](https://github.com/Pranav-Karra-3301/tuck/commit/af4372f24af2b85e66230eef5e392e93f0ad6de8))
* check stderr for GitHub CLI authentication status ([1219c0b](https://github.com/Pranav-Karra-3301/tuck/commit/1219c0bf207b18cb3a3e37e1dedba144eb4b1899))
* correct SSH/GPG permission checks in restore command ([9814283](https://github.com/Pranav-Karra-3301/tuck/commit/9814283e75d7202d3217410ff95b9857219e813b))
* prevent backup filename collisions in Time Machine snapshots ([5e3a1de](https://github.com/Pranav-Karra-3301/tuck/commit/5e3a1de48cfe38b78e517ea525fad2015ef99277))
* **security:** address command injection and path traversal vulnerabilities ([cceb04d](https://github.com/Pranav-Karra-3301/tuck/commit/cceb04ddcfe5d6ad8ac3dee91b639878a1b02893))


### Features

* add scan command for automatic dotfile detection ([d3e50a9](https://github.com/Pranav-Karra-3301/tuck/commit/d3e50a996876a2a0fb267e701dd22266a9760921))
* implement v1.1.0 features - apply command, Time Machine backups, GitHub auto-setup ([84f5a70](https://github.com/Pranav-Karra-3301/tuck/commit/84f5a707db44c34344747833c1b943f97debf6e4))

# 1.0.0 (2025-12-27)


### Bug Fixes

* add missing semantic-release plugins and install script ([b5663c6](https://github.com/Pranav-Karra-3301/tuck/commit/b5663c60e6a6d200f4868f26f4c8a23583eaac13))
* correct inputs.dry_run check for push events ([d91771f](https://github.com/Pranav-Karra-3301/tuck/commit/d91771fc451866053ce5cd0a3cf4c4ed1d76271f))
* handle dry-run mode correctly in version detection logic ([b776007](https://github.com/Pranav-Karra-3301/tuck/commit/b776007648da8aa384bd6f81c7d734bd8ce55598))
* resolve ESLint errors in table.ts ([c158c4c](https://github.com/Pranav-Karra-3301/tuck/commit/c158c4c6adff5bac73ae5ef9a6bffe873b2d3e09))
* resolve npm publish permission error and fix release pipeline ([2c69c9b](https://github.com/Pranav-Karra-3301/tuck/commit/2c69c9b4df31c90827623867db7610a35a7255e9))
* simplify heredoc in workflow to avoid YAML parsing issues ([4b12553](https://github.com/Pranav-Karra-3301/tuck/commit/4b12553b6593dc3a7d1cedf402d2c392f86496b8))


### Features

* add automatic Homebrew tap update on release ([63ef055](https://github.com/Pranav-Karra-3301/tuck/commit/63ef055030fd04962cefa9777a5a8dba9d82a6f8))
* initial implementation of tuck dotfiles manager ([c621bfd](https://github.com/Pranav-Karra-3301/tuck/commit/c621bfde7ad77a82a7eea452603ef95342a46449))

# 0.1.0 (2025-12-27)


### Bug Fixes

* add missing semantic-release plugins and install script ([b5663c6](https://github.com/Pranav-Karra-3301/tuck/commit/b5663c60e6a6d200f4868f26f4c8a23583eaac13))
* resolve ESLint errors in table.ts ([c158c4c](https://github.com/Pranav-Karra-3301/tuck/commit/c158c4c6adff5bac73ae5ef9a6bffe873b2d3e09))


### Features

* add automatic Homebrew tap update on release ([63ef055](https://github.com/Pranav-Karra-3301/tuck/commit/63ef055030fd04962cefa9777a5a8dba9d82a6f8))
* initial implementation of tuck dotfiles manager ([c621bfd](https://github.com/Pranav-Karra-3301/tuck/commit/c621bfde7ad77a82a7eea452603ef95342a46449))
