## VS Code & Cursor

The Mate sidebar puts agent sessions and change progress beside your code.
Editor integration is optional; the same workflow works in a terminal.

### Install the extension

With Mate and your Agent Runtime installed, enable your editor's CLI
(`code` or `cursor`) on PATH, then run in a terminal:

```sh
mate vscode setup
```

This installs the matching extension into detected editors. If no editor is
found, enable its CLI and retry.

### Open your workspace

Open your linked project folder, then the **Mate** sidebar. Choose
**Open workspace** when prompted. The managed workspace groups your Working
Repository and linked Companion Repositories; it does not create a worktree
or switch branches.

### Start or resume

Start Claude or OpenCode from the sidebar in the checkout you intend to edit.
Check its branch and change before asking for implementation.

Use **Sessions** to attach to a running session or resume a saved conversation.
Only sidebar-started sessions appear here; return to your runtime for sessions
started in another terminal. Opening a worktree window does not move a running
conversation.

### Follow progress

**Open changes** shows plans and task progress. **Worktrees** opens another
checkout in its own window. **Ready to publish** lists archived changes,
including those still waiting for merge—not proof of publication.
