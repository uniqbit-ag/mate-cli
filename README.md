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
mate opencode
```

The first `mate install` verifies Mate's core requirements without requiring a
companion. `mate companion link` is interactive and must run in a TTY. It can
clone a Git companion, select an existing managed companion, or link a local
companion repository by pasted path. Linking installs the requirements selected
by that companion, so no second `mate install` is needed before launch.

Use `mate claude` instead of `mate opencode` when the selected companion profile
allows Claude.

## Repository Model

- **Companion repository**: Mate configuration, agent instructions, skills,
  specs, reports, and capability-managed artifacts.
- **Working repository**: Product source code and tests that the agent edits.
- **Repo-local link**: `./.mate/config/registry.yaml` records which companion
  belongs to a working repository. Mate keeps this directory out of Git's
  tracked files through `.git/info/exclude`.

Run launch commands from the working repository. Run setup commands from the
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
mate companion open
mate companion tui
```

`list` shows linked repositories and emits JSON when `--json` is supplied or
stdout is not a TTY. `open` adds the active working repository and companion to
the preferred editor. `tui` opens an interactive shell in the resolved
companion directory and sets `MATE_ARTIFACT_PATH` for that shell.

### Health And Inspection

```sh
mate doctor
mate config [--vscode]
mate report [--days N] [--json]
```

`doctor` reports whether the current directory is a linked working repository,
companion repository, or neither. It also shows the active companion, policy,
capabilities, and required tool installations.

`config` opens Mate's global configuration directory (`~/.mate`) in the OS file
manager. Use `--vscode` to open it in VS Code.

`report` aggregates configured usage and savings tools. It writes `REPORT.md`
to the companion repository by default; `--json` prints machine-readable output
instead.

### Agent Launch

```sh
mate claude
mate opencode
```

Launch from a linked working repository. Mate resolves the companion, applies
the selected provider and capability configuration, refreshes enabled indexes,
and then starts the agent. The active profile must allow the selected agent.

Forward agent arguments after `--`:

```sh
mate claude -- --model sonnet
mate opencode -- --continue
```

If companion Git auto mode is enabled, skip its pre-launch synchronization for
one launch with:

```sh
mate claude -- --no-git
mate opencode -- --no-git
```

`--no-git` must appear after the argument separator.

### Capabilities

```sh
mate cap openspec <subcommand> [args...]
mate cap graphify <subcommand> [args...]
mate cap headroom [args...]
mate cap index [--graphify | --tokensave]
```

OpenSpec and Graphify commands run through the active Mate context. Headroom
requires the Headroom capability to be enabled. `cap index` refreshes enabled
Graphify and TokenSave indexes; without a flag it chooses the enabled default,
and the flags restrict the run to one indexer.

The available capabilities are OpenSpec, React Doctor, TokenSave, Headroom,
and Graphify. Providers are Claude and OpenCode. Bun is always part of the core
runtime; uv is selected for Python-backed capability workflows.

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