# Changelog

## Unreleased

### Changes are delivered through recorded branches (breaking)

- **Renamed skills:** `mate-artifact-publish` is now `mate-publish-artifact`, and `mate-openspec-backfill` is now `mate-backfill-spec`. The old names are not kept as aliases; run `mate companion update` to deploy the new ones.
- `mate artifact link <change>` writes a change's `delivery.yaml`. It records the delivery branch (`--branch`, with `--direct` for a protected branch) or a not-applicable reason, plus an optional PR URL and the merge state (`--refresh` asks GitHub; `--confirm-merged`, `--confirm-open` and `--confirm-dropped` record your answer). Without an edit flag or `--refresh` it only reads the record. In another repository whose default branch GitHub cannot provide, `main` is taken as its default branch.
- `mate artifact archive <change>` archives before the merge. It warns about overlapping and unarchived dependent changes, always leaves a `delivery.yaml`, and runs `openspec archive`. `--repository <org/repo>` names the repository when the Working Repository's `origin` cannot be read. `mate-publish-artifact` holds an archive back until its delivery branch is merged, and `mate artifact publish` refuses one that is not.
- A protected branch (the default branch or a `protectedBranches` pattern of the openspec capability; Mate does not ask GitHub) is recorded only as an explicit direct delivery. `--direct` works on any branch: no PR is looked up, and only your confirmation settles it, since Git cannot tell its commits from your other pushes. The publish skill asks once per branch, for all direct deliveries on it.
- An archive without a `delivery.yaml` (made before delivery records) still publishes, with a warning that its merge was not checked. An archive sharing a canonical spec with a pending held-back archive is held back too. `mate artifact publish --all` skips held-back archives and publishes the rest.
- The forge token comes from `MATE_GIT_TOKEN`, else from the GitHub CLI's stored login. `GITHUB_TOKEN` and `GH_TOKEN` are ignored. The token needs read access to Pull requests and Metadata, and it is never printed or stored.
- Studio's Workflow view shows the Delivery Path for `mate-v1` and `mate-minimal`, including review stages for people with no skill and no prompt.

### Mate skills carry the OpenSpec workflows (breaking)

- **Removed:** the generated `openspec-*` skills and `/opsx:*` commands. Setup and `mate companion update` run `openspec init --tools none` and no `openspec update`, and `mate companion update` removes the earlier generated output, including the `.agents/skills/.openspec-target` marker, and the links to it in wrapped working repositories. Use `/mate-explore-change`, `/mate-propose-change`, `/mate-apply-change`, and `/mate-archive-change` instead.
- `mate-explore-change`, `mate-propose-change`, and `mate-apply-change` follow a `references/` copy of the OpenSpec workflow from the bundled version, with command references pointing at the Mate skills, instead of loading an OpenSpec skill.
- `mate-propose-change` gains a revise mode: for a change that already exists, it follows the OpenSpec update workflow, revises the planning artifacts and keeps them consistent, writing each edit after you confirm. In this mode it is not a Delivery Path stage.
- Setup no longer runs `openspec config reset`.

### Every companion plans with mate-v1 (breaking)

- With the `openspec` capability, setup always makes `mate-v1` the companion's OpenSpec schema: it writes `schema: mate-v1` into `openspec/config.yaml`, replacing a missing schema or the `spec-driven` that `openspec init` writes. Any other schema you set, such as `mate-minimal`, stays, and so does the rest of the file, including OpenSpec's comments.
- The setup wizard's OpenSpec schema step and the `--openspec-schema` flag are removed; a saved `schemaProfile` is ignored. Pick `mate-minimal` per change with `--schema mate-minimal`.

### `mate companion update` refreshes Claude links in Working Repositories

- After regenerating the companion, `mate companion update` re-links Claude skills and commands into every linked Working Repository wrapped for Claude, so new skills work and renamed ones stop dangling before the next launch. Each repository is reported as written, current, or failed; the links never join the companion commit.

### OpenSpec ships with Mate (breaking)

- Mate now depends on `@fission-ai/openspec` at one exact version (1.15.0) and runs that copy for every OpenSpec process it starts: setup, `mate companion update`, `mate cap openspec`, store registration, `mate artifact archive`, and the `openspec` wrapper. A new OpenSpec version arrives with a Mate release.
- Mate no longer installs, upgrades, or uses a global `openspec`: setup asks for no install, `mate companion update` no longer upgrades to `@latest`, and launches install nothing. A global install of another version is left untouched and no longer reached through the wrapper.
- `mate install` lists no OpenSpec requirement, and `mate doctor` reports the bundled CLI's path and version. When the bundled CLI is missing, setup fails and launches warn, both naming a reinstall of Mate.

### Companion instructions reach Claude sessions

- The companion `AGENTS.md` now reaches every Claude session in a Working Repository once. `mate claude`, plain `claude` sessions, Agent SDK sessions that load local settings (`settingSources` includes `local`), and linked worktrees that hold the repository's `.mate/` folder all get it from the wrap's `SessionStart` session-prepare hook once preparation finishes, so a conversation resumed through the other launcher holds one current copy; subagents get it from a `SubagentStart` hook, except Explore, Plan and forks. A companion-scoped launch loads the file natively, as before.
- The delivered text is the companion `AGENTS.md` without the `mate:managed` blocks other runtimes own, plus the Claude blocks from the companion `CLAUDE.md`, with `$MATE_REPO_PATH`, `$MATE_REPO_ID`, `$MATE_ARTIFACT_PATH` and `$MATE_WRAPPER_BIN_PATH` filled and block-level HTML comments removed the way Claude Code removes them. It is limited to 9,000 characters: a longer file keeps the `MATE:COMPANION` block whole and as many whole `##` sections as fit, and ends with a line naming the sections left out and the file's path. A `MATE:COMPANION` block that leaves no room for that line is still delivered whole, and the hooks ask you to shorten it.
- A missing companion `AGENTS.md` never blocks a session: the hooks state the fact in one line.
- Neither the wrap nor the launch sets `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` any more: Claude Code applies it only to `--add-dir` directories, so it never delivered the companion rules. A re-wrap removes the value an earlier wrap recorded, even if you had set the same value yourself, and keeps a value you set after it.
- `mate doctor` warns when the companion `CLAUDE.md` holds text besides `@AGENTS.md` and Mate-managed blocks, since that text reaches only sessions started in the companion.

### Capabilities can ship Claude plugins

- A Capability, built-in or dynamic, can declare Claude Code plugin folders as `pluginDirectories: [{ path }]` under its `claude` Runtime Contribution. `mate claude` passes each enabled folder as `--plugin-dir`, after Mate's own plugin.
- Plain `claude` sessions in a wrapped repository load these plugins too, as long as Claude Code trusts the folder. Each folder is published as its own local marketplace through `.claude-plugin/marketplace.json`. Mate reuses a marketplace file the plugin's author ships if it lists the plugin; context-mode ships one. Otherwise Mate writes its own, named `mate-plugin-<plugin>`, and removes it when the Capability is disabled. Mate never changes a marketplace file it did not write.
- The Claude wrap enables each published folder in `.claude/settings.local.json` (`extraKnownMarketplaces` and `enabledPlugins`), keeps entries you added there, and `mate unwrap` withdraws Mate's. In a wrapped repository, `mate claude` leaves those folders to the wrap, so each plugin loads once. In a linked worktree, when both checkouts enable a plugin from different marketplace sources, `mate claude` selects the worktree's folder; an explicit disable in the original checkout is respected.
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

- Search companion names and paths from either `@query` or `@mate:query`, with the same ranking and up to 15 matches. Bare `@` offers a companion gateway and top-level folders; a folder path ending in `/` browses its children. Selecting a companion result inserts its `@mate:` path. Git fallback walking is bounded by files and folders, and cannot apply gitignore rules.
- New optional package `@uniqbit/mate-plugin-companion-mentions`, published with Mate at the same version and installed separately (see its README). In a session started with `mate claude`, and in a plain `claude` session of a repository wrapped for Claude, Claude's `@` menu lists Companion Repository files as `@mate:<path>` rows, and a sent `@mate:<path>` mention attaches the file, line ranges included, or a list of a folder's entries. A session inside the companion gets no rows, since Claude already lists those files, but typed mentions still attach. It needs Claude Code 2.1.292 or later and is the first external user of Capability Claude plugin folders. It ships its own `.claude-plugin/marketplace.json`, so the wrap publishes it to plain sessions as `mate-companion-mentions@mate-companion-mentions` without writing into the installed package, and its manifest carries the release version.
- In a plain session the plugin asks Mate for the companion and the secret policy through the new `mate session context --repo <dir> --json`, run by Mate's runtime launcher. The command changes nothing and skips the runtime refresh, plugin loading and update checks. It reports a companion only when you registered it and it links the repository, so a projection file in a cloned repository is not enough; otherwise it names why (`not-wrapped`, `companion-missing`, `companion-not-registered`, `repository-not-linked`). The plugin's menu reuses an answer for up to 30 seconds, and each sent mention asks again, so a `secrets` change applies from the next mention. A session started with `mate claude` keeps using its launch environment and asks Mate nothing. The plugin runs the launcher from the launcher's own folder, never the repository, so a cloned repository's `bunfig.toml` cannot run code inside Mate's answer. The reply's `repositoryPath` is the checkout the link check validated, not the path the projection file claims, and an unreadable Mate configuration or companion registry answers `internal` instead of `companion-not-registered` or `repository-not-linked`; only a missing registry means not linked. `--repo` is read where the system reaches it, a link before `..` followed first, so `--repo forward/../acme-app` cannot answer for a folder beside `forward`. The plugin uses an answer only from a run that exits 0: a launcher that names a companion and then fails attaches a note pointing to `mate doctor`, as a launcher that takes longer than 5 seconds does.
- It keeps secret files out of its rows, mentions and folder lists with the companion's secret policy, checking both the path named and where a link leads, for each linked entry of a folder list too. A folder mention lists the folder its checks looked at, so a link repointed meanwhile cannot bring in another folder's entries. A `\` separates folders only under a Windows companion path; elsewhere it is part of a file name, as Mate reads it. `MATE_POLICY_JSON` now carries that policy as compiled rules (`secrets: { guardrails, deny, allow }`) beside `allowedAgents`, read when the session starts, in every runtime and in the projection fallback. Without it, as with an older Mate, the plugin offers no rows and attaches nothing.
- The release now has publish-only packages: the plugin is published after core and the CLI, at the same version, and is not pinned in the container image's locks. A stable release runs the plugin's tests before it starts, its Claude hook suites included: the new `test:hooks` script runs `claude plugin validate --strict` and `claude plugin test` with the Claude installed on the releasing machine. CI runs neither, since it has no Claude.

### Secret-file matching ignores letter case (breaking)

- Every guardrail layer that tests a path or a search glob now matches deny and allow patterns whatever their letter case, on every platform. `.ENV`, `ID_RSA` and `Prod.KEY` are secret files, and `.ENV.EXAMPLE` stays allowed. Before, `.ENV` passed every layer on macOS and Windows, where it names the same file as `.env`. A file that only its letter case kept clear of the deny patterns, such as a `Prod.KEY` holding no secret, is now refused: rename it so that no deny pattern matches. An allow pattern is no way out, since allow patterns ignore letter case too: allowing `Prod.KEY` also allows a secret `prod.key`.
- `**` in a pattern now also crosses folder names that hold a line break.
- Patterns now follow more of gitignore's syntax. A set (`secret[0-9].txt`, `key[!a-c].pem`, `[[:digit:]]`) matches one character, where before it matched nothing. A pattern ending in `/` (`private/`) covers that folder and everything in it, where before it matched nothing. `\` makes the next character plain. A pattern without a trailing slash still matches files only, and a leading `!` is still a plain character.
- A content search now also counts as aimed at secret files when its glob names one (`server.key`, `.env.local`, `**/.env.local`, `certs/*.key`, each `{a,b}` alternative on its own), not only when it matches one by pattern (`*.key`). `**/*`, `*.ts` and a `!` exclusion still pass.
- A `\` in a path separates folders only on Windows. Elsewhere it is part of the file name, as the system reads it: `public\server.key` is no longer covered by an allow pattern for `public/**`, and `notes\.env` is no longer taken for `notes/.env`.
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
- Launches still deploy Mate-owned skills and sync Mate schemas and the `config.yaml` rule.
- A runtime added by editing `framework.yaml` by hand gets its OpenSpec skills on the next `mate companion setup` or `mate companion update`.
- Every OpenSpec process Mate starts, including the `openspec` wrapper agents call, runs with `OPENSPEC_TELEMETRY=0` and `OPENSPEC_NO_UPDATE_CHECK=1`. OpenSpec's "update available" hint was wrong advice inside Mate, which decides the version.

### Delta specs pass `openspec validate --strict` on OpenSpec 1.14.2

- OpenSpec 1.14.2 reports any text above a delta spec's first `## ` section, which made every Mate change fail `openspec validate --strict`. Delta specs now carry their metadata (`change`, `capability`, and paired `scopes`) in a leading `<!-- mate:delta … -->` comment instead of YAML frontmatter, and the `mate-v1` instruction no longer asks for `← [[proposal]]` or `Applies to:` lines. The comment drops the delta `type` and `tags`.
- The `mate-v1` (version 10) and `mate-minimal` (version 4) delta templates, their `specs` instructions, `openspec/mate-conventions.yaml`, and Mate's `rules.specs` entry describe the comment. Existing companions pick them up on their next capability sync.
- `mate artifact publish` reads a delta's `scopes` from the comment, and still from frontmatter, so deltas in changes written before this release still publish. A `mate:delta` comment copied onto a main spec is replaced with canonical frontmatter, as a copied delta frontmatter block already was.

### A second Mate can leave `~/.mate/runtime/` alone

- With `MATE_SKIP_RUNTIME_REFRESH=1`, a Mate run does not re-point `~/.mate/runtime/`. A source checkout can then run next to the installed Mate without switching plain sessions and wrapped repositories over to itself. `mate wrap`, `mate opencode` and `mate session` refuse to run with it while that directory has no launcher.

### TokenSave indexing heals an empty store

- `mate cap index`, and the indexing step of managed launches, now runs `tokensave init` whenever the Working Repository has no `.tokensave/tokensave.db`. Before, an empty or half-created `.tokensave/` folder counted as initialized, so every launch ran `tokensave sync` and failed with "no TokenSave index found".

### OpenSpec names the Working Repository as an edit root

- Mate registers the Companion Repository as an OpenSpec store and projects a store pointer (`openspec/config.yaml`) into each wrapped Working Repository. The pointer's `openspec/` folder is hidden from Git through `.git/info/exclude` (`/openspec/`), since all planning, including archived changes and canonical specs, lives in the companion's store. An earlier `/openspec/config.yaml` line is replaced on the next refresh. Run from inside the repository, `openspec status` now reports `actionContext.allowedEditRoots` as `[<working repo>, <companion>]` instead of the companion alone, so apply flows no longer refuse product-code edits.
- Existing repositories heal on their next `mate claude`, `mate opencode`, `mate wrap`, or other Mate command that refreshes the projection.
- Wrap-only users who never launch through Mate run `mate wrap` once. Until then, the `openspec` wrapper prints a one-line hint on stderr and keeps working as before.
- `.openspec-store/` is added to the companion's managed `.gitignore`. It holds the machine-local store id.
- The pointer is never written when the Working Repository has its own OpenSpec root (`openspec/specs/`, `openspec/changes/`, or its own `openspec/config.yaml`), or when its `.gitignore` re-includes the `openspec/` folder. In each case `mate wrap` prints a warning.
- `mate wrap` and managed launches now print a warning for every projection entry that fails without failing the operation. Before, these failures were dropped silently.
