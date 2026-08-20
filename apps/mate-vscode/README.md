# Mate Workspace Navigator

Discover your Mate repository pairings, open a paired workspace, and launch Mate-aware OpenCode/Claude terminals — without leaving VS Code.

## What it does

- **Workspaces / Companions views** (Activity Bar → Mate): every registered companion and linked working repository, grouped both ways — by working repository and by companion.
- **Health at a glance**: missing roots and ambiguous repository↔companion relationships are shown explicitly, never silently resolved.
- **Open Workspace**: materializes the selected pairing's `.mate/workspace.code-workspace` and opens it in a new window.
- **Reveal / Copy Path**: reveal either root in your OS file browser, or copy its absolute path.
- **Launch OpenCode / Launch Claude**: starts `mate opencode` or `mate claude` in an integrated terminal, pinned to the selected pairing via Mate's standard launch environment variables (`MATE_REPO_PATH`, `MATE_ARTIFACT_PATH`, `MATE_REPO_ID`).
- **Native Mate chat**: the `@mate` chat participant resolves a Session Envelope before applying companion guidance, asks for an explicit Repository Link on ambiguity, and keeps that link pinned for the conversation.
- **Claude Code chat context**: in trusted workspaces, Mate maintains `.claude/settings.local.json` hooks that inject the resolved Session Envelope into the Claude Code VS Code extension at session start and before each prompt.

## What it doesn't do

This is a read-mostly navigator. It never creates, links, unlinks, or repairs companions and repositories — that stays a Mate CLI responsibility (`mate companion link`, `mate companion setup`). Native Mate chat and Claude Code hooks use the read-only `mate workspace resolve --json` boundary; the Claude hook only persists its selected session variables through Claude Code's `CLAUDE_ENV_FILE`.

## Requirements

- The `mate` CLI must be installed and resolvable — either on the extension host's `PATH`, or via the `mate.executablePath` setting.
- Requires a Mate CLI version that provides `mate workspace list --json`, `mate workspace materialize --json`, and `mate workspace resolve --json`.

## Settings

| Setting               | Description                                                                      |
| --------------------- | -------------------------------------------------------------------------------- |
| `mate.executablePath` | Absolute path to the `mate` executable. Leave empty to resolve `mate` from PATH. |

## Workspace trust

Inventory and navigation (reveal, copy path) work in any window, trusted or not. Launching OpenCode or Claude in an integrated terminal requires a trusted workspace — VS Code's own trust prompt governs this, the extension never bypasses it.

## Getting started

1. Install and set up Mate (`mate companion link` from a working repository).
2. Install this extension.
3. Open the **Mate** view in the Activity Bar and refresh.
