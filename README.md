# Mate

Mate is a companion-first CLI for running coding agents against linked working
repositories. It keeps agent instructions, skills, specs, and capability output
in a companion repository while agents edit product code in a separate working
repository.

Mate is currently alpha.

## Quick Start

Install the published package with npm. The package bootstraps Bun when it is
not already available.

```sh
npm install -g @uniqbit/mate
```

Then run the default workflow from the repository you want an agent to edit:

```sh
mate install
mate companion link
mate sync
opencode   # or: claude
```

The first `mate install` verifies Mate's core requirements without requiring a
companion. `mate companion link` is interactive and must run in a TTY. It can
clone a Git companion, select an existing managed companion, or link a local
companion repository by pasted path. Linking installs the requirements selected
by that companion, registers the companion as trusted on this machine, and
registers Mate's global agent plugins — so no second `mate install` is needed.

After linking, start `claude` or `opencode` any way you like — terminal, VS
Code extension, or desktop app. Sessions activate themselves in linked
repositories; no Mate launcher is required.

## Repository Model

- **Companion repository**: Mate configuration, agent instructions, skills,
  specs, reports, and capability-managed artifacts.
- **Working repository**: Product source code and tests that the agent edits.
- **Repo-local link**: `./.mate/config/registry.yaml` records which companion
  belongs to a working repository. Mate keeps this directory out of Git's
  tracked files through `.git/info/exclude`.
- **Trust gate**: a repo-local link only activates when the companion is also
  registered in `~/.mate` — which only `mate companion link` writes. A `.mate`
  pointer committed to a cloned repository never activates on your machine.

Run `mate sync` from the working repository. Run setup commands from the
companion repository unless the command explicitly says otherwise.

## Installation State

After the package is installed or updated, run:

```sh
mate install
```

Without a linked companion, Mate installs and records only the core runtime
requirements. In a companion or linked context, it also installs the selected
package managers and capabilities. Already available requirements are skipped,
and unselected capabilities are not enabled. Use `mate install --yes` in
non-interactive environments.

Normal commands are blocked when installation state is missing or stale. These
recovery commands remain available:

```sh
mate install
mate doctor
mate companion setup
mate companion link
mate update
mate --help
mate --version
```

Run `mate install` again after changing companion selections or updating Mate.
Linking a different companion installs that companion's requirements as part of
the link flow.

## Commands

### Setup And Linking

```sh
mate companion setup
```

Initialize or reconfigure the current directory as a companion repository. The
interactive setup chooses allowed agents, package managers, capabilities,
OpenSpec schema, and Git mode. Explicit selections can be supplied with
`--allowed-agent`, `--package-manager`, `--capability`, `--openspec-schema`,
and `--git-mode`.

```sh
mate companion link
```

Run inside a working repository. Select an existing companion or clone one from
Git. GitHub URLs are attempted over SSH first and HTTPS second. The command
stores the link in the working repository's local `.mate` registry, installs
the companion's selected requirements, and may add both roots to the current VS
Code or Cursor workspace.

```sh
mate companion list [--json]
mate companion select <id>
mate companion open
mate companion tui
```

`list` shows linked repositories and emits JSON when `--json` is supplied or
stdout is not a TTY. `select` pins the per-user companion choice for a working
repository linked to multiple companions. `open` adds the active working
repository and companion to the preferred editor. `tui` opens an interactive
shell in the resolved companion directory and sets `MATE_ARTIFACT_PATH` for
that shell.

### Companion Hubs

```sh
mate hub init ./workspace
mate hub add <registered-companion-or-git-url>
mate hub sync
```

A hub is a local, non-Git Mate root containing materialized `type: companion`
children. Git-backed additions are fresh clones; registered companions without
a Git origin are copied as local-only children. `hub sync` is explicit,
updates only hub-declared plugins, fetches tracked remotes, and applies only
clean fast-forward updates. It never updates child plugin workspaces, pushes,
merges, resets, or discards child changes. Initialization, adding,
synchronization, and setup do not open an editor implicitly. Hub initialization
allows all built-in agents for hub-local MCP configuration, but does not create
agent guidance, `CLAUDE.md`, `AGENTS.md`, or the Mate OpenCode plugin, and never
sets up child companions.

### Health And Inspection

```sh
mate doctor
mate config [--vscode]
mate report [--days N] [--input FILE|-] [--json]
```

`doctor` reports whether the current directory is a linked working repository,
companion repository, or neither. It also shows the active companion, policy,
capabilities, and required tool installations.

`config` opens Mate's global configuration directory (`~/.mate`) in the OS file
manager. Use `--vscode` to open it in VS Code.

`report` aggregates configured usage and savings tools, adapts the result to a
versioned `ReportDocument`, renders a temporary HTML report, and opens it in the
default browser. Use `--input FILE` or `--input -` to submit an explicit JSON
`ReportDocument` from a file or stdin; `--days` cannot be combined with this
mode. Both paths accept `--json` for normalized machine-readable output and do
not create a file or open a browser. Browser reports include a `Print / Save as
PDF` control backed by the browser's native print dialog. If HTML creation or
browser launch fails, Mate warns on stderr and prints the complete report
document as JSON to stdout. Existing `REPORT.md` files are not modified.

### Synchronization

```sh
mate sync [--check] [--no-git]
```

`mate sync` is type-aware for the nearest Mate root. In a **working
repository** it pulls companion Git changes (when Git auto mode is enabled),
materializes the Claude session configuration into the per-user, gitignored
`.claude/settings.local.json` (companion marketplace + plugin registration,
the `MATE_*` environment contract, companion directory access, and MCP server
pre-approval), and refreshes enabled capability indexes. In a **companion** it
refreshes runtime assets and regenerates the plugin-marketplace scaffold that
exposes companion skills, commands, agents, hooks, and MCP servers through the
agent's native plugin discovery. In a **hub** it fans out over registered
members.

`--check` reports whether materialized configuration is stale without writing
and exits non-zero when it is. `--no-git` skips the companion Git pull.

Sync runs mostly automatically: session hooks probe freshness at start and
nudge you to run `mate sync` when the companion configuration changed.
MCP-level changes apply to the next session.

### Starting Agents

Start `claude` or `opencode` directly — from a terminal, the VS Code
extension, or the desktop app. In a linked working repository the globally
registered Mate plugins activate the session automatically: the companion
policy is injected as session context, companion skills and MCP servers load
through the generated companion plugin, and the `MATE_*` environment is
provided by the materialized settings.

When a repository is linked to multiple companions, the session asks which one
to use; pin the answer with:

```sh
mate companion select <id>
```

**Deprecated:** `mate claude` and `mate opencode` remain as thin shims that
run `mate sync` in the foreground and then start the plain agent binary. They
add nothing over starting the agent directly and will be removed in a later
major. Agent arguments still forward after `--`, and `-- --no-git` skips the
companion Git pull for that run.

**BREAKING:** the companion profile's `allowedAgents` policy is now advisory.
Since Mate no longer owns the agent spawn, a disallowed agent is not blocked
at launch; policy violations surface as in-session guidance instead.

### Capabilities

```sh
mate cap openspec <subcommand> [args...]
mate cap graphify <subcommand> [args...]
mate cap index [--graphify | --tokensave]
```

OpenSpec and Graphify commands run through the active Mate context. `cap index`
refreshes enabled Graphify and TokenSave indexes; without a flag it chooses the
enabled default, and the flags restrict the run to one indexer.

The available capabilities are OpenSpec, React Doctor, TokenSave, RTK,
Graphify, Context7, and Context Mode. RTK is independently selectable and
patches supported provider integrations. Providers are Claude and OpenCode.
Bun is always part of the core runtime; uv is selected for Python-backed
capability workflows.

Context Mode is opt-in and pins `context-mode@1.0.169` (Elastic License 2.0,
Node.js `>=22.5.0`). Mate installs its Claude plugin below the Companion's
`.mate/plugins/.local/` directory and activates it per launch; it does not
change Claude's global marketplace state. OpenCode receives the same exact
package pin after Mate's policy plugin. Mate does not add a separate
context-mode MCP entry.

Context Mode retains session and memory data in its provider defaults (normally
`~/.claude/context-mode/` for Claude and `~/.config/opencode/context-mode/` for
OpenCode). Disabling the capability removes only Mate-owned activation and
package files, not this potentially sensitive provider data. Remove those data
directories manually when their retained content is no longer needed. Upgrades
must update the single pin in `context-mode-package.ts`, confirm the package's
license, Node engine and plugin assets, then run the Claude/OpenCode composition
tests before release.

### Artifacts And Updates

```sh
mate artifact finish <change-name> [--type openspec] [--force] [--no-push] [--json]
mate update
mate update --check
```

`artifact finish` finalizes a change artifact workflow. `update` upgrades the
npm-managed Mate package and starts a fresh post-update install. Self-update is
supported only for npm global installations. `update --check` reports whether a
new version exists without installing it.
