# Changelog

## Unreleased

### Capabilities can ship Claude plugins

- A Capability, built-in or dynamic, can declare Claude Code plugin folders as `pluginDirectories: [{ path }]` under its `claude` Runtime Contribution. `mate claude` passes each enabled folder as `--plugin-dir`, after Mate's own plugin.
- Plain `claude` sessions in a wrapped repository load these plugins too, as long as Claude Code trusts the folder. Each folder is published as its own local marketplace through `.claude-plugin/marketplace.json`. Mate reuses a marketplace file the plugin's author ships if it lists the plugin; context-mode ships one. Otherwise Mate writes its own, named `mate-plugin-<plugin>`, and removes it when the Capability is disabled. Mate never changes a marketplace file it did not write.
- The Claude wrap enables each published folder in `.claude/settings.local.json` (`extraKnownMarketplaces` and `enabledPlugins`), keeps entries you added there, and `mate unwrap` withdraws Mate's. In a wrapped repository, `mate claude` leaves those folders to the wrap, so each plugin loads once.
- Some folders are not published, and load only through `mate claude`:
  - a folder whose marketplace file Mate did not write and that does not list the plugin;
  - a folder whose plugin name cannot form a marketplace name;
  - a folder whose marketplace name your Claude Code configuration already uses with another source, for example context-mode added from GitHub. Mate skips it rather than redirect your marketplace.
- Claude Code records the plugins in `~/.claude/plugins/`, and those records stay after `mate unwrap`. Once the plugin is no longer enabled, they have no effect.
- Each launch checks the folders it gathers. A folder that is not an absolute path, or holds no `.claude-plugin/plugin.json`, is left out, and the session still starts. A folder declared twice, even with a trailing separator or through a symlink, is passed once. A folder that is Mate's own bundled plugin, or whose manifest uses Mate's plugin name (`mate-claude-plugin`), is left out with a warning, so a Capability can neither load Mate's plugin twice nor replace its guardrail hooks. Only `mate claude` warns about it; `mate opencode` cannot load the folder, so it stays silent.
- `mate wrap` names each Claude plugin folder it could not publish, and why, replacing the context-mode-only note. `mate doctor` lists the contributed Claude plugins, in text and `--json`:
  - whether each folder can load: present, missing its plugin manifest, not an absolute path, Mate's bundled plugin, or using Mate's plugin name;
  - for plain sessions, the marketplace that publishes it, or why it is not published (`marketplace` and `unpublishedReason` in `--json`).

  When a Capability's contributions fail to load, doctor names the Capability and the error, still reports everything else, and exits non-zero.
- context-mode uses the new contribution, so it now loads in plain `claude` sessions of wrapped repositories too. A companion-scoped `mate claude` passes the same two `--plugin-dir` flags in the same order. In a wrapped repository, `mate claude` passes only Mate's own plugin flag, and the wrap loads context-mode. A missing or broken package still fails `mate claude` before Claude starts. Its Claude package check moved from the Claude adapter into context-mode's own launch preflight, which skips plain sessions. A missing package now names the expected version instead of a bare "no such file" error.
- Capability preflight hooks receive the kind of session being prepared (`sessionKind`). `RuntimeContributions`, `RuntimeContributionsByRuntime`, `PluginDirectoryContribution` and `SessionKind` are exported as types for dynamic plugin authors.

### Companion Mentions plugin

- New optional package `@uniqbit/mate-plugin-companion-mentions`, published with Mate at the same version and installed separately (see its README). In a session started with `mate claude`, Claude's `@` menu lists Companion Repository files as `@mate:<path>` rows, and a sent `@mate:<path>` mention attaches the file, line ranges included, or a list of a folder's entries. A session inside the companion gets no rows, since Claude already lists those files, but typed mentions still attach. It needs Claude Code 2.1.292 or later and is the first external user of Capability Claude plugin folders.
- It keeps secret files out of its rows, mentions and folder lists with the companion's secret policy, checking both the path named and where a link leads. `MATE_POLICY_JSON` now carries that policy as compiled rules (`secrets: { guardrails, deny, allow }`) beside `allowedAgents`, read when the session starts, in every runtime and in the projection fallback. Without it, as with an older Mate, the plugin offers no rows and attaches nothing.
- The release now has publish-only packages: the plugin is published after core and the CLI, at the same version, and is not pinned in the container image's locks. A stable release runs the plugin's tests before it starts.

### Secret-file matching ignores letter case (breaking)

- Every guardrail layer that tests a path or a search glob now matches deny and allow patterns whatever their letter case, on every platform. `.ENV`, `ID_RSA` and `Prod.KEY` are secret files, and `.ENV.EXAMPLE` stays allowed. Before, `.ENV` passed every layer on macOS and Windows, where it names the same file as `.env`. A companion that relies on a differently-cased file not being a secret adds an allow pattern.
- `**` in a pattern now also crosses folder names that hold a line break.
- Pattern text that Mate writes into other tools is unchanged: the projected Claude and OpenCode deny rules, `.graphifyignore`, Graphify's `--exclude` and TokenSave's config. Those tools keep their own case rules, and Mate's own checks catch what they miss.
- `@uniqbit/mate-core/runtime` exports the one rule compiler (`secretRule`, `secretRules`), `isSecretFile` and `policyDocument`, so code outside mate-core evaluates the same rules.

### Secret guardrails (breaking)

- Agents in Mate-managed sessions can no longer read, write, or edit secret files (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `.pgpass`, `.npmrc`), and shell commands that name one are blocked, as are Grep searches inside a secret file or with a glob aimed at secret files (such as `.env*`). `.env.example`, `.env.sample`, `.env.template`, and `.env.dist` stay readable. The Claude hook and the OpenCode middleware enforce this, and Mate's managed deny rules back it up.
- Content an agent writes into the Companion Repository is scanned with secretlint's recommended preset and blocked when it contains a secret.
- `mate artifact publish` scans the files it would commit and stops at a new `secret-scan` step when it finds a secret. `--json` results carry `secretFindings` (path, line, rule id; never the value).
- TokenSave's exclude list keeps secret files out of its index. Every Graphify extraction, including ones agents run through the `graphify` wrapper, leaves secret files out through a Mate-managed `.graphifyignore` region and `--exclude` arguments; any secret that still reaches the output is removed from it, and the rest of the graph is kept. A secret never stops Graphify.
- Agents get a new `secret-handling` rule in the companion guidance.
- Configure it in the companion's `framework.yaml` under `secrets` (`guardrails`, `deny`, `allow`). `secrets: { guardrails: false }` turns it all off. See the Secret Guardrails page in the docs.

### OpenSpec output regenerates only on `mate companion setup` and `mate companion update`

- **Behavior change:** launches no longer upgrade the `openspec` CLI to `@latest` or run `openspec config reset`, `openspec init --force`, and `openspec update --force`. Those commands rewrote the committed `openspec-*` skills and `/opsx` commands in the background, so teammates on different CLI versions kept overwriting each other's files. A new OpenSpec release now reaches a companion only when someone runs `mate companion update` (or `mate companion setup`) and commits the result.
- A launch reads the `metadata.generatedBy` version from the companion's committed OpenSpec skills. When the installed `openspec` is older, Mate runs `npm install -g @fission-ai/openspec@<version>`, so every developer catches up to the version the last companion update generated with. A newer installed CLI is never downgraded, and pinned deployments skip the install. A failed install prints a warning with the manual command, and the launch continues.
- Launches still deploy Mate-owned skills and sync Mate schemas and the `config.yaml` rule.
- A runtime added by editing `framework.yaml` by hand gets its OpenSpec skills on the next `mate companion setup` or `mate companion update`.
- Every OpenSpec process Mate starts, including the `openspec` wrapper agents call, runs with `OPENSPEC_TELEMETRY=0` and `OPENSPEC_NO_UPDATE_CHECK=1`. OpenSpec's "update available" hint was wrong advice inside Mate, which decides the version.

### Delta specs pass `openspec validate --strict` on OpenSpec 1.14.2

- OpenSpec 1.14.2 reports any text above a delta spec's first `## ` section, which made every Mate change fail `openspec validate --strict`. Delta specs now carry their metadata (`change`, `capability`, and paired `scopes`) in a leading `<!-- mate:delta … -->` comment instead of YAML frontmatter, and the `mate-v1` instruction no longer asks for `← [[proposal]]` or `Applies to:` lines. The comment drops the delta `type` and `tags`.
- The `mate-v1` (version 10) and `mate-minimal` (version 4) delta templates, their `specs` instructions, `openspec/mate-conventions.yaml`, and Mate's `rules.specs` entry describe the comment. Existing companions pick them up on their next capability sync.
- `mate artifact publish` reads a delta's `scopes` from the comment, and still from frontmatter, so deltas in changes written before this release still publish. A `mate:delta` comment copied onto a main spec is replaced with canonical frontmatter, as a copied delta frontmatter block already was.

### TokenSave indexing heals an empty store

- `mate cap index`, and the indexing step of managed launches, now runs `tokensave init` whenever the Working Repository has no `.tokensave/tokensave.db`. Before, an empty or half-created `.tokensave/` folder counted as initialized, so every launch ran `tokensave sync` and failed with "no TokenSave index found".

### OpenSpec names the Working Repository as an edit root

- Mate registers the Companion Repository as an OpenSpec store and projects a store pointer (`openspec/config.yaml`) into each wrapped Working Repository. The pointer's `openspec/` folder is hidden from Git through `.git/info/exclude` (`/openspec/`), since all planning, including archived changes and canonical specs, lives in the companion's store. An earlier `/openspec/config.yaml` line is replaced on the next refresh. Run from inside the repository, `openspec status` now reports `actionContext.allowedEditRoots` as `[<working repo>, <companion>]` instead of the companion alone, so apply flows no longer refuse product-code edits.
- Existing repositories heal on their next `mate claude`, `mate opencode`, `mate wrap`, or other Mate command that refreshes the projection.
- Wrap-only users who never launch through Mate run `mate wrap` once. Until then, the `openspec` wrapper prints a one-line hint on stderr and keeps working as before.
- `.openspec-store/` is added to the companion's managed `.gitignore`. It holds the machine-local store id.
- The pointer is never written when the Working Repository has its own OpenSpec root (`openspec/specs/`, `openspec/changes/`, or its own `openspec/config.yaml`), or when its `.gitignore` re-includes the `openspec/` folder. In each case `mate wrap` prints a warning.
- `mate wrap` and managed launches now print a warning for every projection entry that fails without failing the operation. Before, these failures were dropped silently.
