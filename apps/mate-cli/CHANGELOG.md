# Changelog

## Unreleased

### Removed

- **BREAKING** The Headroom capability. `mate cap headroom [args...]` no longer exists, Headroom is no longer offered during setup, and `mate report` no longer collects Headroom savings.
- **BREAKING** Managed launches are no longer routed through a proxy. Mate supplies no `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or provider `baseURL`; a caller that relied on Mate setting one must supply it in its own environment or OpenCode configuration.
- **BREAKING** The `rtk-capability-split-v1` configuration migration. A Companion Repository configured before RTK was split out of Headroom, upgrading directly to this release, will not have `rtk` back-filled — reselect RTK with `mate setup` if it is missing.

### Changed

- Loading a companion configuration is now a pure read: `ConfigStore.load()` writes nothing. Creating a configuration that does not yet exist is still a write.
- A `framework.yaml` still listing `{ name: "headroom" }` is inert. Loading succeeds, the entry is neither removed nor rewritten, and no migration strips it.

### Notes

- Mate no longer installs the `headroom-ai` uv tool and no longer removes it. Uninstall it manually with `uv tool uninstall headroom-ai`, and delete any leftover `.headroom/` directory. A detached `headroom proxy` started by an earlier release keeps running until it is killed or the machine restarts.

## [0.15.5](https://github.com/uniqbit-ag/mate-cli/compare/0.15.4...0.15.5) (2026-08-12)

## [0.15.5-canary.4](https://github.com/uniqbit-ag/mate-cli/compare/0.15.4...0.15.5) (2026-08-12)

### Features

- add local package packing workflow ([1261874](https://github.com/uniqbit-ag/mate-cli/commit/1261874c849b0c8c5a95a26c7f9e0ff49a51f255))

### Bug Fixes

- gitignore settings.local.json.bak in companion setup ([3d9f6fe](https://github.com/uniqbit-ag/mate-cli/commit/3d9f6fe6bab10ca7ccbf7a67433b43f35f4a064c))

## [0.15.5-canary.3](https://github.com/uniqbit-ag/mate-cli/compare/0.15.4...0.15.5) (2026-08-11)

### Bug Fixes

- dispatch hub-scoped capability setup hooks ([88ee075](https://github.com/uniqbit-ag/mate-cli/commit/88ee075aa3ded12f69a8ccbaa3f4e13aaa558fdb))

## [0.15.5-canary.2](https://github.com/uniqbit-ag/mate-cli/compare/0.15.4...0.15.5) (2026-08-11)

### Features

- re-resolve canary plugin versions on every install ([dbfdce6](https://github.com/uniqbit-ag/mate-cli/commit/dbfdce685dd4dd41c3ad2bf87e25c4d248b2960b))

### Bug Fixes

- narrow managed MCP gitignore entry ([99fde4b](https://github.com/uniqbit-ag/mate-cli/commit/99fde4b7d7995a3ba1026329715a68436bfac0b8))
- restore companion workspace injection ([8711c96](https://github.com/uniqbit-ag/mate-cli/commit/8711c964bbd8558274db44d5facdbf8e8957f99d))

## [0.15.5-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.15.4...0.15.5) (2026-08-11)

### Features

- add workspace list/materialize commands and mate-vscode extension ([2ebf515](https://github.com/uniqbit-ag/mate-cli/commit/2ebf515a551dc9a37dfa01fe45d8d5f449dd1a79))
- expand workspace and OpenSpec tooling ([55bba6f](https://github.com/uniqbit-ag/mate-cli/commit/55bba6f802f9afba76e66845da25cce81ef24fdb))

### Bug Fixes

- **openspec:** reconcile canonical frontmatter on finish ([3f87bb7](https://github.com/uniqbit-ag/mate-cli/commit/3f87bb7a081a67114849be7d2a713a3ffbfb06ea))

## [0.15.5-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.15.4...0.15.5) (2026-08-06)

### Features

- distinguish canonical spec frontmatter ([61f15bc](https://github.com/uniqbit-ag/mate-cli/commit/61f15bcc2dd675e66bd9891eae3ec36db75609f4))
- refine OpenSpec scope guidance ([2e21492](https://github.com/uniqbit-ag/mate-cli/commit/2e2149210a1cd5e3f744d9a5994a24b7201988e4))

## [0.15.4](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-05)

## [0.15.4-canary.12](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-05)

### Features

- **setup:** add agent-definition runtime contributions for openspec backfill ([74df601](https://github.com/uniqbit-ag/mate-cli/commit/74df601311a2b5d7126155146d51c3ce0f90eef8))

### Bug Fixes

- **opencode:** scope archive snapshots per tool call, retire legacy finish skill ([8637772](https://github.com/uniqbit-ag/mate-cli/commit/8637772e8251cfc42042a2c412564a12b6d91aab))
- **orchestrator:** harden companion git sync merge and error handling ([dc55d9f](https://github.com/uniqbit-ag/mate-cli/commit/dc55d9f1a386cc828bd93c52bc12c9eb42777e16))

## [0.15.4-canary.11](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-05)

### Features

- **setup:** support hub-scoped setup limited to MCP contributions ([7b7286f](https://github.com/uniqbit-ag/mate-cli/commit/7b7286f0aa351da12d3cba3ef4453b1359d8670e))

## [0.15.4-canary.10](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-04)

## [0.15.4-canary.9](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-04)

## [0.15.4-canary.8](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-04)

### Features

- allow plugin install in hub roots; gate hub cmds off companions ([a6cdefc](https://github.com/uniqbit-ag/mate-cli/commit/a6cdefcc3acc4925c34fe53f9a8fafd9bf952f94))

## [0.15.4-canary.7](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-04)

## [0.15.4-canary.6](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-04)

### Bug Fixes

- prevent guidance install in hub roots ([b04e5b6](https://github.com/uniqbit-ag/mate-cli/commit/b04e5b62c257ed0e0fe2934a854007701abdcc0e))

## [0.15.4-canary.5](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-03)

## [0.15.4-canary.4](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-03)

### Bug Fixes

- initialize hub config with complete defaults ([13ae295](https://github.com/uniqbit-ag/mate-cli/commit/13ae2953c6f2e16bcdd84ab14670ab26f793c0bd))

## [0.15.4-canary.3](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-03)

## [0.15.4-canary.2](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-03)

## [0.15.4-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-08-03)

### Features

- add companion hub commands ([cdf634f](https://github.com/uniqbit-ag/mate-cli/commit/cdf634f8f508ef2c3fd6c87af981fae89899209c))
- add mate plugin install command and registry-hint diagnostics ([38b5b07](https://github.com/uniqbit-ag/mate-cli/commit/38b5b07aea325d1dd4a81e297a6bc73bb0fd99bd))

### Bug Fixes

- enforce unfinished OpenSpec artifact finishing ([3a3c1d4](https://github.com/uniqbit-ag/mate-cli/commit/3a3c1d43a3b1118b30793d43007534a5bd40146d))
- remove implicit hub editor opening ([92a1ab9](https://github.com/uniqbit-ag/mate-cli/commit/92a1ab96de142d9e2ca94838dc073763b553a37d))

## [0.15.4-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.15.3...0.15.4) (2026-07-30)

## [0.15.3](https://github.com/uniqbit-ag/mate-cli/compare/0.15.2...0.15.3) (2026-07-29)

## [0.15.3-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.15.2...0.15.3) (2026-07-29)

### Bug Fixes

- correct RTK install fallback URL ([080b3fd](https://github.com/uniqbit-ag/mate-cli/commit/080b3fd92a2ff0a8960056a83edc77f8643c9729))

## [0.15.2](https://github.com/uniqbit-ag/mate-cli/compare/0.15.1...0.15.2) (2026-07-29)

## [0.15.2-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.15.1...0.15.2) (2026-07-29)

### Bug Fixes

- install OpenSpec when capability is enabled ([6e1ca68](https://github.com/uniqbit-ag/mate-cli/commit/6e1ca68cf611131fe73b5e00186d2c3a0d3e9961))
- isolate test git configs from global excludesFile ([e825306](https://github.com/uniqbit-ag/mate-cli/commit/e82530605a22c6895d59e9c03df0d6aa1ac82be8))
- validate Rust before TokenSave install ([72e0fcd](https://github.com/uniqbit-ag/mate-cli/commit/72e0fcd3bb5321efc7d6eff40964372040b4a1bf))

## [0.15.2-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.15.1...0.15.2) (2026-07-29)

### Features

- improve reports and dynamic plugin command discovery ([eb5254a](https://github.com/uniqbit-ag/mate-cli/commit/eb5254ace0b8bde95a2f489472640a4e27435c51))
- support structured report documents ([e1aaeb9](https://github.com/uniqbit-ag/mate-cli/commit/e1aaeb9de38c6f6ecaab91affaa154af1cfc5dba))

## [0.15.1](https://github.com/uniqbit-ag/mate-cli/compare/0.15.0...0.15.1) (2026-07-29)

### Bug Fixes

- gate report command on installation ([89b5ed1](https://github.com/uniqbit-ag/mate-cli/commit/89b5ed1476d3ce2be07b264a75681155e9957f64))

## [0.15.1-canary.4](https://github.com/uniqbit-ag/mate-cli/compare/0.15.0...0.15.1) (2026-07-28)

### Bug Fixes

- apply command-specific CLI gates ([cd92791](https://github.com/uniqbit-ag/mate-cli/commit/cd9279124991cd09b99d73883785a7659c69d715))
- standardize setup guidance and dependency ignores ([46cbb2d](https://github.com/uniqbit-ag/mate-cli/commit/46cbb2dba96217ef6db05aeb3b310872ed960163))

## [0.15.1-canary.3](https://github.com/uniqbit-ag/mate-cli/compare/0.15.0...0.15.1) (2026-07-28)

### Features

- support companion-declared dynamic plugins ([e522fd5](https://github.com/uniqbit-ag/mate-cli/commit/e522fd5116740e4bf7ba9c517a61bff2ab83aeb5))

### Bug Fixes

- scope update state and delegate tokensave setup ([c82cacc](https://github.com/uniqbit-ag/mate-cli/commit/c82caccc7904448c11cac457e5f7a342c351d406))

## [0.15.1-canary.2](https://github.com/uniqbit-ag/mate-cli/compare/0.15.0...0.15.1) (2026-07-28)

### Features

- separate framework identity from invocation command name ([9467630](https://github.com/uniqbit-ag/mate-cli/commit/946763071344705bba3f6a39bdc9b6fb1c44770f))

### Bug Fixes

- allow Claude config writes and existing artifact edits ([a1d55cb](https://github.com/uniqbit-ag/mate-cli/commit/a1d55cb06b71031ebf09a445b0b7a97f9041d8fb))

## [0.15.1-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.15.0...0.15.1) (2026-07-27)

### Features

- add context-mode capability and launch preflight ([bc73844](https://github.com/uniqbit-ag/mate-cli/commit/bc73844632ba16e88788315ada59f6fbbec1454a))

## [0.15.1-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.15.0...0.15.1) (2026-07-27)

### Features

- add RTK capability, rename artifact-finish, simplify headroom ([e6f6378](https://github.com/uniqbit-ag/mate-cli/commit/e6f63786f147f7d3fea7ca9d765d3b894aee2f53))

### Bug Fixes

- guard direct OpenSpec archive commands ([8ec05c6](https://github.com/uniqbit-ag/mate-cli/commit/8ec05c608434244100ab4d5f046fbb693e57696c))

## [0.15.0](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-27)

## [0.15.0-canary.10](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-24)

## [0.15.0-canary.9](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-24)

### Bug Fixes

- unify linked-repo setup with companion flow and honor pinned path ([754c3c3](https://github.com/uniqbit-ag/mate-cli/commit/754c3c39d3a03d02c04486e4968512fcddb6c39b))

## [0.15.0-canary.8](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-24)

### Bug Fixes

- stabilize CLI execution and provider teardown ([50c29ed](https://github.com/uniqbit-ag/mate-cli/commit/50c29edfcab8ea4fafbdda2ca640bd438d2fee1b))

## [0.15.0-canary.7](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-24)

### Features

- added claude state folder to gitignore ([2db7b09](https://github.com/uniqbit-ag/mate-cli/commit/2db7b09dcc2be5968a8d976a82343407cda19f78))

## [0.15.0-canary.6](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-24)

## [0.15.0-canary.5](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-23)

## [0.15.0-canary.4](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-23)

### Features

- enforce update requirement before running commands ([8710592](https://github.com/uniqbit-ag/mate-cli/commit/871059257c433159067a52ea45de0f0fb45e30dc))

## [0.15.0-canary.3](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-23)

### Features

- add plugin-contributed CLI commands ([97c3697](https://github.com/uniqbit-ag/mate-cli/commit/97c3697fb6034bc4efa9fada3556999cb977b5ff))
- make self-update package and registry configurable ([ee9ba8d](https://github.com/uniqbit-ag/mate-cli/commit/ee9ba8db7e8a5438cea13098baba13bc84dbb791))

## [0.15.0-canary.2](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-22)

## [0.15.0-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-22)

### Bug Fixes

- preserve capability-aware OpenCode guidance ([921f692](https://github.com/uniqbit-ag/mate-cli/commit/921f692bbd18e24009483992dc25f3ce4ebfd4e9))

## [0.15.0-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.14.4...0.15.0) (2026-07-22)

### Features

- extract OpenCode integration into publishable packages ([afe3d29](https://github.com/uniqbit-ag/mate-cli/commit/afe3d2913882f8640f14fe87328566bde0889684))
- refine OpenSpec scope inheritance rules ([a556946](https://github.com/uniqbit-ag/mate-cli/commit/a556946489fd1fc02b048b91d37bb80d9e1aa4ca))
