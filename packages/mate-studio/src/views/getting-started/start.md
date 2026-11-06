## Your first isolated change

Read this path, then run the commands yourself. Studio does not install,
launch, or remove anything when you open this guide.

### 1. Check your prerequisites

You need Git, Mate, an installed Agent Runtime (OpenCode or Claude Code),
and a Working Repository linked to a Companion Repository. From your product
checkout, for example `~/src/acme`, check the link:

```sh
mate doctor
```

If no Repository Link exists, run `mate companion link` in that checkout and
choose your companion, then rerun the health check. Resolve reported runtime
or link problems before continuing. Selecting a companion in Studio is not
the same as linking your local checkout.

### 2. Prepare your editor

From a terminal with your editor CLI on PATH:

```sh
mate vscode setup
```

Open your linked product checkout in VS Code or Cursor and click **Open
workspace** in the Mate sidebar. Expect the repository and companion folders
in one window, then Sessions, Worktrees, Open changes, and Ready to publish.
See [VS Code & Cursor](/docs/getting-started/vscode) if installation or the
workspace gate blocks you.

### 3. Plan and review before implementation

Use your runtime's Mate exploration and proposal skills to plan the change.
Review its proposal, specs, design, and tasks as required by its schema.
Skills are instructions to your agent, not shell commands. Validation is
evidence, not your approval.

The rest of this example assumes a reviewed change named `acme-fix`.

### 4. Give the change a worktree

Inside the agent conversation, invoke `mate-apply-change acme-fix` using
your runtime's skill syntax and choose a worktree when offered. The skill
creates or reuses the checkout, records delivery, and requests session entry.
Approve the move when prompted, or start a new session in the reported path.

To prepare just the checkout yourself, run this in the linked product checkout:

```sh
mate working worktree --change acme-fix
```

Expect a path and Delivery Branch for each affected repository. Creation alone
neither moves your shell nor records delivery. Resolve any install or wrap
failure and supply missing environment configuration manually. Follow
[Worktrees](/docs/concepts/worktrees#enter-and-start-a-session) for the entry
contract and safe recovery.

### 5. Start in the correct checkout

For a fresh terminal session, use the actual path reported by Mate:

```sh
cd ~/src/acme.worktrees/acme-fix
mate opencode
```

Or use `mate claude`. In the new conversation, invoke the apply skill for
`acme-fix` before implementing. Confirm the session's Working Repository
and branch; companion artifacts stay shared. You can also open this worktree
in another editor window and start its session from the Mate sidebar.

### 6. Finish work before cleanup

Review and verify the implementation, then follow the Delivery Path for
delivery and archival. Merge and publication are separate actions, not
effects of deleting a directory. Once the Workset is Done, stop using its
checkout and run cleanup from another linked checkout:

```sh
mate working worktree prune
```

Read the reported kept paths instead of forcing deletion. See
[safe cleanup](/docs/concepts/worktrees#clean-up-safely) for the eligibility
rules. The branch is not deleted by pruning.
