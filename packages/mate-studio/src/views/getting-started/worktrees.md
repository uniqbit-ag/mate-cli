## Work in an isolated checkout

A worktree is another checkout of the same Git repository. Use one to keep
a change's files separate while your original checkout stays available.
It is optional, not a prerequisite for Mate.

### Choose it during apply

Explore, propose, and review your change in the agent conversation first.
When apply asks where to implement, choose **Create a worktree**. Mate creates
or reuses the checkout and records its delivery branch.

The agent enters it when the runtime supports moving the session. Otherwise,
follow the reported path: open a new agent session there and resume apply.
Check the checkout and branch before implementation continues.

### Continue there

You can open another terminal in that worktree for tests, a development
server, or inspecting the diff. Set its working directory to the reported
checkout; opening a terminal elsewhere does not move the agent.

Product edits stay isolated. Plans, specs, and tasks remain in the shared
Companion Repository, so coordinate concurrent edits to those artifacts.
Review, deliver, merge, and archive through the normal workflow.

### Clean up safely

Publication attempts cleanup when the **Workset becomes Done**, not after
every individual publication. Dirty, locked, unpushed, or currently used
checkouts are kept. Cleanup does not delete the branch or close your terminals.
Read the reported cleanup result rather than assuming the checkout is gone.
