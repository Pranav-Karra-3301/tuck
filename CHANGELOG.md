# [1.6.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.5.2...v1.6.0) (2026-01-14)


### Features

* add auto-update checking with interactive prompt ([67f1dcd](https://github.com/Pranav-Karra-3301/tuck/commit/67f1dcdd02c09fe0faf8b9c417233a55619d16c4))

<img src="public/Changelog.png" alt="Changelog" style="width:100%;">

## [1.5.2](https://github.com/Pranav-Karra-3301/tuck/compare/v1.5.1...v1.5.2) (2026-01-14)


### Bug Fixes

* show command-specific help instead of full help for subcommands ([24f5656](https://github.com/Pranav-Karra-3301/tuck/commit/24f5656e23a78a553c12ca318dc875b8eb2be2e5))

## [1.5.1](https://github.com/Pranav-Karra-3301/tuck/compare/v1.5.0...v1.5.1) (2026-01-13)


### Bug Fixes

* resolve diff command issues from PR review ([3d298fc](https://github.com/Pranav-Karra-3301/tuck/commit/3d298fcc73dd5be23b43f24015615e8a12c5a3c9))
* update tests to match corrected diff behavior ([90f74f3](https://github.com/Pranav-Karra-3301/tuck/commit/90f74f3ea8c100c8fda8684c70d8bf2a734aaee8))

# [1.5.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.4.1...v1.5.0) (2026-01-13)


### Bug Fixes

* add colors export to diff.test.ts mock ([7a4b4f2](https://github.com/Pranav-Karra-3301/tuck/commit/7a4b4f27a26fba84432dd07d320c2854b5d108b4))
* address code review issues ([15834d0](https://github.com/Pranav-Karra-3301/tuck/commit/15834d0775ff8d270994262e26feaac5818b04cc))


### Features

* enhance diff command with binary support and filtering ([d57c407](https://github.com/Pranav-Karra-3301/tuck/commit/d57c407acaa3fd5bdaea0be6bd8f520c6e04f05f))

## [1.4.1](https://github.com/Pranav-Karra-3301/tuck/compare/v1.4.0...v1.4.1) (2026-01-13)


### Bug Fixes

* correct glob pattern regex escaping for skip patterns ([60d48c0](https://github.com/Pranav-Karra-3301/tuck/commit/60d48c0b65364250f59edd2f960271cf151b7240))

# [1.4.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.3.0...v1.4.0) (2026-01-10)


### Bug Fixes

* add workflow_dispatch trigger to CI workflow ([b3f6976](https://github.com/Pranav-Karra-3301/tuck/commit/b3f69766ee2586f61f8c902a4b13106c20b75e4b))
* address code review comments (simple fixes) ([6f47f34](https://github.com/Pranav-Karra-3301/tuck/commit/6f47f34294bb61d86936abb963ec9d25db329065))
* address code review feedback from PR[#29](https://github.com/Pranav-Karra-3301/tuck/issues/29) ([c615ef0](https://github.com/Pranav-Karra-3301/tuck/commit/c615ef05475773ddedb60570ceb235e694254d5e))
* address complex code review comments ([322d071](https://github.com/Pranav-Karra-3301/tuck/commit/322d071d040f7a332afe07a8438b915c5f98acf7))
* address PR review comments - improve code quality, security, and type safety ([c1f1fdd](https://github.com/Pranav-Karra-3301/tuck/commit/c1f1fdd2c4d83edbf8ea6892bebe47ac19ed854a))
* address PR review comments - improve security docs, error messages, and code quality ([29bf6f3](https://github.com/Pranav-Karra-3301/tuck/commit/29bf6f3e3d338f897413ccb91d44e45806d456d8))
* address PR review comments - improve security, error messages, and validation ([e37a54d](https://github.com/Pranav-Karra-3301/tuck/commit/e37a54d48cc3eba7219c6d41ab7a2624b5186d37))
* address PR review comments - improve URL validation and token format ([dce5794](https://github.com/Pranav-Karra-3301/tuck/commit/dce579470e1e4909c75d02a95e8a890936b5a582))
* address PR review comments - security, type safety, and code quality improvements ([cf4ae39](https://github.com/Pranav-Karra-3301/tuck/commit/cf4ae392a61b9ccdc574fd4b85218f8efd833f82))
* address PR review comments and critical issues ([89c7c30](https://github.com/Pranav-Karra-3301/tuck/commit/89c7c30b28d575312517df4b5d62f671bab8ed94))
* address PR review feedback on secrets management ([ae945e9](https://github.com/Pranav-Karra-3301/tuck/commit/ae945e90ac1511d01b2618a4418631732f594d93))
* correct comment inaccuracies from code review ([b29e60c](https://github.com/Pranav-Karra-3301/tuck/commit/b29e60c3d3b2ceb88baf4a3fd332f5eb14965909))
* correct regex escaping and simplify success message logic ([79b4e83](https://github.com/Pranav-Karra-3301/tuck/commit/79b4e836026c8ec311c7614e8ff1dab10f93b03b))
* extract GITHUB_TOKEN_PREFIXES constant and improve fallback logic ([232377c](https://github.com/Pranav-Karra-3301/tuck/commit/232377c5f65e1c8e284944a9deda505e433de503))
* extract MIN_GITHUB_TOKEN_LENGTH constant and restore username fallback ([7fd6c63](https://github.com/Pranav-Karra-3301/tuck/commit/7fd6c63cb9d481dbb49735847ce49ac9060d455f))
* **github:** add blank line terminator to git credential protocol input ([ba65ec7](https://github.com/Pranav-Karra-3301/tuck/commit/ba65ec78fe4642d4ab9508d5f6cd07d02f53396f))
* **github:** properly narrow token type in updateStoredCredentials ([17b3750](https://github.com/Pranav-Karra-3301/tuck/commit/17b3750b59de334db448e9c1af7a695c794cc4bd))
* implement --since option for scan-history command ([7ee42a7](https://github.com/Pranav-Karra-3301/tuck/commit/7ee42a7d93410894e9a1ca9ff7f733ca9f693025))
* improve init flow with better GitHub error handling and file pre-selection ([250823f](https://github.com/Pranav-Karra-3301/tuck/commit/250823f478172d7932ae50e016fde0db4beb4e90))
* improve known_hosts parsing and clarify GitHub URL validation context ([b242381](https://github.com/Pranav-Karra-3301/tuck/commit/b24238100b7ac705169ef25110f8192192043cf6))
* improve known_hosts parsing to prevent hostname confusion ([fcd8577](https://github.com/Pranav-Karra-3301/tuck/commit/fcd8577757b0c0b24ee3dc816659c49f5cacee93))
* improve URL validation and username fallback logic ([dc95131](https://github.com/Pranav-Karra-3301/tuck/commit/dc951317038dda5753e9e349ad885972d7895726))
* improve URL validation regex and known_hosts parsing logic ([8c7e5b5](https://github.com/Pranav-Karra-3301/tuck/commit/8c7e5b577fc0e65110ba19790b8f2e51c082e56a))
* **init:** handle case where only sensitive files are detected ([3622302](https://github.com/Pranav-Karra-3301/tuck/commit/362230297772aa05be1ac8700484f1effaeb65b9))
* make addFilesFromPaths throw error on secrets detection ([d837c37](https://github.com/Pranav-Karra-3301/tuck/commit/d837c3792b67a415b31b6499e1d52ed6ed315569))
* prevent duplicate secret storage when same value matched by multiple patterns ([8ea5870](https://github.com/Pranav-Karra-3301/tuck/commit/8ea5870c85f2f1149b96552ab6e7a917cfef2112))
* remove redundant undefined and clarify GITHUB_TOKEN_PREFIXES usage ([29bf7d9](https://github.com/Pranav-Karra-3301/tuck/commit/29bf7d9d012ab34a347b07be726ad94718f1f630))
* remove unused imports and variables (lint errors) ([aca6079](https://github.com/Pranav-Karra-3301/tuck/commit/aca60797d3e936609cd7917e3e38caf15444d902))
* reset regex lastIndex in hasPlaceholders to prevent state pollution ([98cf7c8](https://github.com/Pranav-Karra-3301/tuck/commit/98cf7c8cffe31c75ebdff736467179050cdeb898))
* simplify bin directory detection logic ([5c94a3f](https://github.com/Pranav-Karra-3301/tuck/commit/5c94a3f36144781f6a082da58c0f1947e4c34409))
* update contributing docs to use development branch workflow ([4a92886](https://github.com/Pranav-Karra-3301/tuck/commit/4a92886cb6c8e4055ee62730c9887769132778e3))
* use generic Git URL validation for manual remote entry ([0a7024a](https://github.com/Pranav-Karra-3301/tuck/commit/0a7024a0536e41e2a78bc57596691727d73f1e12))
* use RELEASE_TOKEN for semantic-release to bypass branch protection ([92eb20b](https://github.com/Pranav-Karra-3301/tuck/commit/92eb20b3df9cc7d71407e833bdfe660079c832f6))


### Features

* add alternative GitHub authentication methods ([77b1174](https://github.com/Pranav-Karra-3301/tuck/commit/77b117456cbdee35bb8513deb58da99f742daf9f))
* add comprehensive secrets management with security hardening ([7811465](https://github.com/Pranav-Karra-3301/tuck/commit/7811465fd9b54079cd92438501e8b703c04bd62b))
* add large file detection and .tuckignore support ([dc4784d](https://github.com/Pranav-Karra-3301/tuck/commit/dc4784de823b6fa175e3cf38bbbc95adc4fa923e))
* add secrets scanning and management ([dcb4ad4](https://github.com/Pranav-Karra-3301/tuck/commit/dcb4ad44b8bc1ad35d4c4ae44e450e02c77f0b54))
* comprehensive CLI improvements and test infrastructure ([31ec82f](https://github.com/Pranav-Karra-3301/tuck/commit/31ec82f65de84d80c6641da16415e1bc5a49e55e))

# [1.3.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.2.1...v1.3.0) (2025-12-27)


### Bug Fixes

* prevent shell injection in migration documentation examples ([5247088](https://github.com/Pranav-Karra-3301/tuck/commit/5247088267652f4768ab6323ecfcc942820eb5fa))
* resolve multiple logic gaps and safety issues ([4980175](https://github.com/Pranav-Karra-3301/tuck/commit/498017592423b141c25e7b3e0ab91170dbabf82d))
* resolve undefined variable and type errors in progress tracking ([e3fd023](https://github.com/Pranav-Karra-3301/tuck/commit/e3fd02341518f290c0ba04ac93a321386faa2db1))
* **roadmap:** address review comments on naming and technical accuracy ([7c35f90](https://github.com/Pranav-Karra-3301/tuck/commit/7c35f908edbae086e0fc1384f02ca85d9c5d0d4e))


### Features

* improve onboarding experience with beautiful progress display ([aac84e8](https://github.com/Pranav-Karra-3301/tuck/commit/aac84e8083a770e59657bec43ebc9d1c8e534c28))

## [1.2.1](https://github.com/Pranav-Karra-3301/tuck/compare/v1.2.0...v1.2.1) (2025-12-27)


### Bug Fixes

* correct dry_run boolean comparison in release workflow ([48a6d8a](https://github.com/Pranav-Karra-3301/tuck/commit/48a6d8a13b4d6e29df5e5ee6d107c9a0e65b58d4))
* multiple bug fixes and UX improvements ([6f8e01d](https://github.com/Pranav-Karra-3301/tuck/commit/6f8e01d56644a16c429473364b7f5b11ab9985b1))

# Changelog

## [1.2.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.1.1...v1.2.0) (2025-12-27)


### Bug Fixes

* **init:** validate destination paths and copy plain-dotfiles repo contents ([8f61bca](https://github.com/Pranav-Karra-3301/tuck/commit/8f61bca849cc8f7e10cf918d1b7bf7ab267c7ce8))
* preserve existing .gitignore and README.md in plain-dotfiles import ([d32dd96](https://github.com/Pranav-Karra-3301/tuck/commit/d32dd96bc8657ecf9175384a2a44d25fec52e121))
* validate source paths in importExistingRepo to prevent path traversal ([b8e5d26](https://github.com/Pranav-Karra-3301/tuck/commit/b8e5d2633ca56a2accfa65831489e3c59c4ed06e))


### Features

* **init:** auto-detect existing GitHub dotfiles repository ([423d9a6](https://github.com/Pranav-Karra-3301/tuck/commit/423d9a66ff67d81f3c6e73702e08f65486d22304))

## [1.1.1](https://github.com/Pranav-Karra-3301/tuck/compare/v1.1.0...v1.1.1) (2025-12-27)


### Bug Fixes

* use node18 target for pkg binary builds ([ea0ce16](https://github.com/Pranav-Karra-3301/tuck/commit/ea0ce161994978fc99d43ee38ec8f558b79b50bb))

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
