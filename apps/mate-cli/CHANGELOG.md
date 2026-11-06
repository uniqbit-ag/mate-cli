# Changelog

## [0.20.0](https://github.com/uniqbit-ag/mate-cli/compare/0.18.5...0.20.0) (2026-11-06)

## [1.0.0-canary.5](https://github.com/uniqbit-ag/mate-cli/compare/0.18.5...0.20.0) (2026-11-05)

## [1.0.0-canary.4](https://github.com/uniqbit-ag/mate-cli/compare/0.18.5...0.20.0) (2026-11-05)

### ⚠ BREAKING CHANGES

- share the Repository Link across worktrees

### Features

- **apply:** offer to use or create a named delivery branch ([55a452d](https://github.com/uniqbit-ag/mate-cli/commit/55a452dadbffe940629387eb4bda51275d7c4a47))
- **delivery:** keep the ticket only in the branch name ([376220f](https://github.com/uniqbit-ag/mate-cli/commit/376220fa569220f6a2ee1109ca5e12db375063f3))
- share the Repository Link across worktrees ([4fcaee6](https://github.com/uniqbit-ag/mate-cli/commit/4fcaee6d09b494534316f844afeaa3aa1d7fb79a))
- **studio:** control-room redesign, instant views, non-blocking watch ([681aaf7](https://github.com/uniqbit-ag/mate-cli/commit/681aaf71c00c1a7e051b46316077b3365a18efef))
- **update:** update an installed Mate editor extension with mate update ([63dd6dd](https://github.com/uniqbit-ag/mate-cli/commit/63dd6dd5e0b787adb75775d46ce52eb08a6064a1))
- **vscode:** add Mate VS Code extension, session registry, and mate vscode setup ([40552b3](https://github.com/uniqbit-ag/mate-cli/commit/40552b34bdf9e4df876ffab0e98019476b7c4942))
- **vscode:** background sessions with session state and registry hooks ([8fad0e3](https://github.com/uniqbit-ag/mate-cli/commit/8fad0e351ee56872e3d2f094e2a011f8c2351f9c))
- **vscode:** gate sidebar on managed workspace and clarify groups ([593d5ac](https://github.com/uniqbit-ag/mate-cli/commit/593d5ac5684622efed452e45d422219694713ff2))

### Bug Fixes

- keep mate working worktree working after a linked worktree is removed ([67e1e44](https://github.com/uniqbit-ag/mate-cli/commit/67e1e4476f2203b706316d723ba0c3bd5d261f01))
- **tokensave:** do not route calls to the worktree the MCP server already serves ([56e0b7f](https://github.com/uniqbit-ag/mate-cli/commit/56e0b7f29deb02db50f3ed8c4784c363da0b5ca8))

## [1.0.0-canary.3](https://github.com/uniqbit-ag/mate-cli/compare/0.18.5...0.20.0) (2026-11-05)

### Bug Fixes

- resolve host OpenTUI runtime in installed OpenCode plugin ([374cafb](https://github.com/uniqbit-ag/mate-cli/commit/374cafb1a99604f851982b5351f3cd0390251774))

## [1.0.0-canary.2](https://github.com/uniqbit-ag/mate-cli/compare/0.18.5...0.20.0) (2026-11-05)

### Bug Fixes

- **studio:** unhash Start manifest chunk so mate-core packs reproducibly ([1b10680](https://github.com/uniqbit-ag/mate-cli/commit/1b10680a2d349035d87180bc69655d762885aff6))

## [1.0.0-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.18.5...0.20.0) (2026-11-05)

### ⚠ BREAKING CHANGES

- **companion:** name the workspace document after the repository
- **companion:** open workspace file and merge worktree detection settings
- detect merge state from local Git; drop gh auth token fallback
- **studio:** replace Studio roles with Engineering/Analysis modes
- add Companion Mentions plugin; ignore case in secret matching

### Features

- add Companion Mentions plugin; ignore case in secret matching ([062c8bd](https://github.com/uniqbit-ag/mate-cli/commit/062c8bd9e6b38e9564c2ae18fff4cbc1af16e1a6))
- add mate working worktree for parallel local Worksets ([105d7a9](https://github.com/uniqbit-ag/mate-cli/commit/105d7a9e5f1b182ffe4da62cd6734cb0306d5e0a))
- **claude:** deny SendFeedback to stop Claude feedback drafts in Mate sessions ([8916ebf](https://github.com/uniqbit-ag/mate-cli/commit/8916ebf03126230f179cc1dec6e59d628483baa0))
- **cli:** show phase progress in slow commands and plain tui banner ([facacf5](https://github.com/uniqbit-ag/mate-cli/commit/facacf57f65b90f44334eebebf459c2f1f1ac948))
- **companion:** name the workspace document after the repository ([f0e66dc](https://github.com/uniqbit-ag/mate-cli/commit/f0e66dcce5c2edcaa2d32e51657496ba34952b62))
- **companion:** open workspace file and merge worktree detection settings ([5a0b9a7](https://github.com/uniqbit-ag/mate-cli/commit/5a0b9a765dfe813dd049815e7b4061e652089b6c))
- **delivery:** record Jira tickets and resolve the Delivery Branch in one place ([67bb6b0](https://github.com/uniqbit-ag/mate-cli/commit/67bb6b04bc3d01fae4d2d4305d4e829b6bb2f4cd))
- detect merge state from local Git; drop gh auth token fallback ([0882840](https://github.com/uniqbit-ag/mate-cli/commit/08828409d6ca6244f467dcaa926c75925b187cf7))
- **install:** let each member opt into the tools a companion recommends ([d6a9b65](https://github.com/uniqbit-ag/mate-cli/commit/d6a9b654e0f8114fd1b52cd7d2c26fe350feeb90))
- let a second Mate leave the runtime directory alone ([8142a25](https://github.com/uniqbit-ag/mate-cli/commit/8142a255a6fbf05804c782ff24dbcb42ba7f43ac))
- load Companion Mentions in plain claude sessions ([bef4d05](https://github.com/uniqbit-ag/mate-cli/commit/bef4d05a937b809285fdca59acffa994f7346e79))
- move Studio to mate-studio app, extend factory runner and outcomes ([f1f8940](https://github.com/uniqbit-ag/mate-cli/commit/f1f8940b520fd8d6ca18d042ec50552a73c926ce))
- Next steps handoffs, stricter slicing test, compact apply ([5b504ed](https://github.com/uniqbit-ag/mate-cli/commit/5b504ed4619258ef7b1f323d595b733d4bde917c))
- **openspec:** tag tasks only with companion-installed skills ([1a2b618](https://github.com/uniqbit-ag/mate-cli/commit/1a2b6186d2009f9150d52f64ba82a8165541deb8))
- **publish:** retry transient remote failures and defer instead of failing ([c91229d](https://github.com/uniqbit-ag/mate-cli/commit/c91229d8abe1643d1c59a6c2b4b86a6929420fab))
- search the companion from any @ query; load a worktree's own plugin copy ([6fb81af](https://github.com/uniqbit-ag/mate-cli/commit/6fb81af867a78ebbe9793cd90cf2a0339d50efd0))
- **skills:** format skill handoffs for the current agent runtime ([ed49511](https://github.com/uniqbit-ag/mate-cli/commit/ed49511ba43c1265c728693bca30f645e8093fdd))
- **skills:** handoffs never offer optional commands ([fb460b5](https://github.com/uniqbit-ag/mate-cli/commit/fb460b5200559d50460613992962e7eb912b0f51))
- **skills:** keep Mate skill copies out of companion Git ([c8b605b](https://github.com/uniqbit-ag/mate-cli/commit/c8b605bbc99745cea6a5fda53d63649c6a08a132))
- software factory — factory image app, AFK runner, studio factory board, workset terminal and delivery branch ([a8dcd12](https://github.com/uniqbit-ag/mate-cli/commit/a8dcd12ba30749b8f5718c698b29e1e948bbd3f7))
- **studio:** hold view data, load views ahead and show navigation progress ([c890715](https://github.com/uniqbit-ag/mate-cli/commit/c8907152a88584e528cc80c8f975636e0a2ab753))
- **studio:** replace Studio roles with Engineering/Analysis modes ([f41b192](https://github.com/uniqbit-ag/mate-cli/commit/f41b192d2f29d78f5fbd8d0bcce3c3cf28bf49d1))
- **studio:** role switch, detached sidebar, and Business Analyst overview ([5d59e6b](https://github.com/uniqbit-ag/mate-cli/commit/5d59e6b439fa3051570cb037c88db2d46b55d742))
- **tokensave:** route code-graph calls to the session's worktree ([4ae5f23](https://github.com/uniqbit-ag/mate-cli/commit/4ae5f239273785db8ec3b85549247a602e24bd95))
- **tui:** render Ink screens as plain lines with a static log ([9b47236](https://github.com/uniqbit-ag/mate-cli/commit/9b472362b8c472db9a57bfaa6a2d5651389027b9))
- **worktree:** create worktrees for a change and offer them in apply ([666b63c](https://github.com/uniqbit-ag/mate-cli/commit/666b63c74e27d52adf3f642cabaa07d8ea7b6118))
- **worktree:** enter the change's worktree from the running session ([34540f5](https://github.com/uniqbit-ag/mate-cli/commit/34540f5f6ed189b77b97e57942010725a8441fd7))
- **worktree:** publish prunes the worktrees of a Workset it completes ([174db5f](https://github.com/uniqbit-ag/mate-cli/commit/174db5fc9ca79db6c634aa34aacd5ddc62debe30))

### Bug Fixes

- **bootstrap:** find a freshly installed Bun under ~/.bun/bin and explain setup without a TTY ([dea6703](https://github.com/uniqbit-ag/mate-cli/commit/dea6703da0e43bdc0fd98775f5f55102f9fdf820))
- close review findings in glob braces, secret folders and Mate lookups ([3ed5881](https://github.com/uniqbit-ag/mate-cli/commit/3ed588111bf7bd52c0bd8ed0745f8119726c3bcd))
- **graphify:** remove stale CLI hooks and stop counting Mate's wrapper as Graphify ([e43800d](https://github.com/uniqbit-ag/mate-cli/commit/e43800d6f7d43a57a9b76e612c52d8ab25e4e4d0))
- harden tokensave worktree routing and workset worktree setup ([7f28412](https://github.com/uniqbit-ag/mate-cli/commit/7f2841253212421da758f6b670a9141b311fb4ec))
- keep the openspec exclude line while another checkout's pointer is unreadable ([e09fb38](https://github.com/uniqbit-ag/mate-cli/commit/e09fb38074928dc489c058a5607184dd6baf8615))
- **mate-core:** pin the JSX runtime in every .tsx module ([b810b0c](https://github.com/uniqbit-ag/mate-cli/commit/b810b0c1e95900123bc8606edabc2041769c08aa))
- **mate-core:** skip prepack when packing in the Claude plugin packaging test ([cdaa0b8](https://github.com/uniqbit-ag/mate-cli/commit/cdaa0b8e15ba1f3fd43c794e0b59ef88a272634e))
- **opencode:** declare OpenTUI as an optional host-provided peer ([b8e9b48](https://github.com/uniqbit-ag/mate-cli/commit/b8e9b48b8dd684ec66a1514168cd3705f489776e))
- **opencode:** keep TUI staleness lines live when loaded from node_modules ([2980f13](https://github.com/uniqbit-ag/mate-cli/commit/2980f1323bc26604c97038af4c44ca4b280c050a))
- refuse search globs past the brace limit ([2f02569](https://github.com/uniqbit-ag/mate-cli/commit/2f02569a3e0e3f385558848e6e029e0d985fcf74))
- **setup:** install uv only for Graphify ([cff52c7](https://github.com/uniqbit-ag/mate-cli/commit/cff52c79d2e7ce009e2f87f29ceae3f3da62681d))
- **setup:** leave a recommended tool uninstalled once the member declined it ([08340fd](https://github.com/uniqbit-ag/mate-cli/commit/08340fdea6e7b87a2a8f0c7807057486f82ced92))
- **tokensave:** detect agent integration under CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME ([84a2ec9](https://github.com/uniqbit-ag/mate-cli/commit/84a2ec91897ee3159b2e74f4f456c2425e614e1f))
- write worktree exclude lines to the shared Git folder ([55dc153](https://github.com/uniqbit-ag/mate-cli/commit/55dc153e1d26818384967f14f967e8d3f80958e8))

### Reverts

- Revert "feat: let a second Mate leave the runtime directory alone" ([ab64fca](https://github.com/uniqbit-ag/mate-cli/commit/ab64fca6c14a1cd72dd9f1eb02686129549ad766))

## [1.0.0-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.18.5...0.20.0) (2026-10-29)

### ⚠ BREAKING CHANGES

- deliver changes through recorded branches and bundle OpenSpec
- add secret guardrails for agents, artifacts, and code indexes

### Features

- add local appliance test setup for mate-container ([b47a31c](https://github.com/uniqbit-ag/mate-cli/commit/b47a31ce81b190968caf9a9be5bab4a45266351f))
- add secret guardrails for agents, artifacts, and code indexes ([13c86c6](https://github.com/uniqbit-ag/mate-cli/commit/13c86c6dfc6c0b12dcc1dea12d216a5bda33b98f))
- adopt mate brand kit across docs, CLI, and TUI surfaces ([68de60e](https://github.com/uniqbit-ag/mate-cli/commit/68de60ec90ab1cb89c7842ac9f18c702ffd9df96))
- align report renderer and show-me skill with mate brand kit ([263e9dd](https://github.com/uniqbit-ag/mate-cli/commit/263e9dd7635c41aab70dfe93f829e13896c60079))
- block model Co-Authored-By trailers in agent commits ([8947a66](https://github.com/uniqbit-ag/mate-cli/commit/8947a66ab00701838c531d7fb2fd35b312ca422f))
- deliver changes through recorded branches and bundle OpenSpec ([4531d10](https://github.com/uniqbit-ag/mate-cli/commit/4531d101db4d4ad0a23f6cf6dec6369e518a687b))
- deliver companion instructions to Claude sessions and subagents ([ac966ba](https://github.com/uniqbit-ag/mate-cli/commit/ac966bad19650c687d82e6ee7c7b4c6c2df71eaf))
- disable plan mode, DesignSync and the Artifact tool in Mate-managed Claude sessions ([d9a1a9e](https://github.com/uniqbit-ag/mate-cli/commit/d9a1a9eb7b549f9732a5ac68ef10435251918448))
- let Capabilities ship Claude plugin directories ([2e59586](https://github.com/uniqbit-ag/mate-cli/commit/2e5958601c778e5014d321c734911a862193c747))
- link companion Claude commands into wrapped repositories ([a4adfe2](https://github.com/uniqbit-ag/mate-cli/commit/a4adfe21bf9e87c35aaaad3000f210ca8a702b53))
- move delta spec metadata into a `mate:delta` comment ([89ea037](https://github.com/uniqbit-ag/mate-cli/commit/89ea0378beb1933ad0b5add28e6af3d640a8f70d))
- open every Linked Companion in `mate companion open` ([680bc33](https://github.com/uniqbit-ag/mate-cli/commit/680bc33a92ac4335299e4727eaf93838b70b37a2))
- publish Capability Claude plugins to plain claude sessions via wrap ([cfeb860](https://github.com/uniqbit-ag/mate-cli/commit/cfeb860285e043ecc1cd0cc64ebb6769a4225f06))
- regenerate OpenSpec output only on companion setup and update ([b0c128f](https://github.com/uniqbit-ag/mate-cli/commit/b0c128f039b1d6b135357bc1cbe122b62876a305))
- render vault markdown with read/edit modes and in-place navigation ([dd91c34](https://github.com/uniqbit-ag/mate-cli/commit/dd91c345235d3716defd8d37aaf2f7cbb6a9313c))
- share brand palette between Studio and reports with scheme override ([1bf58eb](https://github.com/uniqbit-ag/mate-cli/commit/1bf58ebcef6a1455ea9f1620bbd33920ad9ea8d4))
- show-me draws behaviour changes as a resulting flowchart first ([072c512](https://github.com/uniqbit-ag/mate-cli/commit/072c512ddc01d396132fc1c5f033588a8c9c5a69))

### Bug Fixes

- deliver companion instructions through one hook channel for Claude ([a410fb2](https://github.com/uniqbit-ag/mate-cli/commit/a410fb257f3d77c9b966be3e02a8a02474362c62))
- drop unmatched Claude Write secret deny rules ([63e2f4c](https://github.com/uniqbit-ag/mate-cli/commit/63e2f4c4fb7eb29c7d13489979fe1c81457ce0ce))
- keep a section whole when the companion block sits inside it ([d6da0e7](https://github.com/uniqbit-ag/mate-cli/commit/d6da0e7648282029ced62bf742670cf9714a2adf))
- keep Capabilities from loading or shadowing Mate's own Claude plugin ([f44219c](https://github.com/uniqbit-ag/mate-cli/commit/f44219c5a09cacee840602a07de07f1d7fddf002))
- keep mate-simplify-code refactors behaviour-safe ([b6777d6](https://github.com/uniqbit-ag/mate-cli/commit/b6777d6fac04fb5b5b1d4fda86a1d65e64ed8d84))
- repair docs build and studio e2e assertions ([c7c1b17](https://github.com/uniqbit-ag/mate-cli/commit/c7c1b170861356818870b21e87b004d0c30df781))
- resolve artifact guard targets against repo root and skip heredoc bodies ([167dca9](https://github.com/uniqbit-ag/mate-cli/commit/167dca96f844d7ed07773ca28be836e0cc740ea6))
- stop `mate plugin install` from declaring flags as packages ([374b58a](https://github.com/uniqbit-ag/mate-cli/commit/374b58a10c6d05ba0381261624974689665ef286))
- surface npm install errors instead of silencing them ([5ae0009](https://github.com/uniqbit-ag/mate-cli/commit/5ae0009249701e6f2477dbe26023435089dbc620))
- tighten companion instruction trimming, scanning and writes ([30ff0c6](https://github.com/uniqbit-ag/mate-cli/commit/30ff0c6dbb7896468e0fb9b25168b3229a920324))

## [0.18.5](https://github.com/uniqbit-ag/mate-cli/compare/0.18.4...0.18.5) (2026-10-14)

### Bug Fixes

- keep Mate's spec frontmatter conventions in OpenSpec's config hooks ([4f715a5](https://github.com/uniqbit-ag/mate-cli/commit/4f715a5a27192188fb494dc9e16f326dd9d8c38b))
- keep reading companions that Mate 0.18.4 saved in the audiences.base shape ([5eb6653](https://github.com/uniqbit-ag/mate-cli/commit/5eb6653badf413c5fa108dc470336fb68cbb27a4))

### Reverts

- Revert "feat: isolate audience contributions across agent sessions" ([58cab2d](https://github.com/uniqbit-ag/mate-cli/commit/58cab2dc050fd12539dad7de98d7990d8c2960c1))

## [0.18.4](https://github.com/uniqbit-ag/mate-cli/compare/0.18.3...0.18.4) (2026-10-14)

### Features

- isolate audience contributions across agent sessions ([804a663](https://github.com/uniqbit-ag/mate-cli/commit/804a663acdd2454fce70c187d98e16508cf09312))
- project an OpenSpec store pointer into wrapped working repositories ([ebe64eb](https://github.com/uniqbit-ag/mate-cli/commit/ebe64eb8d0c3ec58f4c70f948f5a29dc97865b8c))

### Bug Fixes

- **container:** run the smoke-test version check under a scratch HOME ([f835192](https://github.com/uniqbit-ag/mate-cli/commit/f83519209f535a304cd001b5bbc14008eac87312))
- **opencode:** stop shared service sessions inheriting launch environment ([5975bdc](https://github.com/uniqbit-ag/mate-cli/commit/5975bdc637a43d9ac2e052506c7db668bfcde076))

## Unreleased

### Bug Fixes

- **opencode:** a bare `opencode` session no longer picks up another session's
  repository from the shared OpenCode background service, and no longer fails
  with `missing MATE_GUIDANCE_JSON in the launch environment`. The plugin now
  trusts its process environment only for a launch `mate opencode` started,
  and resolves everything else from the Projection Root. `mate opencode`
  injects the guidance payload only into launches that host their own server.

### Upgrade note

- **Restart the OpenCode background service once after upgrading.** The
  service keeps the plugin code it loaded at startup, so the fix takes effect
  only after it restarts: stop `opencode serve --service` (for example
  `pkill -f "opencode serve --service"`); the next `opencode` starts a fresh
  one. No further restarts are needed.

## [0.18.3](https://github.com/uniqbit-ag/mate-cli/compare/0.18.2...0.18.3) (2026-10-13)

### Features

- **claude:** wrap repo on mate claude launch and prepare plain sessions ([e8ab50c](https://github.com/uniqbit-ag/mate-cli/commit/e8ab50c9391c7c7f519164aa2884580dab0b9ea3))
- **container:** persist appliance agent logins on a home volume ([9d9f11b](https://github.com/uniqbit-ag/mate-cli/commit/9d9f11bfdbe70a901d87858475b4c094e01fcdd0))
- **openspec:** backfill writes canonical specs, expand untracked dirs ([d961285](https://github.com/uniqbit-ag/mate-cli/commit/d9612854a9514e607e2bf2f5eca7ad7bbdb16149))

### Bug Fixes

- **opencode:** wrap repo for OpenCode instead of overriding config dir ([3cf47aa](https://github.com/uniqbit-ag/mate-cli/commit/3cf47aa9a58db98510eb04650faff7be45d9ac7c))

## [0.18.3-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.18.2...0.18.3) (2026-10-12)

### Features

- **audiences:** let an audience declare plugin-provided capabilities ([9b4acc5](https://github.com/uniqbit-ag/mate-cli/commit/9b4acc55cefac67cf4380a69c4a672aa0948696a))

## [0.18.3-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.18.2...0.18.3) (2026-10-12)

### Features

- add companion audiences ([9b93c1b](https://github.com/uniqbit-ag/mate-cli/commit/9b93c1bfb0e0a990dd770aa62f35f38737862526))

## [0.18.2](https://github.com/uniqbit-ag/mate-cli/compare/0.18.1...0.18.2) (2026-10-08)

### Bug Fixes

- **container:** bump appliance pins, install OpenCode 2.x from npm ([acba211](https://github.com/uniqbit-ag/mate-cli/commit/acba21151dfe23d8e7cc11c87d5e2f3942d304fe))

## [0.18.1](https://github.com/uniqbit-ag/mate-cli/compare/0.18.0...0.18.1) (2026-10-08)

## [0.18.1-canary.5](https://github.com/uniqbit-ag/mate-cli/compare/0.18.0...0.18.1) (2026-10-08)

### Features

- **studio:** host agent-published reports in Studio ([ca763cb](https://github.com/uniqbit-ag/mate-cli/commit/ca763cb7c3b474122b0c195005dd226da3897309))
- **studio:** launch skill actions from the Specs view ([a1e8589](https://github.com/uniqbit-ag/mate-cli/commit/a1e8589dbd37a94fd3ac6d8a714fa7350d70b166))
- **studio:** use a copy icon button for spec prompts ([2513609](https://github.com/uniqbit-ag/mate-cli/commit/25136098f6aa11575269b8d83eef23d0a65cc097))

### Bug Fixes

- **studio:** keep the vault tree cost independent of repository size ([a03d37e](https://github.com/uniqbit-ag/mate-cli/commit/a03d37e9344594a497fdf7600c9b2ced9bc6682e))

## [0.18.1-canary.4](https://github.com/uniqbit-ag/mate-cli/compare/0.18.0...0.18.1) (2026-10-07)

## [0.18.1-canary.3](https://github.com/uniqbit-ag/mate-cli/compare/0.18.0...0.18.1) (2026-10-07)

### ⚠ BREAKING CHANGES

- **container:** appliance plugin allowlists are removed.

### Features

- **container:** accept capabilities provided by verified allowlisted plugins ([eee76ed](https://github.com/uniqbit-ag/mate-cli/commit/eee76edd03ea6273ebff154b1851f31ee3b9e50b))
- **container:** generate plugin files into the checkout at startup instead of checking drift ([f0effa2](https://github.com/uniqbit-ag/mate-cli/commit/f0effa23743977d0c31a8d69acb0ba30b097f9f9))
- **container:** restore companion plugins at startup, drop the plugin allowlist ([09b17b0](https://github.com/uniqbit-ag/mate-cli/commit/09b17b0417e3f85e4209f9cb59627b9889dfe866))
- **container:** warn on plugin-generated file drift instead of refusing to start ([0293bfa](https://github.com/uniqbit-ag/mate-cli/commit/0293bfa5793900ec5b8bc5a5c570bed4b00c1706))
- **studio:** apply a companion-configured default agent to terminal sessions ([257d208](https://github.com/uniqbit-ag/mate-cli/commit/257d20810f28c757871b60345fb4d32f69ef5145))

### Bug Fixes

- **container:** redact both startup tokens on every child error path ([c9b57a8](https://github.com/uniqbit-ag/mate-cli/commit/c9b57a813a80fb38ada8a36b63db147694f21b44))

## [0.18.1-canary.2](https://github.com/uniqbit-ag/mate-cli/compare/0.18.0...0.18.1) (2026-10-07)

### ⚠ BREAKING CHANGES

- `mate plugin verify` removed (use `mate doctor`); deprecated `mate launch <agent>` alias and top-level `hub` gate removed.

### Features

- adjusted git architecture flow ([ac02df2](https://github.com/uniqbit-ag/mate-cli/commit/ac02df255a783cde952ea9cb0c9aa46172ad8b1b))
- extract image-pins module, idea placeholder for pre-explore steps ([6705bb8](https://github.com/uniqbit-ag/mate-cli/commit/6705bb8e81e80da83f403f0410c419da3a4d6857))

### Code Refactoring

- fold plugin verify into doctor, drop launch alias ([4615be0](https://github.com/uniqbit-ag/mate-cli/commit/4615be0bec3eabe4222b190262f80f6f183a148f))

## [0.18.1-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.18.0...0.18.1) (2026-10-06)

### ⚠ BREAKING CHANGES

- local releases no longer publish to npm.

### Features

- prefer SSH for HTTPS companion remotes with HTTPS fallback ([8859f52](https://github.com/uniqbit-ag/mate-cli/commit/8859f52e1886bf47d684a7d55605ef09352a2492))
- publish signed releases from CI with npm provenance ([bfacd61](https://github.com/uniqbit-ag/mate-cli/commit/bfacd61edd6fb9be56dc1df15b3eaa09f8bfea5e))

## [0.18.0](https://github.com/uniqbit-ag/mate-cli/compare/0.17.1...0.18.0) (2026-10-06)

### Bug Fixes

- commit Mate-managed skills on companion update and warn on overwritten edits ([d7e3a07](https://github.com/uniqbit-ag/mate-cli/commit/d7e3a0794954b189d7be25a18ffc2a37407ab387))

## [0.18.0-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.17.1...0.18.0) (2026-10-06)

### Features

- install OpenCode skills into shared .agents/skills root ([4d1b159](https://github.com/uniqbit-ag/mate-cli/commit/4d1b159ab007186bdf0ad939749bdbbeebfba451))
- refresh satisfied install requirements and move skill credits to metadata ([d0692f6](https://github.com/uniqbit-ag/mate-cli/commit/d0692f65d3433d0c420fd3a8d739f83d2b5f9687))

### Bug Fixes

- **release:** hash packed tarball instead of parsing npm pack --json ([356486d](https://github.com/uniqbit-ag/mate-cli/commit/356486d45e9ef5ebd7191d5fad0b686a1a709aed))

## [0.17.1](https://github.com/uniqbit-ag/mate-cli/compare/0.17.0...0.17.1) (2026-10-06)

## [0.17.0](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-10-06)

### Bug Fixes

- block publish when packed tarballs differ from image lock pins ([41a48bb](https://github.com/uniqbit-ag/mate-cli/commit/41a48bb2c99bfabcd27aafa7b4b7fa31f75fef5d))
- gitignore OpenCode service state when opencode is enabled ([3546274](https://github.com/uniqbit-ag/mate-cli/commit/35462743014f4c2e52df51d6eb8989a0bea7c91c))
- integrate TokenSave with agent runtimes at image build time ([f3d9777](https://github.com/uniqbit-ag/mate-cli/commit/f3d9777a9f038e66781901e5a12b816521e8c9c0))
- launch OpenCode standalone so companion config reaches it ([7f146d3](https://github.com/uniqbit-ag/mate-cli/commit/7f146d3379cbc55254b7a55309fe4e3cea15a981))
- resolve OpenCode guidance from session directory; deflake tests ([a286afb](https://github.com/uniqbit-ag/mate-cli/commit/a286afbc36b026229bd8cb225fde0726536a2b96))
- stop mate cap index from killing running tokensave MCP servers ([cd72156](https://github.com/uniqbit-ag/mate-cli/commit/cd721567207fc60a144f10177be99ba69c671df4))

## [0.17.0-canary.14](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-10-05)

### Bug Fixes

- compare prerelease engine versions to release ranges ([47682be](https://github.com/uniqbit-ag/mate-cli/commit/47682be04e9c3d08486639e61790609e4b401060))

## [0.17.0-canary.13](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-10-05)

## [0.17.0-canary.12](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-10-05)

### Features

- add companion update command, drop container bundle test ([fcb645e](https://github.com/uniqbit-ag/mate-cli/commit/fcb645e134372c030972105eb0e386301bd208f6))
- add opencode plugin root entries for path-bound loading, raise tool output limits ([7f5f2e9](https://github.com/uniqbit-ag/mate-cli/commit/7f5f2e92c6b3cd7eb61a7e6a8c4e4c141866ad3e))
- **container:** verify and freeze dynamic plugins at startup ([d0a8f85](https://github.com/uniqbit-ag/mate-cli/commit/d0a8f85ec1c18a3e67fc4e3c86eab551413e515b))
- migrate opencode integration to @opencode/plugin v2 ([dac8cad](https://github.com/uniqbit-ag/mate-cli/commit/dac8cad3934cd198a9d284b88a63a1e389122a9a))
- smaller fixes, test adjustments ([7b3c558](https://github.com/uniqbit-ag/mate-cli/commit/7b3c5588cebb2cde6116cd13d5e65c72ef83d089))
- **studio:** dock the agent terminal as a right sidebar ([ec93835](https://github.com/uniqbit-ag/mate-cli/commit/ec9383586809cf95850a8c1678b71713977bf4fb))
- **studio:** list the vault fast and own every URL parameter in one module ([b7b1462](https://github.com/uniqbit-ag/mate-cli/commit/b7b14622fae67139efa1498c4ddb8162d4afcc55))
- upgraded opencode to plugin v2 ([c0eaa32](https://github.com/uniqbit-ag/mate-cli/commit/c0eaa325a5b026f7126b5c05c64cf097d6476587))

### Bug Fixes

- let companion update commit pre-dirty OpenSpec skills and commands ([99478ed](https://github.com/uniqbit-ag/mate-cli/commit/99478edc22a8d84be500a17e74cac9d58c26dffb))

## [0.17.0-canary.11](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-25)

### Features

- **studio:** add agent terminal and access token; serve Studio alone in the appliance ([a4980f4](https://github.com/uniqbit-ag/mate-cli/commit/a4980f4000b05851cfada91af33d01a20c6a181e))

### Bug Fixes

- **container:** wait for published packages before building the image ([9b5e927](https://github.com/uniqbit-ag/mate-cli/commit/9b5e92716e8f6c17f759256027cd34f14ca2dfb7))

## [0.17.0-canary.10](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-25)

### Bug Fixes

- added baseline for auto update fix ([fd13883](https://github.com/uniqbit-ag/mate-cli/commit/fd1388327667cbc495318dda283a9adcaa848e2b))

## [0.17.0-canary.9](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-24)

### Features

- **container:** register the preinstalled Context7 server ([11fc2e8](https://github.com/uniqbit-ag/mate-cli/commit/11fc2e8b836347a2430010e4b0775eb07f4e5c8a))

## [0.17.0-canary.8](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-24)

### Features

- **cli:** make launches prompt-free and use npx for Context7 ([a44b0b0](https://github.com/uniqbit-ag/mate-cli/commit/a44b0b03af133996761808cd4316e9a6be78ac6f))

## [0.17.0-canary.7](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-23)

### Features

- **cli:** register context7 as the installed context7-mcp server ([6eb2784](https://github.com/uniqbit-ag/mate-cli/commit/6eb2784589c4bd861414023ce2c116127f00ab1f))
- **container:** carry the SSH client and the Context7 server ([eec3c67](https://github.com/uniqbit-ag/mate-cli/commit/eec3c678186465ad278b4b3398d26ea8327aa65e))

### Bug Fixes

- **container:** start the session with --no-git unless Git sync is configured ([79e8e6d](https://github.com/uniqbit-ag/mate-cli/commit/79e8e6d9e91917206be6518574078f4a33389b8f))
- **studio:** make the vault editor read-only without --writable ([b9c9f66](https://github.com/uniqbit-ag/mate-cli/commit/b9c9f66d89797ede567ddecf7eabb2756018e3a9))

## [0.17.0-canary.6](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-22)

### Bug Fixes

- **core:** accept a plugin bound to a preinstalled copy at launch ([a9098eb](https://github.com/uniqbit-ag/mate-cli/commit/a9098ebfec5ef75c9224243c76b74c3ebbe2718e))

## [0.17.0-canary.5](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-22)

### Features

- **container:** add the Mate appliance image ([3da21a3](https://github.com/uniqbit-ag/mate-cli/commit/3da21a38112f1ba4d8dc85e36fde46a970a8cf2b))

### Bug Fixes

- **container:** prepare image locks before npm publish ([02bdfce](https://github.com/uniqbit-ag/mate-cli/commit/02bdfce9057959b4a7e2e086e46c6e46fe86533a))
- **core:** let a pinned deployment reach a session ([63668b4](https://github.com/uniqbit-ag/mate-cli/commit/63668b4546e8b96f01d7346a61f5c00f64b13614))

## [0.17.0-canary.3](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-22)

### Bug Fixes

- **core:** skip engines.node enforcement where no Node backs the runtime ([9281b5e](https://github.com/uniqbit-ag/mate-cli/commit/9281b5ee41aa5c596deb7a24f564f14e30fdad32))

## [0.17.0-canary.2](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-21)

## [0.17.0-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-21)

## [0.17.0-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.16.0...0.17.0) (2026-09-21)

### Features

- add companion launches and studio vault ([d33b8c6](https://github.com/uniqbit-ag/mate-cli/commit/d33b8c67b0fd9be68891022efc7016bdd42e88f7))
- add unattended deployment CLI ([5c76e08](https://github.com/uniqbit-ag/mate-cli/commit/5c76e08aa8954b431931c7b0369899cae6915521))

## Unreleased

### ⚠ BREAKING CHANGES

- **A managed launch now reports the agent's outcome as its own exit status.**
  `mate claude` and `mate opencode` previously printed the agent's result and
  exited zero regardless of how the agent ended. They now exit zero only when
  the agent exited zero. The JSON result is still printed, but it no longer
  stands in for the status. A caller that read success from a zero exit will
  now see agent failures.
- **A managed launch now forwards `SIGINT` and `SIGTERM` to the agent** and
  waits for that process to exit before exiting itself, so no agent is left
  running behind it. An agent that ends on a forwarded signal is reported as
  the signalled stop it was (`128 + signal`), which a caller can tell apart
  from an ordinary non-zero exit. At a terminal this is unchanged in practice:
  Ctrl-C reaches the whole foreground process group, so the agent is stopped
  once and the shell is returned.

Both apply to every launch on a default workstation; neither has an opt-out.
They are separate from the opt-in `MATE_UPDATE_POLICY=pinned` policy, which
changes only automatic update handling and which a workstation should not set.

### Features

- `mate companion register [path]` registers an already-configured Companion
  Repository without presenting a selection and without changing its
  configuration.
- `mate companion prepare --from <bundle> [path]` prepares a companion's
  machine-local dependency workspace by validating and copying a fully
  installed prebuilt bundle — no package manager, dependency resolution,
  download, or installation script.
- `MATE_UPDATE_POLICY=pinned` declares that an installation's version is fixed
  by the artifact it was built into: no update enforcement, banner, background
  registry check, or update-state read or write. Opt-in; absent the setting
  nothing changes.
- A declared Agent Runtime plugin reference is bound to a preinstalled package
  where the distribution supplies one, so the runtime loads installed files
  instead of resolving or downloading the published reference.

## [0.16.0](https://github.com/uniqbit-ag/mate-cli/compare/0.15.5...0.16.0) (2026-09-15)

## [0.16.0-canary.1](https://github.com/uniqbit-ag/mate-cli/compare/0.15.5...0.16.0) (2026-09-15)

### Bug Fixes

- make update checks channel-aware ([7c5af5a](https://github.com/uniqbit-ag/mate-cli/commit/7c5af5a216162d79b684170a7a2a64ea875b10ee))
- update Tokensave setup posture ([dfa0065](https://github.com/uniqbit-ag/mate-cli/commit/dfa0065fef97308ede2857ac9325283436ff3757))

## [0.16.0-canary.0](https://github.com/uniqbit-ag/mate-cli/compare/0.15.5...0.16.0) (2026-09-14)

### ⚠ BREAKING CHANGES

- remove the Headroom capability and proxied launches

### Features

- add artifact publish workflow ([c409b70](https://github.com/uniqbit-ag/mate-cli/commit/c409b70cdab80d3eed048516579cae955bd6e0ef))
- add companion git synchronization ([dce3366](https://github.com/uniqbit-ag/mate-cli/commit/dce33669f437a0ce621b826273eac639ec94a2f8))
- add companion skills and workflow transcript ([17d098c](https://github.com/uniqbit-ag/mate-cli/commit/17d098cb9c177cef5696237a41a57b0fd4ba8f37))
- add shared mate-skills library and mate-minimal schema ([63ec798](https://github.com/uniqbit-ag/mate-cli/commit/63ec798fb15ab346572f0a990f8f4d59b40622a0))
- add Studio skills inventory view ([0f80623](https://github.com/uniqbit-ag/mate-cli/commit/0f806236aca7866b84a86e704af6ab3b5887d2ab))
- add the mate studio local page ([719c5ae](https://github.com/uniqbit-ag/mate-cli/commit/719c5ae0541577394c04a40458cce25f4d374326))
- auto-repair recoverable install state ([6fe572e](https://github.com/uniqbit-ag/mate-cli/commit/6fe572e2dedc70e875d70e6043bbfe4958917f40))
- deliver companion guidance to unmanaged sessions ([77c580d](https://github.com/uniqbit-ag/mate-cli/commit/77c580dfb5b25069749f6c9a7b6d6090e4e605af))
- expand artifact workflows and companion guidance ([cfac2a3](https://github.com/uniqbit-ag/mate-cli/commit/cfac2a3755a4b049d9eae2d2cd58706bf999bca5))
- expand companion workflows and reports ([245b760](https://github.com/uniqbit-ag/mate-cli/commit/245b76039d2eb1b952be8b051f3f07bb0ccd06e5))
- keep wrap and the managed launches apart ([7ef4cfc](https://github.com/uniqbit-ag/mate-cli/commit/7ef4cfc9b418cb4790aed067988797f8db5b8e8e))
- mate wrap ([21776d4](https://github.com/uniqbit-ag/mate-cli/commit/21776d4f2cf136cbc5ef446401b1fcf628baafea))
- publish archived artifacts by anchor ([24aad02](https://github.com/uniqbit-ag/mate-cli/commit/24aad027fad9a684d33e498e8c9786d6a8d76ab0))
- publish archived artifacts by anchor ([2277767](https://github.com/uniqbit-ag/mate-cli/commit/2277767996e439c73180e3ce2af2ce2a95376dc5))
- remove the Headroom capability and proxied launches ([2410af0](https://github.com/uniqbit-ag/mate-cli/commit/2410af05c96ff216d0e791cec759686319d42af0))

### Bug Fixes

- auto-upgrade outdated OpenSpec installations ([d08fd8c](https://github.com/uniqbit-ag/mate-cli/commit/d08fd8c2d3d6f345a154865d8b4722210ec65b0d))
- remove projected Claude skills on unwrap ([6447e39](https://github.com/uniqbit-ag/mate-cli/commit/6447e3928d37f903403af07032d8a04b53d73a17))
- state the launch refusal's ordering precisely ([12e9a6d](https://github.com/uniqbit-ag/mate-cli/commit/12e9a6d02d7b37630159cbe5212aa7426995b4cd))
- support interactive Git during launch ([094ec47](https://github.com/uniqbit-ag/mate-cli/commit/094ec4782b032928189769dfb99e34efed330516))

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
