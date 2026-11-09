## Your first change

Your **Working Repository** holds product code. The **Companion Repository**
holds shared context, plans, specs, and tasks. Mate brings that context into
your agent session. Reading this guide runs nothing and writes no files.

### 1. Link your project

You need Git, Mate, an installed OpenCode or Claude Code, and a Companion
Repository with OpenSpec enabled. In your project checkout:

```sh
cd ~/src/acme
mate companion link
```

Choose your intended companion. Selecting it in Studio alone does not link
the checkout. If linking or launch fails, run `mate doctor` here and resolve
its diagnostics; ask your Companion Maintainer about missing capabilities.

### 2. Start an agent

From the same checkout, choose your installed runtime:

```sh
mate opencode
```

Or use `mate claude`. The session starts with your project's context and
skills. Check the reported Working Repository and Session Companion.

### 3. Plan, review, then apply

Skill examples belong in the **agent conversation, not your terminal**.
OpenCode uses `@name`; Claude Code uses `/name`.

- **Explore:** describe the problem with `@mate-explore-change acme-fix`.
  Agree on scope and direction before implementation.
- **Propose:** `@mate-propose-change acme-fix` writes the plan, specs, and
  tasks in the Companion Repository—not product code.
- **Review:** read those artifacts yourself. Request revisions if needed.
  Validation is evidence, not approval.
- **Apply:** only after review, request `@mate-apply-change acme-fix`.
  Confirm the delivery branch in this checkout. The agent implements the
  tasks and reports checks; resolve blockers or scope changes before resuming.

### 4. Review and deliver

Inspect the diff, run project checks, and review behavior. Explicitly authorize
commit, push, pull request, and merge through your team's normal process;
apply does not do these for you.

Then ask the agent to **archive** the change locally and **publish** its
companion artifacts for teammates. Archival, merge, and publication are
separate actions: publication requires archival and a merged delivery branch,
plus your confirmation of the companion commit, dated revert tag, and push.

Optional: [Worktrees](/docs/concepts/worktrees) for isolated checkouts;
[VS Code & Cursor](/docs/getting-started/vscode) for editor integration.
