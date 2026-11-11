# Mate for VS Code and Cursor

A Mate sidebar for the Git repository open in the window:

If the repository's Mate workspace is not open, the sidebar shows one **Open workspace** button instead of the sections below. Click it to create or update `.mate/<repo>.mate.code-workspace` and open it in the same window. Mate preserves existing workspace comments, folders, and settings. Merely opening the sidebar writes nothing; a missing repository link or invalid workspace produces an error you can fix and retry.

- **Sessions**: the Claude and OpenCode sessions started from this sidebar, for the repository and its worktrees. Sessions started in a terminal (`mate claude`, `claude`, `mate opencode`) are not listed, and Mate records nothing for them; the info button in the section's title says so. Grouped by Workset, then branch; Workset groups show their full branch name instead of a `Workset` label. Sessions parked for over 14 days move to _Older_, and sessions whose worktree is gone or whose branch is merged are hidden. Each shows its change, else its first prompt, whether it runs here, elsewhere, or is parked, and what a running one is doing (working, idle, waiting for you).
  - **Claude sessions run in the background** (`mate claude -- --bg`, Claude Code with `--bg`): a new or resumed session starts in Claude's background service and a terminal attaches to it (`claude attach`). Closing the terminal detaches; the agent keeps working. _Attach_ opens it again, from any window; _Stop_ ends it (`claude stop`) and keeps the conversation. When a session needs your input, a notification offers to attach it. A Claude session running in its own terminal, outside the background service, offers neither: switch to its terminal. Without `--bg` support, sessions run in the terminal and stop when it closes. **Sessions edit in place:** they launch with `--settings` setting `worktree.bgIsolation` to `none`, so they edit the checkout they start in, the main checkout included, like an interactive session. A `claude --bg` session started elsewhere keeps Claude Code's default, which keeps it out of the main checkout until it enters a worktree.
  - **OpenCode sessions run in the background** (`mate opencode -- --bg`, OpenCode 2.x): the terminal is a client of the repository's Mate OpenCode server, one `opencode serve` per repository and its worktrees. Closing the terminal detaches; the turn keeps running. _Attach_ and _Resume_ reconnect a terminal; _Stop_ interrupts the running turn (`mate session stop`). The server stops itself after an hour without a running turn; the conversation is kept, and the next session starts it again.
- **Worktrees**: the repository's Git worktrees; Workset branches are marked. A worktree's _New session_ button asks only for the Agent Runtime and starts the session in that worktree, as **New session** does.
- **Open changes**: active OpenSpec changes of the linked Companion Repository that still have unchecked tasks, grouped by Workset. Groups start collapsed and show combined completed/total task progress (for example, `5/12 tasks`) plus the Workset's session count; resume the latest session from the group. Expanding reveals each change's own progress, and refresh preserves your expansion state. Opening a change opens `proposal.md`, or `tasks.md` when there is no proposal, as with `mate-minimal` changes.
- **Ready to archive**: active changes whose tasks are all checked, with their Workset; opening one opens it as in Open changes. Archive with `/mate-archive-change`.
- **Ready to publish**: archived changes `mate artifact pending` reports.

## Refresh

Visible sections reload every 30 seconds while the window is focused, and when the window regains focus. Set `mate.autoRefreshInterval` to change the interval in seconds (values below 5 count as 5); `0` turns it off, and sections still reload on focus. **Refresh** reloads every section at once; a section also reloads when it becomes visible, and Sessions when a session is recorded.

Reloads read only local state, never the network. A delivery branch merged on the remote shows as waiting for merge until its merge is recorded locally, for example by `mate artifact link <change> --refresh`.

## Install

```sh
mate vscode setup
```

Installs the extension matching your Mate version into VS Code and Cursor. `mate update` updates an installed extension along with the CLI.

The button uses `mate companion open --no-open --json` to prepare the document without requiring an editor CLI on PATH, then opens it through the current editor. If the CLI is older than the extension, update Mate and run `mate vscode setup` again. Untitled or other workspace files do not count as the repository's managed workspace.

The npm package `@uniqbit/mate-vscode` only carries the VSIX for `mate vscode setup`; it is not meant to be installed directly.

## Develop

```sh
bun run --cwd apps/mate-vscode prepack   # builds mate-vscode.vsix
mate vscode setup --vsix apps/mate-vscode/mate-vscode.vsix
```
