---
name: mate-apply-change
description: Implement a change on a recorded delivery branch, offering workset/<workset-id> instead of a protected branch. Builds on the OpenSpec apply workflow. Use when the user wants to implement, apply, or continue implementing a reviewed change.
allowed-tools: Bash(mate:*), Bash(openspec:*), Bash(git:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

# Mate Apply Change

The Apply change stage of the Delivery Path. Before any code changes, it records the
Working Repository branch the change is delivered through, so archive and publication
later know which merge to wait for. Then it runs the OpenSpec apply workflow.

## Step 1: Read the branch and the record

In the Working Repository, read local Git state only:

```bash
git symbolic-ref --quiet --short HEAD          # current branch; fails when detached
git symbolic-ref --quiet --short refs/remotes/origin/HEAD   # default branch
```

Read the change's existing record without changing it:

```bash
mate artifact link "<change-name>" --json
```

## Step 2: Settle the delivery branch

Read `defaultBranch` and `diagnostics` from the link result. Report every diagnostic;
never derive a default from a change or Workset name. `defaultBranch: null` means ask
for a branch name, not infer one. Preserve recorded branches after membership changes;
a mismatch is informational, and relinking requires explicit user confirmation.

A branch is **protected** when it is the default branch or matches a configured
protected pattern; `mate artifact link` refuses a
protected branch unless it is recorded as a direct delivery.

- **A branch is already recorded** and it is the current branch → continue. When the
  current branch differs, warn, name both branches, and ask before implementing
  whether to switch to the recorded branch or record the current one.
- **On the safe `defaultBranch`** → record it without asking:
  `mate artifact link "<change-name>" --branch "<defaultBranch>" --json`.
- **On another unprotected branch** (a shared feature branch) → ask once whether this
  change is delivered through it, then record it on confirmation.
- **Detached HEAD** → ask for the branch name, then record it.
- **On a protected branch** → do not implement there by default. First name every
  local commit that is not on the remote (`git log --oneline HEAD --not --remotes`) and
  leave them where they are; never move, reset, or rebase them. Then offer:
  1. **Create or switch to `defaultBranch`** (default, normally `workset/<workset-id>`):
     check local and `origin` refs; `git switch "<defaultBranch>"` when local,
     `git switch --track -c "<defaultBranch>" "origin/<defaultBranch>"` when remote-only,
     otherwise `git switch -c "<defaultBranch>"`. Uncommitted edits carry over. Record it.
     When `defaultBranch` is null, ask for a name instead; do not offer an inferred branch.
  2. **Create a worktree** (only when `defaultBranch` is set): say uncommitted edits stay
     in this checkout, run `mate working worktree --change "<change-name>" --json`, record
     nothing, write no code, and stop. `## Next steps`: name each `repositories[].path`,
     open a new session in this repository's worktree, run `/mate-apply-change <change-name>`
     there. On failure, report its diagnostics and offer the other options again.
  3. **Use an existing branch**: switch to the branch the user names and record it.
  4. **Work directly here** — only when the user explicitly chooses it. Record it as a
     direct delivery: `mate artifact link "<change-name>" --branch "<branch>" --direct --json`.

Record the branch before writing any code. When `mate artifact link` refuses, report
its message and ask; never work around it.

When its result lists `warnings`, a `dependsOn` change is not implemented yet, so this
change would be built without the code it builds on. Report each warning and ask
whether to apply the dependency first or continue here. A dependency that is
implemented but unarchived is no such warning; it only affects archive order.

## Step 3: Apply

Read [references/openspec-apply-change.md](references/openspec-apply-change.md) and
follow it for the implementation. The PR need not exist yet; the branch is the delivery.
Retrieve its instructions the ordinary way. Only when the user explicitly asks for compact
apply, also read [references/mate-compact-apply.md](references/mate-compact-apply.md) and
use its transport.

## Step 4: Hand off

End the response with a final `## Next steps` section: numbered required actions in
execution order, with exact commands and known change names, prerequisites first.
Summaries, evidence, warnings, optional work, and deferred context go above it; nothing
follows it. Listing an action never invokes it.

**Skill invocation.** Skill invocations here use `/name`, the syntax of Claude Code
and Cursor and the fallback. When the current runtime uses another syntax, swap only
the prefix: `@name` in OpenCode, `$name` in Codex, `/skill:name` in Pi. Only the
user's statement or the harness's own identity sets the runtime, never a skill's
folder or an older example. Arguments, commands, paths, and order stay, and naming
never invokes.

- Above the section, label `/mate-show-me` and `/mate-simplify-code` as optional, in
  any order; they are not prerequisites for archive.
- In the section, list `/mate-archive-change <change-name>`, after any required work
  still open (a failing check, an unanswered question).
- Several changes on one branch: list their archives in dependency order, and say above
  the section that this order avoids an advisory archive warning; it is not a gate.

```text
Optional, any order: /mate-show-me acme-queue, /mate-simplify-code.

## Next steps
1. /mate-archive-change acme-queue
```

## Guardrails

- Never push, open a PR, or merge on the user's behalf.
- Never record a protected branch except as an explicit direct delivery.
- The forge token, when one is used by `mate artifact link`, is never printed or
  written; do not read or echo `MATE_GIT_TOKEN`.
