# Mate for VS Code and Cursor

A Mate sidebar for the Git repository open in the window:

- **Sessions**: start Claude or OpenCode sessions through Mate, park them (close the terminal), and resume them later.
- **Worktrees**: the repository's Git worktrees; Workset branches are marked.
- **Open changes**: active OpenSpec changes of the linked Companion Repository, with task progress.
- **Ready to publish**: archived changes `mate artifact pending` reports.

## Install

```sh
mate vscode setup
```

Installs the extension matching your Mate version into VS Code and Cursor. Run it again after `mate update`.

The npm package `@uniqbit/mate-vscode` only carries the VSIX for `mate vscode setup`; it is not meant to be installed directly.

## Develop

```sh
bun run --cwd apps/mate-vscode prepack   # builds mate-vscode.vsix
mate vscode setup --vsix apps/mate-vscode/mate-vscode.vsix
```
