---
name: mate-apply-change
description: Implement a change on a recorded delivery branch, offering change/<change-name> instead of a protected branch. Builds on the OpenSpec apply workflow. Use when the user wants to implement, apply, or continue implementing a reviewed change.
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

A branch is **protected** when it is the default branch or matches a configured
protected pattern; `mate artifact link` refuses a
protected branch unless it is recorded as a direct delivery.

- **A branch is already recorded** and it is the current branch → continue. When the
  current branch differs, warn, name both branches, and ask before implementing
  whether to switch to the recorded branch or record the current one.
- **On `change/<change-name>`** → record it without asking:
  `mate artifact link "<change-name>" --branch "change/<change-name>" --json`.
- **On another unprotected branch** (a shared feature branch) → ask once whether this
  change is delivered through it, then record it on confirmation.
- **Detached HEAD** → ask for the branch name, then record it.
- **On a protected branch** → do not implement there by default. First name every
  local commit that is not on the remote (`git log --oneline HEAD --not --remotes`) and
  leave them where they are; never move, reset, or rebase them. Then offer:
  1. **Create `change/<change-name>`** (default): `git switch -c change/<change-name>`;
     uncommitted edits carry over. Record it.
  2. **Use an existing branch**: switch to the branch the user names and record it.
  3. **Work directly here** — only when the user explicitly chooses it. Record it as a
     direct delivery: `mate artifact link "<change-name>" --branch "<branch>" --direct --json`.

Record the branch before writing any code. When `mate artifact link` refuses, report
its message and ask; never work around it.

When its result lists `warnings`, a `dependsOn` change is not implemented yet, so this
change would be built without the code it builds on. Report each warning and ask
whether to apply the dependency first or continue here.

## Step 3: Apply

Read [references/openspec-apply-change.md](references/openspec-apply-change.md) and
follow it for the implementation. The PR need not exist yet; the branch is the delivery.
After implementation, the optional peers `/mate-show-me` and `/mate-simplify-code` may
run in any order, then `/mate-archive-change`. Name them as next steps; do not invoke
them.

## Guardrails

- Never push, open a PR, or merge on the user's behalf.
- Never record a protected branch except as an explicit direct delivery.
- The forge token, when one is used by `mate artifact link`, is never printed or
  written; do not read or echo `MATE_GIT_TOKEN`.
