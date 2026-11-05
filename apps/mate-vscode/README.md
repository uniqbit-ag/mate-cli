# Mate for VS Code and Cursor

A Mate sidebar for the Git repository open in the window:

- **Sessions**: the Claude and OpenCode sessions started from this sidebar, for the repository and its worktrees. Sessions started in a terminal (`mate claude`, `claude`, `mate opencode`) are not listed, and Mate records nothing for them; the info button in the section's title says so. Grouped by Workset, then branch; sessions parked for over 14 days move to _Older_, and sessions whose worktree is gone or whose branch is merged are hidden. Each shows its change, else its first prompt, whether it runs here, elsewhere, or is parked, and what a running one is doing (working, idle, waiting for you).
  - **Claude sessions run in the background** (`mate claude -- --bg`, Claude Code with `--bg`): a new or resumed session starts in Claude's background service and a terminal attaches to it (`claude attach`). Closing the terminal detaches; the agent keeps working. _Attach_ opens it again, from any window; _Stop_ ends it (`claude stop`) and keeps the conversation. When a session needs your input, a notification offers to attach it. A Claude session running in its own terminal, outside the background service, offers neither: switch to its terminal. Without `--bg` support, sessions run in the terminal and stop when it closes.
  - **OpenCode sessions run in the background** (`mate opencode -- --bg`, OpenCode 2.x): the terminal is a client of the repository's Mate OpenCode server, one `opencode serve` per repository and its worktrees. Closing the terminal detaches; the turn keeps running. _Attach_ and _Resume_ reconnect a terminal; _Stop_ interrupts the running turn (`mate session stop`). The server stops itself after an hour without a running turn; the conversation is kept, and the next session starts it again.
- **Worktrees**: the repository's Git worktrees; Workset branches are marked.
- **Open changes**: active OpenSpec changes of the linked Companion Repository, grouped by Workset, with task progress and the Workset's sessions; resume the latest one from the group.
- **Ready to publish**: archived changes `mate artifact pending` reports.

## Install

```sh
mate vscode setup
```

Installs the extension matching your Mate version into VS Code and Cursor. `mate update` updates an installed extension along with the CLI.

The npm package `@uniqbit/mate-vscode` only carries the VSIX for `mate vscode setup`; it is not meant to be installed directly.

## Develop

```sh
bun run --cwd apps/mate-vscode prepack   # builds mate-vscode.vsix
mate vscode setup --vsix apps/mate-vscode/mate-vscode.vsix
```
