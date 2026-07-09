<img src="public/Changelog.png" alt="Changelog" style="width:100%;">

# [1.10.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.9.0...v1.10.0) (2026-07-09)


### Bug Fixes

* **add:** forward CLI flags on the interactive add path ([fd3d252](https://github.com/Pranav-Karra-3301/tuck/commit/fd3d252ffcde90e3d0f5b4b424568d38e68c1fe0))
* **apply:** binary-safe writes, sandbox-safe secret restore, complete undo snapshot ([039a77c](https://github.com/Pranav-Karra-3301/tuck/commit/039a77c8cf69b1c2aedc5a63144e4e6d80669772))
* **apply:** defend against symlink TOCTOU escape and keep prepare off the MCP stream ([8f4ff88](https://github.com/Pranav-Karra-3301/tuck/commit/8f4ff8898dd93e754a1346a97d3c2ffdb4953ec4))
* **apply:** detect symlink redirection by component, not realpath strings ([340b8b4](https://github.com/Pranav-Karra-3301/tuck/commit/340b8b4e13040dfe111f5d72ddf73c97197cd2ea))
* **apply:** normalize paths in symlink write-guard for Windows containment ([f542098](https://github.com/Pranav-Karra-3301/tuck/commit/f542098085ad931b3fd30ec7481d147dadb8cef0))
* atomic writes for manifest, config, and secrets store ([4089822](https://github.com/Pranav-Karra-3301/tuck/commit/40898227f17aeb665c2f8d8260c1dc241d907927))
* clear no-useless-escape lint errors in template.ts ([45cb5ab](https://github.com/Pranav-Karra-3301/tuck/commit/45cb5ab8c53164752f2fc76e7b255c4cb1dc92b5))
* **cli:** correct bare-flag handling and skip update-check for `mcp serve` ([40adde6](https://github.com/Pranav-Karra-3301/tuck/commit/40adde6fa6ae9bc16b63ab982a680089b57b3a5c))
* **cli:** stop leaking encrypt-file passphrase via argv; honor TUCK_PASSWORD in JSON ([2039a29](https://github.com/Pranav-Karra-3301/tuck/commit/2039a290da195d88bc88abf80dbede9bf49100a1))
* **config:** deep-merge nested config keys so partial files keep defaults ([37027ed](https://github.com/Pranav-Karra-3301/tuck/commit/37027eda7df7715c5a754370b50922221afd7d5d))
* context apply skips existing home targets; reset jsonMode between tests ([bc4c6b0](https://github.com/Pranav-Karra-3301/tuck/commit/bc4c6b00759b5f26ff99c0dad2de93d54a570f20))
* **context:** unique repo-scoped ids and directory sync ([dd1f5ef](https://github.com/Pranav-Karra-3301/tuck/commit/dd1f5ef089b7326c244f1b6a5973a1ea606e5a1a))
* **crypto:** feed macOS keychain secret via stdin, not argv ([39fd756](https://github.com/Pranav-Karra-3301/tuck/commit/39fd7563a0177d0357a54374ec2e6efbec9b8836))
* **crypto:** harden fallback keystore (atomic write, move-aside, relocate secret) ([7fe7f0f](https://github.com/Pranav-Karra-3301/tuck/commit/7fe7f0fae6c011916c46ed3c29d0e04cb7e236cf))
* **crypto:** raise per-file KDF to 600k iterations via versioned TCKE2 header ([2d4b969](https://github.com/Pranav-Karra-3301/tuck/commit/2d4b969a7a2a553802b96c26c47cb0df7b18d758))
* decrypt-file never overwrites its ciphertext input in place ([5f7839b](https://github.com/Pranav-Karra-3301/tuck/commit/5f7839b491b865ea4cfc1f76916f4b2a7db03136))
* **diff:** make diff state-model aware and fix exit-code/context bugs ([25dd7e2](https://github.com/Pranav-Karra-3301/tuck/commit/25dd7e21598cf419a64390f8cb08bc6d428a8324))
* **doctor:** stop failing on repo-scoped entries and shipped templating ([6f0498c](https://github.com/Pranav-Karra-3301/tuck/commit/6f0498cc323dd81f66114ad167379e75dbab232f))
* **files:** align copyFileOrDir skip list with the checksum walk ([6efa5d9](https://github.com/Pranav-Karra-3301/tuck/commit/6efa5d995d549236571bcea1cbde2852aac0e718))
* gh repo create no longer uses dead --confirm/--json flags ([45cf6d7](https://github.com/Pranav-Karra-3301/tuck/commit/45cf6d75d97d0a000afbd10f2bb193f7ece87ebc))
* **gitlab:** stop passing -h to glab (it means --help), breaking the provider ([bbb6d7d](https://github.com/Pranav-Karra-3301/tuck/commit/bbb6d7decf65d313a05aee9090bb20b31e3846d8))
* **git:** only run gh auth setup-git for HTTPS github.com remotes; guard stageAll ([a63129e](https://github.com/Pranav-Karra-3301/tuck/commit/a63129e526aa51b7c8bca72503ca4f831719dd58))
* guard preset apply against path escape + silent overwrite ([fc163ce](https://github.com/Pranav-Karra-3301/tuck/commit/fc163ce47250c2536594de5740c97046a3b35a54))
* handle tracked directories across apply/restore/verify + bare-init .gitignore ([6912e6b](https://github.com/Pranav-Karra-3301/tuck/commit/6912e6b735b78a4cefbed87f00f89192b68091ed))
* harden context apply against untrusted remote manifests ([9468c01](https://github.com/Pranav-Karra-3301/tuck/commit/9468c01e8bb3fe04e909ac3e5c018dd03ec6f9d2))
* honor since filters in history scans ([a888da3](https://github.com/Pranav-Karra-3301/tuck/commit/a888da37736532f9f43eed80f336ab7c3f7f98c9))
* honor targeted restores in undo ([60014d9](https://github.com/Pranav-Karra-3301/tuck/commit/60014d9b5556f63a4e7da23750b44664cd7bdb30))
* **hooks:** decide interactivity from stdin, not stdout ([bcfa3cc](https://github.com/Pranav-Karra-3301/tuck/commit/bcfa3cc3fdc8d1c302b24234758b1650f439ef0d))
* **json:** gate human/spinner output behind JSON mode so --json emits one object ([5070058](https://github.com/Pranav-Karra-3301/tuck/commit/5070058273d0a48d5a50e530936c8f663c8fc5f7))
* **json:** suppress tracking stdout in --json mode ([bfed982](https://github.com/Pranav-Karra-3301/tuck/commit/bfed98263acc591f753bf8b52bd80a081a6362d4))
* **list:** emit a JSON envelope when --json category has no matches ([c780e63](https://github.com/Pranav-Karra-3301/tuck/commit/c780e638c434775211d27e403912561c1e0353bc))
* make directory checksums sensitive to filenames/structure ([1066e26](https://github.com/Pranav-Karra-3301/tuck/commit/1066e26d5ff59283b377b72a7156ca3c13db796d))
* make undo (snapshot restore) reversible and snapshot writes safe ([e18a5ff](https://github.com/Pranav-Karra-3301/tuck/commit/e18a5ff20b9fbdba807613978a0a2b55e4f65900))
* **manifest:** never leave cache diverged when a save fails ([3a6624d](https://github.com/Pranav-Karra-3301/tuck/commit/3a6624dd14dd59859037830e33c939079cf21f8d))
* **mcp:** survive malformed requests and drain in-flight work before exit ([3c55595](https://github.com/Pranav-Karra-3301/tuck/commit/3c555953fa5b4d98f464034ea309ed474937492a))
* **merge:** correct rebase ours/theirs orientation and harden conflict resolution ([4fc99d1](https://github.com/Pranav-Karra-3301/tuck/commit/4fc99d1690723d685235aa670e672c947c735c82))
* **merge:** make smartMerge banner idempotent to stop unbounded file growth ([691b9b0](https://github.com/Pranav-Karra-3301/tuck/commit/691b9b0ee1eec669cc27d68087e9022aaa3e2782))
* never block or corrupt JSON on hook confirmation in non-interactive mode ([ddc15e9](https://github.com/Pranav-Karra-3301/tuck/commit/ddc15e990d6ac6cbfc37135f10f750fea26873a3))
* **paths:** correct home-boundary matching and Windows drive-letter handling ([95147cc](https://github.com/Pranav-Karra-3301/tuck/commit/95147cc6b78397b8a9d18ee712f1f4f73c59f4a5))
* **preset:** resolve bundled registry/patterns dir to first existing candidate ([5dce2ce](https://github.com/Pranav-Karra-3301/tuck/commit/5dce2ce6442c071423437e20e235f3c70e77d82f))
* **pull:** add --yes, detect no-upstream commits, and abort on conflict ([92022c0](https://github.com/Pranav-Karra-3301/tuck/commit/92022c0482b80af0c3db62ebc366cafd13784c3c))
* **push:** honor --yes non-interactively and fetch before divergence check ([5483179](https://github.com/Pranav-Karra-3301/tuck/commit/54831795e852068aebf11c9ead3bb462752b89d4))
* redact gitleaks match context so secrets don't print to stdout ([0df8faf](https://github.com/Pranav-Karra-3301/tuck/commit/0df8fafa6b2a33fd7166b1381e2124976a7185de))
* redact longest secret values first to avoid cleartext remainder leak ([3fb55af](https://github.com/Pranav-Karra-3301/tuck/commit/3fb55af0beba8f3898660fc4a74f64bc85c83c37))
* reject leading-dash secret backend paths (argument injection) ([f045076](https://github.com/Pranav-Karra-3301/tuck/commit/f045076efb70620f18141014d1f081ed6eabf296))
* **remove:** restore symlinked originals and untrack repo-scoped files ([73914fe](https://github.com/Pranav-Karra-3301/tuck/commit/73914fe32257e858379c4c4483447cbbfef9604b))
* restore --yes/--json must not implicitly restore ALL files ([f77cc2e](https://github.com/Pranav-Karra-3301/tuck/commit/f77cc2ec8710211fd0be53dba42ab1bd29db7123))
* restore files after pull when requested ([45e13b8](https://github.com/Pranav-Karra-3301/tuck/commit/45e13b8d4d16f077949f2d5ce94206776a9b07bb))
* **restore:** honor dry-run/no-hooks in interactive path and fix sandbox backup ([f385014](https://github.com/Pranav-Karra-3301/tuck/commit/f3850142cdba2763c8a98014a8c4346180f55c75))
* **restore:** suppress runRestore human output in JSON mode ([10850db](https://github.com/Pranav-Karra-3301/tuck/commit/10850db587c6e690a97b22a5dfc17b83f6e43035))
* **review+win:** capture source stat before copy; cross-platform Wave-5 tests ([cb49d8e](https://github.com/Pranav-Karra-3301/tuck/commit/cb49d8efce89cca00adb5c10663a711d200f1abd))
* **review:** address PR [#98](https://github.com/Pranav-Karra-3301/tuck/issues/98) review (symlink materialize bypass, dir drift, etc.) ([fc335d5](https://github.com/Pranav-Karra-3301/tuck/commit/fc335d5ad6fd7b28ede6a54a73476dbe809b15c7))
* **review:** address Wave-2 adversarial review — sandbox context restore + keystore race/probe ([8419bd4](https://github.com/Pranav-Karra-3301/tuck/commit/8419bd4228b716715d9c12e50c379e7e09c8cf95)), closes [#93](https://github.com/Pranav-Karra-3301/tuck/issues/93)
* **review:** address Wave-3 review — real clone maxBuffer, config-remote truthfulness, provider-neutral auto-create ([228c5c8](https://github.com/Pranav-Karra-3301/tuck/commit/228c5c8977232cefe3a25e4243bb5873cb2ca51c)), closes [#94](https://github.com/Pranav-Karra-3301/tuck/issues/94)
* **review:** clear config cache after the two interactive config writes ([acd013d](https://github.com/Pranav-Karra-3301/tuck/commit/acd013d4493dea87f60ff6aa7127aaad54547ca1))
* **safety:** wave-1 data-loss & safety hardening (snapshot atomicity, lifecycle, paths/perms, audit/binary) ([f8fba30](https://github.com/Pranav-Karra-3301/tuck/commit/f8fba308c53ee2deb76c7b54981a7353a364e293))
* scan for secrets in non-interactive (--json/--yes) sync [CRITICAL] ([1829879](https://github.com/Pranav-Karra-3301/tuck/commit/182987914eefa214099f76b7b47f9b888d3dffc3))
* scan tracked files for secrets by default ([a230b81](https://github.com/Pranav-Karra-3301/tuck/commit/a230b817f407b3122b5e2a0fbd9a3a14c800c0c4))
* **scan:** honor pattern exclude lists when tracking directories ([42222bf](https://github.com/Pranav-Karra-3301/tuck/commit/42222bf1c4b14ab3d1177825405b5794d94edfd7))
* **secrets:** clone default mappings so setMapping cannot mutate the module default ([d1dd44a](https://github.com/Pranav-Karra-3301/tuck/commit/d1dd44a6f12ebfbe380093547169154e10e0bb7a))
* **secrets:** insert restored secrets literally, not as $-patterns ([5d04e1f](https://github.com/Pranav-Karra-3301/tuck/commit/5d04e1fe10dcdea81f9a9fc1ba2e5b49d450dcae))
* **secrets:** read gitleaks findings from --report-path, not stdout ([e317c4a](https://github.com/Pranav-Karra-3301/tuck/commit/e317c4af977cceaf64c6e3fbd103b60958e1cc54))
* **secrets:** scan directory candidates and fix repo-scoped ignore action ([8bdcab7](https://github.com/Pranav-Karra-3301/tuck/commit/8bdcab7b46233a84db70bd4584e00f338eafbd09))
* **secrets:** split bitwarden item/field before the item lookup ([97af24a](https://github.com/Pranav-Karra-3301/tuck/commit/97af24a010042a27692dd27ed79bf23aa87fc702))
* **secrets:** validate pass gpgId before embedding in GPG_OPTS ([cbfb686](https://github.com/Pranav-Karra-3301/tuck/commit/cbfb68674b50d2a7417739dd12061caeb34325d7))
* **status:** detect changes via the shared state model ([83581dc](https://github.com/Pranav-Karra-3301/tuck/commit/83581dcbf90c080662a6cc94bead3cba88ce47ff))
* store password-verification data off-repo + repair broken scrypt KDF ([f6af58d](https://github.com/Pranav-Karra-3301/tuck/commit/f6af58d45afa12ba2ed28856efc0a5c9aab24204))
* sync respects local-only mode (don't auto-push to a stray remote) ([e0dd432](https://github.com/Pranav-Karra-3301/tuck/commit/e0dd4328e814a25458f1b01e368deefe3c321cfc))
* **sync:** commit pending repo changes when no tracked file drifted ([1ea50dd](https://github.com/Pranav-Karra-3301/tuck/commit/1ea50ddeee78c1ec677e6fdc7e7590ddbd2ac679))
* **sync:** mirror tracked dirs, back up deletions, honor repo-scoped ignore ([5618977](https://github.com/Pranav-Karra-3301/tuck/commit/5618977f14fab04846bba303e0b81c41eecb2112))
* **sync:** never capture template/encrypted files live->repo (no clobber/leak) ([6f313e5](https://github.com/Pranav-Karra-3301/tuck/commit/6f313e5eba4484c96b5e948eb4019900bc0bab81))
* **template:** accept unquoted tuck:if literals instead of silently dropping blocks ([5f569b9](https://github.com/Pranav-Karra-3301/tuck/commit/5f569b918f0719647998d7273f92d58ed98a2db9))
* **timemachine:** snapshot out-of-home paths and make single-file undo reversible ([9400db2](https://github.com/Pranav-Karra-3301/tuck/commit/9400db22e66b3dceefaf57a006ad6da82d4bdcd5))
* tuck init no longer funnels GitLab/custom users through GitHub ([d48e22c](https://github.com/Pranav-Karra-3301/tuck/commit/d48e22c4e4444e1c861f8b27a22e8dabbb756dd2))
* **tuckignore:** ensure trailing newline before appending a new entry ([b8f4d40](https://github.com/Pranav-Karra-3301/tuck/commit/b8f4d40c8960dd5ee5d17d773b516f7b4a77f700))
* **undo:** emit JSON envelopes and skip prompts for every action in --json mode ([2ef7973](https://github.com/Pranav-Karra-3301/tuck/commit/2ef7973388bc51225297e8b7e94e0db72c372921))
* **validation:** stop rejecting descriptions containing the letter 'n' ([10e795f](https://github.com/Pranav-Karra-3301/tuck/commit/10e795f5d55d63f396918e13d5ef804b902d8003))
* **verify:** materialize template/encrypted files in --apply dry-apply diff ([7f704f2](https://github.com/Pranav-Karra-3301/tuck/commit/7f704f26df1dad00ab649f43cbe954acd1ac0da4))
* **windows:** resolve symlink-guard and source-validation false positives ([7043c8d](https://github.com/Pranav-Karra-3301/tuck/commit/7043c8d48f8bc3823dc37253ff2f19da07dd65d1))


### Features

* --json/--plan/--dry-run on add, --json on init (bare/from only) ([19af4ad](https://github.com/Pranav-Karra-3301/tuck/commit/19af4adac8db699662424932c810874e8c9e794a)), closes [#5](https://github.com/Pranav-Karra-3301/tuck/issues/5)
* --json/--yes envelope output for remove/pull/push/config/secrets/apply ([21fcdc7](https://github.com/Pranav-Karra-3301/tuck/commit/21fcdc7da685c9357e43b13773efc98b30872adf))
* add 'tuck verify' — read-only live/repo/manifest drift detector ([43e540d](https://github.com/Pranav-Karra-3301/tuck/commit/43e540d58d9b32add5c00b231d506949cb3c53ce))
* add lib/stateModel.ts — shared live/repo/manifest state model ([a2db618](https://github.com/Pranav-Karra-3301/tuck/commit/a2db618f00e6a826cce04b1657cade9f8f5d7985))
* add writeContext — confined-home sandbox boundary ([890b62b](https://github.com/Pranav-Karra-3301/tuck/commit/890b62b7924473d37714204d9971fe81b62bb1ff))
* **add:** --template and --encrypt flags (encrypt-on-store) ([5b59866](https://github.com/Pranav-Karra-3301/tuck/commit/5b59866982fdadd864ee484b73da6def4644ffa9))
* agent detection patterns, 5 bundled presets, file encryption ([d475a15](https://github.com/Pranav-Karra-3301/tuck/commit/d475a159d08951d298d57486b455e11047ceba4d))
* agent-safe prompts and spinners (no hang, no JSON corruption) ([d889062](https://github.com/Pranav-Karra-3301/tuck/commit/d8890622844629686eec00dbd1cec0e278a5df64))
* agent-wedge foundation — JSON envelope, context, mcp, presets, templates ([377cd9c](https://github.com/Pranav-Karra-3301/tuck/commit/377cd9ca4689899c1185a8fa5fcc34c4a3f1b541))
* **agent+sandbox+keystore:** wave-2 — json completeness, verify dry-apply, platform/keystore hardening ([dd1cec8](https://github.com/Pranav-Karra-3301/tuck/commit/dd1cec8fbdc70cf6acd5ebc549b5d9a13827c1e5))
* **apply:** render templates and decrypt encrypted files on apply (P0-1/P0-2) ([ebf5d8a](https://github.com/Pranav-Karra-3301/tuck/commit/ebf5d8ac826f081a7adae0fbd3992168d126f767))
* bundles, merge UI, patterns registry, --json on diff/restore/undo/encryption ([b129e11](https://github.com/Pranav-Karra-3301/tuck/commit/b129e11e152bb42ab48fe1b518fe126ea6f1850d)), closes [#1](https://github.com/Pranav-Karra-3301/tuck/issues/1) [#3](https://github.com/Pranav-Karra-3301/tuck/issues/3) [#1](https://github.com/Pranav-Karra-3301/tuck/issues/1)
* confine apply/restore writes under --root via resolveWriteTarget ([e9fe0f1](https://github.com/Pranav-Karra-3301/tuck/commit/e9fe0f1330ab8acc7c6403c391db01357859498b))
* confine preset/context apply writes under --root too ([7b6904c](https://github.com/Pranav-Karra-3301/tuck/commit/7b6904cea4b6a96b086ac3d790ff36401793cf3f))
* global --root / TUCK_TARGET_ROOT to activate the write sandbox ([c209fcf](https://github.com/Pranav-Karra-3301/tuck/commit/c209fcfa6ad53c01e87a0a370b3d9400571a224c))
* harden the MCP server (correctness + safety) ([e61ca79](https://github.com/Pranav-Karra-3301/tuck/commit/e61ca79a48fb707305a1bdce9b135b20102240c0))
* idempotent sync — noop envelope + stable order + post-pull cache clear ([36ad7b3](https://github.com/Pranav-Karra-3301/tuck/commit/36ad7b3990ca351d1434ee2a08ea36d032d03d18))
* JSON envelope flushes warnings on error + single-emit guard ([881dcc0](https://github.com/Pranav-Karra-3301/tuck/commit/881dcc094f77d8a4023c7294b09c436f39df4519))
* **materialize:** add repo->live decrypt+render transform ([f1d01f9](https://github.com/Pranav-Karra-3301/tuck/commit/f1d01f967eb4a7f1c391ae11498df3010595e619))
* **mcp:** widen the MCP server with verify/diff/scan_untracked/secrets_status/apply_plan + hardening ([e679170](https://github.com/Pranav-Karra-3301/tuck/commit/e67917086677e9d6b2315c99d39148428536effb))
* **provider:** wave-3 — provider-neutral lifecycle (less GitHub coupling) ([a09f146](https://github.com/Pranav-Karra-3301/tuck/commit/a09f1463e7d955a453e4353cea28d45ad2b2a768))
* **repo-scope:** machine-local repo registry + stable repoKey identity ([8c25b90](https://github.com/Pranav-Karra-3301/tuck/commit/8c25b90ef471f6c97448e2d82109b520d91c0663))
* **repo-scope:** manifest schema fields (scope/repoKey/repoRelative) ([707d766](https://github.com/Pranav-Karra-3301/tuck/commit/707d7663f3d10955517cfdc130d7a338a7ed4ded))
* **repo-scope:** resolveLiveTarget + stateModel/verify unknown-repo state ([08c6b15](https://github.com/Pranav-Karra-3301/tuck/commit/08c6b15fec65639c99fd1a8792d82ae943eb8f69))
* **repo-scope:** sandbox-compose repo writes + thread allowedRoots into files ([4880af4](https://github.com/Pranav-Karra-3301/tuck/commit/4880af41d0d1314743e139913580aad024c4a97a))
* **repo-scope:** validateSafeRepoSourcePath + getRepoScopedDestination ([53209b3](https://github.com/Pranav-Karra-3301/tuck/commit/53209b3e41345d3dc9a007642d5e052691c3da35))
* **repo-scope:** wire add/restore/apply/sync + add 'tuck repo' command ([f811e58](https://github.com/Pranav-Karra-3301/tuck/commit/f811e587000d350a94f319f25ee401058ab77f44))
* **restore:** materialize (render+decrypt) on restore for apply parity ([d008217](https://github.com/Pranav-Karra-3301/tuck/commit/d0082172cb3ba3a97e1fd610f1593b501e0fa9ab))
* robust JSON-mode detection via Commander preAction hook ([0c51a78](https://github.com/Pranav-Karra-3301/tuck/commit/0c51a787d059a832b20a207a270aab23f9f89d4f))
* **stateModel:** compare template/encrypted files vs materialize(repo) ([1aa6de4](https://github.com/Pranav-Karra-3301/tuck/commit/1aa6de47524c9dd625d48d2d81ee19e0d279b7a4))
* sync --json/--plan/--dry-run, Bun binary build, install script ([3d3a61b](https://github.com/Pranav-Karra-3301/tuck/commit/3d3a61b88f8b4e9030b73a3920d197f03f16324a))
* tuck apply accepts a local directory or tarball (no remote/GitHub) ([8d977d4](https://github.com/Pranav-Karra-3301/tuck/commit/8d977d43be669414a9ec2687a9feb4e1714856dd))
* unify --json output of status/list/scan/doctor under the envelope ([0234592](https://github.com/Pranav-Karra-3301/tuck/commit/023459267ccbffbb26aa76381bb22a59bbf14b33))

# [1.10.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.9.0...v1.10.0) (2026-07-09)


### Bug Fixes

* **add:** forward CLI flags on the interactive add path ([fd3d252](https://github.com/Pranav-Karra-3301/tuck/commit/fd3d252ffcde90e3d0f5b4b424568d38e68c1fe0))
* **apply:** binary-safe writes, sandbox-safe secret restore, complete undo snapshot ([039a77c](https://github.com/Pranav-Karra-3301/tuck/commit/039a77c8cf69b1c2aedc5a63144e4e6d80669772))
* **apply:** defend against symlink TOCTOU escape and keep prepare off the MCP stream ([8f4ff88](https://github.com/Pranav-Karra-3301/tuck/commit/8f4ff8898dd93e754a1346a97d3c2ffdb4953ec4))
* **apply:** detect symlink redirection by component, not realpath strings ([340b8b4](https://github.com/Pranav-Karra-3301/tuck/commit/340b8b4e13040dfe111f5d72ddf73c97197cd2ea))
* **apply:** normalize paths in symlink write-guard for Windows containment ([f542098](https://github.com/Pranav-Karra-3301/tuck/commit/f542098085ad931b3fd30ec7481d147dadb8cef0))
* atomic writes for manifest, config, and secrets store ([4089822](https://github.com/Pranav-Karra-3301/tuck/commit/40898227f17aeb665c2f8d8260c1dc241d907927))
* clear no-useless-escape lint errors in template.ts ([45cb5ab](https://github.com/Pranav-Karra-3301/tuck/commit/45cb5ab8c53164752f2fc76e7b255c4cb1dc92b5))
* **cli:** correct bare-flag handling and skip update-check for `mcp serve` ([40adde6](https://github.com/Pranav-Karra-3301/tuck/commit/40adde6fa6ae9bc16b63ab982a680089b57b3a5c))
* **cli:** stop leaking encrypt-file passphrase via argv; honor TUCK_PASSWORD in JSON ([2039a29](https://github.com/Pranav-Karra-3301/tuck/commit/2039a290da195d88bc88abf80dbede9bf49100a1))
* **config:** deep-merge nested config keys so partial files keep defaults ([37027ed](https://github.com/Pranav-Karra-3301/tuck/commit/37027eda7df7715c5a754370b50922221afd7d5d))
* context apply skips existing home targets; reset jsonMode between tests ([bc4c6b0](https://github.com/Pranav-Karra-3301/tuck/commit/bc4c6b00759b5f26ff99c0dad2de93d54a570f20))
* **context:** unique repo-scoped ids and directory sync ([dd1f5ef](https://github.com/Pranav-Karra-3301/tuck/commit/dd1f5ef089b7326c244f1b6a5973a1ea606e5a1a))
* **crypto:** feed macOS keychain secret via stdin, not argv ([39fd756](https://github.com/Pranav-Karra-3301/tuck/commit/39fd7563a0177d0357a54374ec2e6efbec9b8836))
* **crypto:** harden fallback keystore (atomic write, move-aside, relocate secret) ([7fe7f0f](https://github.com/Pranav-Karra-3301/tuck/commit/7fe7f0fae6c011916c46ed3c29d0e04cb7e236cf))
* **crypto:** raise per-file KDF to 600k iterations via versioned TCKE2 header ([2d4b969](https://github.com/Pranav-Karra-3301/tuck/commit/2d4b969a7a2a553802b96c26c47cb0df7b18d758))
* decrypt-file never overwrites its ciphertext input in place ([5f7839b](https://github.com/Pranav-Karra-3301/tuck/commit/5f7839b491b865ea4cfc1f76916f4b2a7db03136))
* **diff:** make diff state-model aware and fix exit-code/context bugs ([25dd7e2](https://github.com/Pranav-Karra-3301/tuck/commit/25dd7e21598cf419a64390f8cb08bc6d428a8324))
* **doctor:** stop failing on repo-scoped entries and shipped templating ([6f0498c](https://github.com/Pranav-Karra-3301/tuck/commit/6f0498cc323dd81f66114ad167379e75dbab232f))
* **files:** align copyFileOrDir skip list with the checksum walk ([6efa5d9](https://github.com/Pranav-Karra-3301/tuck/commit/6efa5d995d549236571bcea1cbde2852aac0e718))
* gh repo create no longer uses dead --confirm/--json flags ([45cf6d7](https://github.com/Pranav-Karra-3301/tuck/commit/45cf6d75d97d0a000afbd10f2bb193f7ece87ebc))
* **gitlab:** stop passing -h to glab (it means --help), breaking the provider ([bbb6d7d](https://github.com/Pranav-Karra-3301/tuck/commit/bbb6d7decf65d313a05aee9090bb20b31e3846d8))
* **git:** only run gh auth setup-git for HTTPS github.com remotes; guard stageAll ([a63129e](https://github.com/Pranav-Karra-3301/tuck/commit/a63129e526aa51b7c8bca72503ca4f831719dd58))
* guard preset apply against path escape + silent overwrite ([fc163ce](https://github.com/Pranav-Karra-3301/tuck/commit/fc163ce47250c2536594de5740c97046a3b35a54))
* handle tracked directories across apply/restore/verify + bare-init .gitignore ([6912e6b](https://github.com/Pranav-Karra-3301/tuck/commit/6912e6b735b78a4cefbed87f00f89192b68091ed))
* harden context apply against untrusted remote manifests ([9468c01](https://github.com/Pranav-Karra-3301/tuck/commit/9468c01e8bb3fe04e909ac3e5c018dd03ec6f9d2))
* honor since filters in history scans ([a888da3](https://github.com/Pranav-Karra-3301/tuck/commit/a888da37736532f9f43eed80f336ab7c3f7f98c9))
* honor targeted restores in undo ([60014d9](https://github.com/Pranav-Karra-3301/tuck/commit/60014d9b5556f63a4e7da23750b44664cd7bdb30))
* **hooks:** decide interactivity from stdin, not stdout ([bcfa3cc](https://github.com/Pranav-Karra-3301/tuck/commit/bcfa3cc3fdc8d1c302b24234758b1650f439ef0d))
* **json:** gate human/spinner output behind JSON mode so --json emits one object ([5070058](https://github.com/Pranav-Karra-3301/tuck/commit/5070058273d0a48d5a50e530936c8f663c8fc5f7))
* **json:** suppress tracking stdout in --json mode ([bfed982](https://github.com/Pranav-Karra-3301/tuck/commit/bfed98263acc591f753bf8b52bd80a081a6362d4))
* **list:** emit a JSON envelope when --json category has no matches ([c780e63](https://github.com/Pranav-Karra-3301/tuck/commit/c780e638c434775211d27e403912561c1e0353bc))
* make directory checksums sensitive to filenames/structure ([1066e26](https://github.com/Pranav-Karra-3301/tuck/commit/1066e26d5ff59283b377b72a7156ca3c13db796d))
* make undo (snapshot restore) reversible and snapshot writes safe ([e18a5ff](https://github.com/Pranav-Karra-3301/tuck/commit/e18a5ff20b9fbdba807613978a0a2b55e4f65900))
* **manifest:** never leave cache diverged when a save fails ([3a6624d](https://github.com/Pranav-Karra-3301/tuck/commit/3a6624dd14dd59859037830e33c939079cf21f8d))
* **mcp:** survive malformed requests and drain in-flight work before exit ([3c55595](https://github.com/Pranav-Karra-3301/tuck/commit/3c555953fa5b4d98f464034ea309ed474937492a))
* **merge:** correct rebase ours/theirs orientation and harden conflict resolution ([4fc99d1](https://github.com/Pranav-Karra-3301/tuck/commit/4fc99d1690723d685235aa670e672c947c735c82))
* **merge:** make smartMerge banner idempotent to stop unbounded file growth ([691b9b0](https://github.com/Pranav-Karra-3301/tuck/commit/691b9b0ee1eec669cc27d68087e9022aaa3e2782))
* never block or corrupt JSON on hook confirmation in non-interactive mode ([ddc15e9](https://github.com/Pranav-Karra-3301/tuck/commit/ddc15e990d6ac6cbfc37135f10f750fea26873a3))
* **paths:** correct home-boundary matching and Windows drive-letter handling ([95147cc](https://github.com/Pranav-Karra-3301/tuck/commit/95147cc6b78397b8a9d18ee712f1f4f73c59f4a5))
* **preset:** resolve bundled registry/patterns dir to first existing candidate ([5dce2ce](https://github.com/Pranav-Karra-3301/tuck/commit/5dce2ce6442c071423437e20e235f3c70e77d82f))
* **pull:** add --yes, detect no-upstream commits, and abort on conflict ([92022c0](https://github.com/Pranav-Karra-3301/tuck/commit/92022c0482b80af0c3db62ebc366cafd13784c3c))
* **push:** honor --yes non-interactively and fetch before divergence check ([5483179](https://github.com/Pranav-Karra-3301/tuck/commit/54831795e852068aebf11c9ead3bb462752b89d4))
* redact gitleaks match context so secrets don't print to stdout ([0df8faf](https://github.com/Pranav-Karra-3301/tuck/commit/0df8fafa6b2a33fd7166b1381e2124976a7185de))
* redact longest secret values first to avoid cleartext remainder leak ([3fb55af](https://github.com/Pranav-Karra-3301/tuck/commit/3fb55af0beba8f3898660fc4a74f64bc85c83c37))
* reject leading-dash secret backend paths (argument injection) ([f045076](https://github.com/Pranav-Karra-3301/tuck/commit/f045076efb70620f18141014d1f081ed6eabf296))
* **remove:** restore symlinked originals and untrack repo-scoped files ([73914fe](https://github.com/Pranav-Karra-3301/tuck/commit/73914fe32257e858379c4c4483447cbbfef9604b))
* restore --yes/--json must not implicitly restore ALL files ([f77cc2e](https://github.com/Pranav-Karra-3301/tuck/commit/f77cc2ec8710211fd0be53dba42ab1bd29db7123))
* restore files after pull when requested ([45e13b8](https://github.com/Pranav-Karra-3301/tuck/commit/45e13b8d4d16f077949f2d5ce94206776a9b07bb))
* **restore:** honor dry-run/no-hooks in interactive path and fix sandbox backup ([f385014](https://github.com/Pranav-Karra-3301/tuck/commit/f3850142cdba2763c8a98014a8c4346180f55c75))
* **restore:** suppress runRestore human output in JSON mode ([10850db](https://github.com/Pranav-Karra-3301/tuck/commit/10850db587c6e690a97b22a5dfc17b83f6e43035))
* **review+win:** capture source stat before copy; cross-platform Wave-5 tests ([cb49d8e](https://github.com/Pranav-Karra-3301/tuck/commit/cb49d8efce89cca00adb5c10663a711d200f1abd))
* **review:** address PR [#98](https://github.com/Pranav-Karra-3301/tuck/issues/98) review (symlink materialize bypass, dir drift, etc.) ([fc335d5](https://github.com/Pranav-Karra-3301/tuck/commit/fc335d5ad6fd7b28ede6a54a73476dbe809b15c7))
* **review:** address Wave-2 adversarial review — sandbox context restore + keystore race/probe ([8419bd4](https://github.com/Pranav-Karra-3301/tuck/commit/8419bd4228b716715d9c12e50c379e7e09c8cf95)), closes [#93](https://github.com/Pranav-Karra-3301/tuck/issues/93)
* **review:** address Wave-3 review — real clone maxBuffer, config-remote truthfulness, provider-neutral auto-create ([228c5c8](https://github.com/Pranav-Karra-3301/tuck/commit/228c5c8977232cefe3a25e4243bb5873cb2ca51c)), closes [#94](https://github.com/Pranav-Karra-3301/tuck/issues/94)
* **review:** clear config cache after the two interactive config writes ([acd013d](https://github.com/Pranav-Karra-3301/tuck/commit/acd013d4493dea87f60ff6aa7127aaad54547ca1))
* **safety:** wave-1 data-loss & safety hardening (snapshot atomicity, lifecycle, paths/perms, audit/binary) ([f8fba30](https://github.com/Pranav-Karra-3301/tuck/commit/f8fba308c53ee2deb76c7b54981a7353a364e293))
* scan for secrets in non-interactive (--json/--yes) sync [CRITICAL] ([1829879](https://github.com/Pranav-Karra-3301/tuck/commit/182987914eefa214099f76b7b47f9b888d3dffc3))
* scan tracked files for secrets by default ([a230b81](https://github.com/Pranav-Karra-3301/tuck/commit/a230b817f407b3122b5e2a0fbd9a3a14c800c0c4))
* **scan:** honor pattern exclude lists when tracking directories ([42222bf](https://github.com/Pranav-Karra-3301/tuck/commit/42222bf1c4b14ab3d1177825405b5794d94edfd7))
* **secrets:** clone default mappings so setMapping cannot mutate the module default ([d1dd44a](https://github.com/Pranav-Karra-3301/tuck/commit/d1dd44a6f12ebfbe380093547169154e10e0bb7a))
* **secrets:** insert restored secrets literally, not as $-patterns ([5d04e1f](https://github.com/Pranav-Karra-3301/tuck/commit/5d04e1fe10dcdea81f9a9fc1ba2e5b49d450dcae))
* **secrets:** read gitleaks findings from --report-path, not stdout ([e317c4a](https://github.com/Pranav-Karra-3301/tuck/commit/e317c4af977cceaf64c6e3fbd103b60958e1cc54))
* **secrets:** scan directory candidates and fix repo-scoped ignore action ([8bdcab7](https://github.com/Pranav-Karra-3301/tuck/commit/8bdcab7b46233a84db70bd4584e00f338eafbd09))
* **secrets:** split bitwarden item/field before the item lookup ([97af24a](https://github.com/Pranav-Karra-3301/tuck/commit/97af24a010042a27692dd27ed79bf23aa87fc702))
* **secrets:** validate pass gpgId before embedding in GPG_OPTS ([cbfb686](https://github.com/Pranav-Karra-3301/tuck/commit/cbfb68674b50d2a7417739dd12061caeb34325d7))
* **status:** detect changes via the shared state model ([83581dc](https://github.com/Pranav-Karra-3301/tuck/commit/83581dcbf90c080662a6cc94bead3cba88ce47ff))
* store password-verification data off-repo + repair broken scrypt KDF ([f6af58d](https://github.com/Pranav-Karra-3301/tuck/commit/f6af58d45afa12ba2ed28856efc0a5c9aab24204))
* sync respects local-only mode (don't auto-push to a stray remote) ([e0dd432](https://github.com/Pranav-Karra-3301/tuck/commit/e0dd4328e814a25458f1b01e368deefe3c321cfc))
* **sync:** commit pending repo changes when no tracked file drifted ([1ea50dd](https://github.com/Pranav-Karra-3301/tuck/commit/1ea50ddeee78c1ec677e6fdc7e7590ddbd2ac679))
* **sync:** mirror tracked dirs, back up deletions, honor repo-scoped ignore ([5618977](https://github.com/Pranav-Karra-3301/tuck/commit/5618977f14fab04846bba303e0b81c41eecb2112))
* **sync:** never capture template/encrypted files live->repo (no clobber/leak) ([6f313e5](https://github.com/Pranav-Karra-3301/tuck/commit/6f313e5eba4484c96b5e948eb4019900bc0bab81))
* **template:** accept unquoted tuck:if literals instead of silently dropping blocks ([5f569b9](https://github.com/Pranav-Karra-3301/tuck/commit/5f569b918f0719647998d7273f92d58ed98a2db9))
* **timemachine:** snapshot out-of-home paths and make single-file undo reversible ([9400db2](https://github.com/Pranav-Karra-3301/tuck/commit/9400db22e66b3dceefaf57a006ad6da82d4bdcd5))
* tuck init no longer funnels GitLab/custom users through GitHub ([d48e22c](https://github.com/Pranav-Karra-3301/tuck/commit/d48e22c4e4444e1c861f8b27a22e8dabbb756dd2))
* **tuckignore:** ensure trailing newline before appending a new entry ([b8f4d40](https://github.com/Pranav-Karra-3301/tuck/commit/b8f4d40c8960dd5ee5d17d773b516f7b4a77f700))
* **undo:** emit JSON envelopes and skip prompts for every action in --json mode ([2ef7973](https://github.com/Pranav-Karra-3301/tuck/commit/2ef7973388bc51225297e8b7e94e0db72c372921))
* **validation:** stop rejecting descriptions containing the letter 'n' ([10e795f](https://github.com/Pranav-Karra-3301/tuck/commit/10e795f5d55d63f396918e13d5ef804b902d8003))
* **verify:** materialize template/encrypted files in --apply dry-apply diff ([7f704f2](https://github.com/Pranav-Karra-3301/tuck/commit/7f704f26df1dad00ab649f43cbe954acd1ac0da4))
* **windows:** resolve symlink-guard and source-validation false positives ([7043c8d](https://github.com/Pranav-Karra-3301/tuck/commit/7043c8d48f8bc3823dc37253ff2f19da07dd65d1))


### Features

* --json/--plan/--dry-run on add, --json on init (bare/from only) ([19af4ad](https://github.com/Pranav-Karra-3301/tuck/commit/19af4adac8db699662424932c810874e8c9e794a)), closes [#5](https://github.com/Pranav-Karra-3301/tuck/issues/5)
* --json/--yes envelope output for remove/pull/push/config/secrets/apply ([21fcdc7](https://github.com/Pranav-Karra-3301/tuck/commit/21fcdc7da685c9357e43b13773efc98b30872adf))
* add 'tuck verify' — read-only live/repo/manifest drift detector ([43e540d](https://github.com/Pranav-Karra-3301/tuck/commit/43e540d58d9b32add5c00b231d506949cb3c53ce))
* add lib/stateModel.ts — shared live/repo/manifest state model ([a2db618](https://github.com/Pranav-Karra-3301/tuck/commit/a2db618f00e6a826cce04b1657cade9f8f5d7985))
* add writeContext — confined-home sandbox boundary ([890b62b](https://github.com/Pranav-Karra-3301/tuck/commit/890b62b7924473d37714204d9971fe81b62bb1ff))
* **add:** --template and --encrypt flags (encrypt-on-store) ([5b59866](https://github.com/Pranav-Karra-3301/tuck/commit/5b59866982fdadd864ee484b73da6def4644ffa9))
* agent detection patterns, 5 bundled presets, file encryption ([d475a15](https://github.com/Pranav-Karra-3301/tuck/commit/d475a159d08951d298d57486b455e11047ceba4d))
* agent-safe prompts and spinners (no hang, no JSON corruption) ([d889062](https://github.com/Pranav-Karra-3301/tuck/commit/d8890622844629686eec00dbd1cec0e278a5df64))
* agent-wedge foundation — JSON envelope, context, mcp, presets, templates ([377cd9c](https://github.com/Pranav-Karra-3301/tuck/commit/377cd9ca4689899c1185a8fa5fcc34c4a3f1b541))
* **agent+sandbox+keystore:** wave-2 — json completeness, verify dry-apply, platform/keystore hardening ([dd1cec8](https://github.com/Pranav-Karra-3301/tuck/commit/dd1cec8fbdc70cf6acd5ebc549b5d9a13827c1e5))
* **apply:** render templates and decrypt encrypted files on apply (P0-1/P0-2) ([ebf5d8a](https://github.com/Pranav-Karra-3301/tuck/commit/ebf5d8ac826f081a7adae0fbd3992168d126f767))
* bundles, merge UI, patterns registry, --json on diff/restore/undo/encryption ([b129e11](https://github.com/Pranav-Karra-3301/tuck/commit/b129e11e152bb42ab48fe1b518fe126ea6f1850d)), closes [#1](https://github.com/Pranav-Karra-3301/tuck/issues/1) [#3](https://github.com/Pranav-Karra-3301/tuck/issues/3) [#1](https://github.com/Pranav-Karra-3301/tuck/issues/1)
* confine apply/restore writes under --root via resolveWriteTarget ([e9fe0f1](https://github.com/Pranav-Karra-3301/tuck/commit/e9fe0f1330ab8acc7c6403c391db01357859498b))
* confine preset/context apply writes under --root too ([7b6904c](https://github.com/Pranav-Karra-3301/tuck/commit/7b6904cea4b6a96b086ac3d790ff36401793cf3f))
* global --root / TUCK_TARGET_ROOT to activate the write sandbox ([c209fcf](https://github.com/Pranav-Karra-3301/tuck/commit/c209fcfa6ad53c01e87a0a370b3d9400571a224c))
* harden the MCP server (correctness + safety) ([e61ca79](https://github.com/Pranav-Karra-3301/tuck/commit/e61ca79a48fb707305a1bdce9b135b20102240c0))
* idempotent sync — noop envelope + stable order + post-pull cache clear ([36ad7b3](https://github.com/Pranav-Karra-3301/tuck/commit/36ad7b3990ca351d1434ee2a08ea36d032d03d18))
* JSON envelope flushes warnings on error + single-emit guard ([881dcc0](https://github.com/Pranav-Karra-3301/tuck/commit/881dcc094f77d8a4023c7294b09c436f39df4519))
* **materialize:** add repo->live decrypt+render transform ([f1d01f9](https://github.com/Pranav-Karra-3301/tuck/commit/f1d01f967eb4a7f1c391ae11498df3010595e619))
* **mcp:** widen the MCP server with verify/diff/scan_untracked/secrets_status/apply_plan + hardening ([e679170](https://github.com/Pranav-Karra-3301/tuck/commit/e67917086677e9d6b2315c99d39148428536effb))
* **provider:** wave-3 — provider-neutral lifecycle (less GitHub coupling) ([a09f146](https://github.com/Pranav-Karra-3301/tuck/commit/a09f1463e7d955a453e4353cea28d45ad2b2a768))
* **repo-scope:** machine-local repo registry + stable repoKey identity ([8c25b90](https://github.com/Pranav-Karra-3301/tuck/commit/8c25b90ef471f6c97448e2d82109b520d91c0663))
* **repo-scope:** manifest schema fields (scope/repoKey/repoRelative) ([707d766](https://github.com/Pranav-Karra-3301/tuck/commit/707d7663f3d10955517cfdc130d7a338a7ed4ded))
* **repo-scope:** resolveLiveTarget + stateModel/verify unknown-repo state ([08c6b15](https://github.com/Pranav-Karra-3301/tuck/commit/08c6b15fec65639c99fd1a8792d82ae943eb8f69))
* **repo-scope:** sandbox-compose repo writes + thread allowedRoots into files ([4880af4](https://github.com/Pranav-Karra-3301/tuck/commit/4880af41d0d1314743e139913580aad024c4a97a))
* **repo-scope:** validateSafeRepoSourcePath + getRepoScopedDestination ([53209b3](https://github.com/Pranav-Karra-3301/tuck/commit/53209b3e41345d3dc9a007642d5e052691c3da35))
* **repo-scope:** wire add/restore/apply/sync + add 'tuck repo' command ([f811e58](https://github.com/Pranav-Karra-3301/tuck/commit/f811e587000d350a94f319f25ee401058ab77f44))
* **restore:** materialize (render+decrypt) on restore for apply parity ([d008217](https://github.com/Pranav-Karra-3301/tuck/commit/d0082172cb3ba3a97e1fd610f1593b501e0fa9ab))
* robust JSON-mode detection via Commander preAction hook ([0c51a78](https://github.com/Pranav-Karra-3301/tuck/commit/0c51a787d059a832b20a207a270aab23f9f89d4f))
* **stateModel:** compare template/encrypted files vs materialize(repo) ([1aa6de4](https://github.com/Pranav-Karra-3301/tuck/commit/1aa6de47524c9dd625d48d2d81ee19e0d279b7a4))
* sync --json/--plan/--dry-run, Bun binary build, install script ([3d3a61b](https://github.com/Pranav-Karra-3301/tuck/commit/3d3a61b88f8b4e9030b73a3920d197f03f16324a))
* tuck apply accepts a local directory or tarball (no remote/GitHub) ([8d977d4](https://github.com/Pranav-Karra-3301/tuck/commit/8d977d43be669414a9ec2687a9feb4e1714856dd))
* unify --json output of status/list/scan/doctor under the envelope ([0234592](https://github.com/Pranav-Karra-3301/tuck/commit/023459267ccbffbb26aa76381bb22a59bbf14b33))

# [1.9.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.8.0...v1.9.0) (2026-02-20)


### Bug Fixes

* close remaining naming and credential safety gaps ([670e5d5](https://github.com/Pranav-Karra-3301/tuck/commit/670e5d5c0f2ffade52de09ede97bb514322ef3e6))
* enforce safe destination paths and harden test isolation ([11c167f](https://github.com/Pranav-Karra-3301/tuck/commit/11c167fdd28462d80ee7fc49aab4bff9757fd14d))
* harden manifest path validation and add doctor plan ([75d822a](https://github.com/Pranav-Karra-3301/tuck/commit/75d822a0d2a648c7454b35bdb262aae15123be4c))
* harden tracking pipeline and security safeguards ([289990b](https://github.com/Pranav-Karra-3301/tuck/commit/289990bf0c2c408ee51a438c95e66f1f22dc3f7f))
* improve doctor home and tuck directory checks ([62b9ba0](https://github.com/Pranav-Karra-3301/tuck/commit/62b9ba052fc689a20c47c5364a32cbca81b799c6))
* validate backup directory path safety in getBackupDir() ([34bcb7f](https://github.com/Pranav-Karra-3301/tuck/commit/34bcb7faa09a143c394a216984fb4b17b5fe1504))


### Features

* add tuck doctor command and expand command smoke coverage ([518462b](https://github.com/Pranav-Karra-3301/tuck/commit/518462b903cda96b6a4880e27a2bcf8d2ac458c6))

# [1.8.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.7.0...v1.8.0) (2026-02-01)


### Bug Fixes

* add longer timeouts for git tests on Windows CI ([a63a439](https://github.com/Pranav-Karra-3301/tuck/commit/a63a439eecabe063a55d0bb2860526377977454a))
* address additional Copilot code review feedback ([7a8dc65](https://github.com/Pranav-Karra-3301/tuck/commit/7a8dc65b27a77fe5224fe2d50f08bcc300b90ce3))
* address code review feedback ([7b4393b](https://github.com/Pranav-Karra-3301/tuck/commit/7b4393b48a986f4d5c56b661583067b2a4dfe4c0))
* address code review issues for password manager integration ([9929af0](https://github.com/Pranav-Karra-3301/tuck/commit/9929af0e510b9ded5db8dac208c55e81144de739))
* address comprehensive code review findings ([cbc37ac](https://github.com/Pranav-Karra-3301/tuck/commit/cbc37ac33e7a0feb3475e44341096df49a20bac1))
* comprehensive bug fixes and expanded test coverage ([e81c31f](https://github.com/Pranav-Karra-3301/tuck/commit/e81c31f2aaa358588d11be86821630c2c39c2ce7))
* correct Homebrew tap name in README ([4807b47](https://github.com/Pranav-Karra-3301/tuck/commit/4807b47f3aab42cd9325ea06aacbb09980dc6ec3)), closes [#74](https://github.com/Pranav-Karra-3301/tuck/issues/74)
* make tests cross-platform for Windows CI ([88c7ae6](https://github.com/Pranav-Karra-3301/tuck/commit/88c7ae6513b0ae24423ad54f410e5d5f49935cdf))
* remove unused variables and imports from test files ([7bc2543](https://github.com/Pranav-Karra-3301/tuck/commit/7bc25438231f928fb1eb858fdf468377147b614c))
* resolve lint errors and remove remotion/video files ([968a290](https://github.com/Pranav-Karra-3301/tuck/commit/968a2902b8dac0d4a2a33ff1b5e4808fd703bad5))
* resolve Windows test failures in paths.test.ts ([85ac358](https://github.com/Pranav-Karra-3301/tuck/commit/85ac3583f14917966970cf151615522ee30e2aa4))
* resolve Windows test failures in paths.test.ts ([f103c67](https://github.com/Pranav-Karra-3301/tuck/commit/f103c676cde62a1e0e529c7b4506670969dd9686))
* use !== 1 for pluralization in status messages ([8bd62c3](https://github.com/Pranav-Karra-3301/tuck/commit/8bd62c34fcf1ff3445b9a58b7e698ea444ad5902))


### Features

* add security hardening, audit logging, and comprehensive testing ([a2939f2](https://github.com/Pranav-Karra-3301/tuck/commit/a2939f2316faffbd12c3abdd01881e1f92145de4))
* add Windows compatibility support ([42e8fb0](https://github.com/Pranav-Karra-3301/tuck/commit/42e8fb00b7628a77e98c6e2e06da8335d5b5ec53))
* enhance secret management with auto-restore and configurable blocking ([01c1816](https://github.com/Pranav-Karra-3301/tuck/commit/01c181699d24c6ab94ce6c99fc8b6d1f75dbc34f))

# [1.7.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.6.0...v1.7.0) (2026-01-18)


### Bug Fixes

* implement security hardening and code quality improvements ([58df03a](https://github.com/Pranav-Karra-3301/tuck/commit/58df03a6fdf9e1a7e3fb9c6b524d02b033a3c938))
* resolve ESLint warnings in validation utilities ([fbbc76a](https://github.com/Pranav-Karra-3301/tuck/commit/fbbc76a01acb4f753d97885f4cc194a6af16276c))
* restore provider parameter in validateRepoName ([66d9076](https://github.com/Pranav-Karra-3301/tuck/commit/66d9076571333704de3ac64486b4cf468c98b569))


### Features

* add multi-provider support with provider abstraction layer ([44381c1](https://github.com/Pranav-Karra-3301/tuck/commit/44381c1f95862440ddaa06f853a5e2f457818ddb))

# [1.6.0](https://github.com/Pranav-Karra-3301/tuck/compare/v1.5.2...v1.6.0) (2026-01-14)


### Features

* add auto-update checking with interactive prompt ([67f1dcd](https://github.com/Pranav-Karra-3301/tuck/commit/67f1dcdd02c09fe0faf8b9c417233a55619d16c4))

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
